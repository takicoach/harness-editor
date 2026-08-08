import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CutRegion } from '../core/types';
import { buildLearningRecord } from '../core/cutLearning';
import type { CutLearningRecord, WordLabel } from '../core/cutLearning';
import { parseTelopData, parseSeData, parseVideoConfig, diffTelopData, diffSeData } from '../core';
import { loadProjectFromDir } from './loadProjectFiles';
import { readCutBaseline } from './cutBaseline';
import {
  parseTranscriptFixed,
  diffTranscriptFixed,
  distillWordRules,
  loadStore,
  saveStore,
  promoteWordRules,
  partitionByConflict,
  appendHistory,
  recordApprovedCutFeedback,
  loadCutRules,
  recordApprovedTelopFeedback,
  loadTelopRules,
  recordApprovedSeFeedback,
  loadSeRules,
  countUndistilledFeedback,
  type CutFeedbackEntry,
  type TelopFeedbackEntry,
  type SeFeedbackEntry,
} from '../learning';
import type { HistoryRecord, WordReplacement } from '../learning';
import type {
  LearningApproveRequest,
  LearningApproveResponse,
  LearningCutDiffItem,
  LearningDiffResponse,
  LearningSeDiffItem,
  LearningTelopDiffItem,
  LearningWordDiffItem,
} from '../shared/types';
import { HttpError } from './http';

/**
 * telopData.ts / seData.ts のプロジェクト内相対パス。
 * `src/server/loadProjectFiles.ts` の TELOP_DATA_REL / SE_DATA_REL、
 * `src/learning/learn.ts` の TRACKED_FILES と同じ値（学習層・サーバ層の独立を保つため意図的に複製）。
 */
const TELOP_DATA_REL = 'src/テロップテンプレート/telopData.ts';
const SE_DATA_REL = 'src/SoundEffects/seData.ts';

/** `<dir>/.learning/baseline/transcript_fixed.json` のパス。 */
function transcriptBaselinePath(dir: string): string {
  return join(dir, '.learning', 'baseline', 'transcript_fixed.json');
}

/** `<dir>/.learning/baseline/<rel>` のパス。 */
function baselinePathFor(dir: string, rel: string): string {
  return join(dir, '.learning', 'baseline', rel);
}

/** カット差分 1 区間ぶんの item を作る。区間内の word テキストを連結（空なら '(無音)'）。 */
function cutItemFor(
  region: CutRegion,
  kind: LearningCutDiffItem['kind'],
  words: WordLabel[],
  fps: number,
): LearningCutDiffItem {
  const text = words
    .filter((w) => w.startFrame >= region.start && w.endFrame <= region.end)
    .map((w) => w.text)
    .join('');
  return {
    kind,
    startFrame: region.start,
    endFrame: region.end,
    startSec: region.start / fps,
    endSec: region.end / fps,
    text: text === '' ? '(無音)' : text,
  };
}

/** GET /api/learning/diff: カット差分・文字起こし差分・未蒸留件数を返す。 */
export function handleLearningDiff(dir: string): LearningDiffResponse {
  // カット差分。ベースライン未取得ならスキップ（cut: null）。
  let cut: LearningCutDiffItem[] | null = null;
  const baseline = readCutBaseline(dir);
  if (baseline !== null) {
    const { project } = loadProjectFromDir(dir);
    const record: CutLearningRecord = buildLearningRecord({
      auto: baseline.autoCutRegions,
      final: project.cutRegions,
      transcript: project.transcript,
      video: {
        file: project.videoConfig.videoFile,
        fps: project.videoConfig.fps,
        durationFrames: project.videoConfig.durationFrames,
      },
      savedAt: new Date().toISOString(),
      transcriptDigest: baseline.transcriptDigest,
    });
    const fps = record.video.fps;
    cut = [
      ...record.delta.addedRegions.map((r) => cutItemFor(r, 'added-cut', record.words, fps)),
      ...record.delta.restoredRegions.map((r) => cutItemFor(r, 'restored-cut', record.words, fps)),
    ];
  }

  // 文字起こし差分。baseline と現在の transcript_fixed.json が両方あるときのみ。
  let words: LearningWordDiffItem[] | null = null;
  const basePath = transcriptBaselinePath(dir);
  const curPath = join(dir, 'transcript_fixed.json');
  if (existsSync(basePath) && existsSync(curPath)) {
    const rules = distillWordRules(
      diffTranscriptFixed(
        parseTranscriptFixed(readFileSync(basePath, 'utf8')),
        parseTranscriptFixed(readFileSync(curPath, 'utf8')),
      ),
    );
    words = rules.map((r) => ({ before: r.before, after: r.after }));
  }

  // テロップ差分。baseline と現在の telopData.ts が両方あるときのみ。テキストのみ（スタイル等は対象外）。
  let telops: LearningTelopDiffItem[] | null = null;
  const telopBasePath = baselinePathFor(dir, TELOP_DATA_REL);
  const telopCurPath = join(dir, TELOP_DATA_REL);
  const videoConfigPath = join(dir, 'src', 'videoConfig.ts');
  if (existsSync(telopBasePath) && existsSync(telopCurPath) && existsSync(videoConfigPath)) {
    const videoConfig = parseVideoConfig(readFileSync(videoConfigPath, 'utf8'));
    const baselineTelops = parseTelopData(readFileSync(telopBasePath, 'utf8'), videoConfig.fps, videoConfig.durationFrames);
    const currentTelops = parseTelopData(readFileSync(telopCurPath, 'utf8'), videoConfig.fps, videoConfig.durationFrames);
    const fps = videoConfig.fps;
    telops = diffTelopData(baselineTelops, currentTelops).map((item) => ({
      ...item,
      startSec: item.startFrame / fps,
      endSec: item.endFrame / fps,
    }));
  }

  // SE 差分。baseline と現在の seData.ts が両方あるときのみ。近傍テロップは現在のテロップから拾う。
  let ses: LearningSeDiffItem[] | null = null;
  const seBasePath = baselinePathFor(dir, SE_DATA_REL);
  const seCurPath = join(dir, SE_DATA_REL);
  if (existsSync(seBasePath) && existsSync(seCurPath) && existsSync(videoConfigPath)) {
    const videoConfig = parseVideoConfig(readFileSync(videoConfigPath, 'utf8'));
    const baselineSe = parseSeData(readFileSync(seBasePath, 'utf8'));
    const currentSe = parseSeData(readFileSync(seCurPath, 'utf8'));
    const currentTelops = existsSync(telopCurPath)
      ? parseTelopData(readFileSync(telopCurPath, 'utf8'), videoConfig.fps, videoConfig.durationFrames)
      : [];
    const fps = videoConfig.fps;
    ses = diffSeData(baselineSe, currentSe, currentTelops).map((item) => ({
      ...item,
      startSec: item.startFrame / fps,
    }));
  }

  return { cut, words, telops, ses, undistilledCount: countUndistilledFeedback() };
}

/** POST /api/learning/approve: 承認済み差分を確定し、昇格・競合の件数を返す。 */
export function handleLearningApprove(
  dir: string,
  body: LearningApproveRequest,
): LearningApproveResponse {
  const videoId = basename(dir);

  // カット: CutFeedbackEntry へ変換して記録。
  // 件数は累積でなく「このリクエストで新たに昇格/競合した差分」を返す（words 側と対称）。
  let cutRulesPromoted = 0;
  let cutConflicts = 0;
  if (body.cut.length > 0) {
    const before = loadCutRules();
    const now = new Date().toISOString();
    const entries: CutFeedbackEntry[] = body.cut.map((c) => ({
      videoId,
      timestamp: now,
      kind: c.kind,
      startFrame: c.startFrame,
      endFrame: c.endFrame,
      text: c.text,
    }));
    const updated = recordApprovedCutFeedback(entries);
    cutRulesPromoted = Math.max(0, updated.rules.length - before.rules.length);
    cutConflicts = Math.max(0, updated.conflicts.length - before.conflicts.length);
  }

  // 語句: 承認済みサブセットで learnFinish 相当を組む（learnFinish は全承認前提なので使わない）。
  const rules: WordReplacement[] = body.words.map((w) => ({ before: w.before, after: w.after }));
  const { promotable, conflicts } = partitionByConflict(loadStore(), rules);
  if (promotable.length > 0) {
    saveStore(promoteWordRules(loadStore(), promotable, videoId));
  }
  if (rules.length > 0) {
    const record: HistoryRecord = {
      videoId,
      timestamp: new Date().toISOString(),
      diffs: [{ stage: 'transcript-fix', wordReplacements: rules }],
    };
    appendHistory(dir, record);
  }

  // テロップ: TelopFeedbackEntry へ変換して記録（cut と対称の差分件数モデル）。
  let telopRulesPromoted = 0;
  let telopConflicts = 0;
  const telops = body.telops ?? [];
  if (telops.length > 0) {
    const before = loadTelopRules();
    const now = new Date().toISOString();
    const entries: TelopFeedbackEntry[] = telops.map((t) => ({
      videoId,
      timestamp: now,
      kind: t.kind,
      before: t.before,
      after: t.after,
    }));
    const updated = recordApprovedTelopFeedback(entries);
    telopRulesPromoted = Math.max(0, updated.rules.length - before.rules.length);
    telopConflicts = Math.max(0, updated.conflicts.length - before.conflicts.length);
  }

  // SE: SeFeedbackEntry へ変換して記録。
  let seRulesPromoted = 0;
  let seConflicts = 0;
  const ses = body.ses ?? [];
  if (ses.length > 0) {
    const before = loadSeRules();
    const now = new Date().toISOString();
    const entries: SeFeedbackEntry[] = ses.map((s) => ({
      videoId,
      timestamp: now,
      kind: s.kind,
      seFile: s.file,
      contextText: s.nearbyText,
    }));
    const updated = recordApprovedSeFeedback(entries);
    seRulesPromoted = Math.max(0, updated.rules.length - before.rules.length);
    seConflicts = Math.max(0, updated.conflicts.length - before.conflicts.length);
  }

  return {
    cutRulesPromoted,
    cutConflicts,
    wordsPromoted: promotable.length,
    wordConflicts: conflicts.length,
    telopRulesPromoted,
    telopConflicts,
    seRulesPromoted,
    seConflicts,
    undistilledCount: countUndistilledFeedback(),
  };
}

/** POST /api/learning/approve のボディを検証する。 */
export function validateApproveRequest(body: unknown): LearningApproveRequest {
  if (typeof body !== 'object' || body === null) {
    throw new HttpError(400, 'リクエストボディがオブジェクトではありません');
  }
  const b = body as Record<string, unknown>;
  if (typeof b['projectId'] !== 'string' || b['projectId'] === '') {
    throw new HttpError(400, 'projectId が必要です');
  }
  if (!Array.isArray(b['cut']) || !Array.isArray(b['words'])) {
    throw new HttpError(400, 'cut / words は配列である必要があります');
  }
  if (b['telops'] !== undefined && !Array.isArray(b['telops'])) {
    throw new HttpError(400, 'telops は配列である必要があります');
  }
  if (b['ses'] !== undefined && !Array.isArray(b['ses'])) {
    throw new HttpError(400, 'ses は配列である必要があります');
  }
  return b as unknown as LearningApproveRequest;
}

/** GET /api/learning/status: 未蒸留件数を返す。 */
export function handleLearningStatus(): { undistilledCount: number } {
  return { undistilledCount: countUndistilledFeedback() };
}
