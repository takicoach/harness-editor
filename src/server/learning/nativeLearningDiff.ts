/**
 * 新形式（取り込み案件）の書き出し後の学習差分。
 *
 * 比較元 = 取り込み時点で凍結された旧形式ファイル（取り込み処理と同じ loadProject(readProjectFiles(dir))）。
 *   loadProjectFromDir は基準ファイル（.learning/baseline・cut-baseline.json）を作る副作用があるので使わない。
 * 仕上げ = 完了した書き出しジョブの文書（readExportInput）。現在の文書では代用しない。
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadProject } from '../../core/project';
import type { SequenceDocument } from '../../core/sequence/model';
import { timeNumber } from '../../core/sequence/time';
import { countUndistilledFeedback } from '../../learning';
import type { LearningCandidateKey, LearningDiffResponse } from '../../shared/types';
import { HttpError } from '../http';
import { readProjectFiles } from '../loadProjectFiles';
import { legacyInputFingerprint } from '../sequence/migration';
import { readExportInput, readExportRecord } from '../sequence/exportRecords';
import { diffNativeCuts, diffNativeSes, diffNativeTelops } from './nativeLearningRules';

/** パネルの「比較元: …」に出す文。 */
export const NATIVE_BASELINE_LABEL = '新エディターへ取り込んだ時点の内容';
const TELOP_DATA_REL = 'src/テロップテンプレート/telopData.ts';

/** 新形式の案件か（.harness/project.v2.json があれば新形式が正本）。 */
export function hasNativeDocument(dir: string): boolean {
  return existsSync(join(dir, '.harness', 'project.v2.json'));
}

export type NativeLearningDiff =
  | { eligible: false; reason: string; response: LearningDiffResponse }
  | { eligible: true; response: LearningDiffResponse & { candidateKey: LearningCandidateKey }; finish: SequenceDocument };

function ineligible(reason: string): NativeLearningDiff {
  return { eligible: false, reason, response: { cut: null, words: null, telops: null, ses: null, undistilledCount: countUndistilledFeedback(), unavailableReason: reason } };
}

interface OperationLike { phase?: unknown; request?: { projectId?: unknown; sequence?: { documentId?: unknown } | null } | null }
const isOperationLike = (value: unknown): value is OperationLike => typeof value === 'object' && value !== null;

/**
 * 取り込み後に入った AI の編集の回数（harvest_v2 と同じ数え方）。
 * - .harness/external-edits/*.json（baseline.json を除く）の kind:'ai'（status は見ない）
 * - 案件置き場の .sme-editor-operations.json の phase:'saved' で、この文書（旧形式なら videoId）への操作
 */
export function countAiEditsAfterImport(projectDir: string, documentId: string): number {
  let count = 0;
  const folder = join(projectDir, '.harness', 'external-edits');
  if (existsSync(folder)) {
    for (const name of readdirSync(folder)) {
      if (!name.endsWith('.json') || name === 'baseline.json') continue;
      try {
        if ((JSON.parse(readFileSync(join(folder, name), 'utf8')) as { kind?: unknown }).kind === 'ai') count++;
      } catch { /* 読めない記録は数えない（harvest_v2 と同じ） */ }
    }
  }
  const ledger = join(dirname(projectDir), '.sme-editor-operations.json');
  if (existsSync(ledger)) {
    try {
      const operations = (JSON.parse(readFileSync(ledger, 'utf8')) as { operations?: unknown }).operations;
      const list: unknown[] = Array.isArray(operations) ? operations : Object.values(operations ?? {});
      const videoId = basename(projectDir);
      // harvest_v2 と同じく真偽で判定する（request:null の1行で台帳全体が数えられなくなるのを防ぐ）。
      count += list.filter((op) => isOperationLike(op) && op.phase === 'saved' && op.request
        && (op.request.sequence?.documentId === documentId || (!op.request.sequence && op.request.projectId === videoId))).length;
    } catch { /* 読めなければ数えない（harvest_v2 と同じ） */ }
  }
  return count;
}

/**
 * 完了した書き出しジョブ jobId について、比較元と仕上げの差分を返す。
 * - 対象外（新エディターで作った案件・旧ファイルが無い・取り込み後に旧ファイルが変わった）は eligible:false（全カテゴリ null）
 * - 書き出しの記録が無い・読めないときは例外（404/400 は HttpError、改ざん等は Error）。完了していなければ 409
 */
export async function computeNativeLearningDiff(dir: string, jobId: string): Promise<NativeLearningDiff> {
  const root = realpathSync(dir);
  const record = readExportRecord(root, jobId);
  if (record.status.phase !== 'complete') throw new HttpError(409, '書き出しが完了していないため、学習候補を作れません');
  // version 3 は旧形式のまま書き出した記録（legacy-snapshot）。文書は旧ファイルを変換しただけで、人の仕上げではない。
  if (record.version === 3) return ineligible('旧形式のまま書き出したジョブには新エディターでの仕上げがありません');
  const finish = readExportInput(root, record);
  if (!finish.legacy) return ineligible('新エディターで作った案件には比較元がありません');
  if (!existsSync(join(root, TELOP_DATA_REL))) return ineligible('取り込み元の旧形式ファイルがありません');
  if (await legacyInputFingerprint(root) !== finish.legacy.sourceFingerprint) {
    return ineligible('取り込み後に旧形式ファイルが変更されています');
  }
  const project = loadProject(readProjectFiles(root));
  const legacyFps = project.videoConfig.fps, finishFps = timeNumber(finish.fps);
  const archivedClips = (finish.cutArchive?.entries ?? []).flatMap((entry) => entry.clips);
  return {
    eligible: true,
    finish,
    response: {
      cut: diffNativeCuts({ legacyCutRegions: project.cutRegions, durationFrames: project.videoConfig.durationFrames, fps: legacyFps,
        clips: finish.clips, primaryAssetId: finish.legacy.primaryAssetId, words: project.transcript.words }),
      words: null,
      telops: diffNativeTelops({ legacyTelops: project.telops, clips: finish.clips, archivedClips, legacyFps, finishFps }),
      ses: diffNativeSes({ legacySe: project.se, legacyTelops: project.telops, clips: finish.clips, archivedClips, assets: finish.assets, legacyFps, finishFps }),
      undistilledCount: countUndistilledFeedback(),
      aiEditCount: countAiEditsAfterImport(root, finish.id),
      baselineLabel: NATIVE_BASELINE_LABEL,
      candidateKey: { jobId, documentId: finish.id, contentHash: record.status.contentHash },
    },
  };
}
