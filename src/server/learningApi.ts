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
  countJsonlLines,
  type CutFeedbackEntry,
  type CutRule,
  type TelopFeedbackEntry,
  type TelopRule,
  type SeFeedbackEntry,
  type SeRule,
} from '../learning';
import type { HistoryRecord, WordReplacement } from '../learning';
import type {
  LearningApproveRequest,
  LearningApproveResponse,
  LearningCutDiffItem,
  LearningDiffResponse,
  LearningPromotedRule,
  LearningSeDiffItem,
  LearningTelopDiffItem,
  LearningWordDiffItem,
} from '../shared/types';
import { HttpError } from './http';
import { cutFeedbackPath, globalStoreDir, seFeedbackPath, telopFeedbackPath, withLearningHome } from '../learning/paths';
import { computeNativeLearningDiff, hasNativeDocument } from './learning/nativeLearningDiff';
import { countApprovedByKind, recordEditorPanelHarvest, uniqueApproved } from './learning/harvestLedger';
import { cutCandidateKey, seCandidateKey, SILENT_CUT_TEXT, telopCandidateKey } from './learning/nativeLearningRules';

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

/** カット差分 1 区間ぶんの item を作る。区間内の word テキストを連結（空なら SILENT_CUT_TEXT）。 */
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
    text: text === '' ? SILENT_CUT_TEXT : text,
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

/**
 * 集合差キーの区切り文字。ルール本文（テロップ文・SE 文脈）に現れ得ない制御文字を使う
 * （半角スペースだと「A B」+「C」と「A」+「B C」が同じキーへ潰れて取り違える）。
 * ソースに生の制御文字を書くと git がバイナリ判定するためエスケープで書く。
 */
const KEY_SEP = '\u0000';

/**
 * 「今回新しく増えたルール」だけを取り出す（キー一致で既存とみなす）。
 * 件数の差分（rules.length の増減）と違い、競合で既存ルールが外れた場合でも
 * 新規に増えたものだけを正しく拾える。
 */
function addedRules<T>(before: T[], after: T[], key: (rule: T) => string): T[] {
  const known = new Set(before.map(key));
  return after.filter((rule) => !known.has(key(rule)));
}

/** カットルール 1 件の人間向け表示テキスト。 */
function cutRuleText(rule: CutRule): string {
  return rule.action === 'cut' ? `「${rule.text}」は自動でカットします` : `「${rule.text}」はカットせずに残します`;
}

/** 語句ルール / テロップルール 1 件の人間向け表示テキスト（どちらも before→after の置換）。 */
function replaceRuleText(before: string, after: string): string {
  return `「${before}」を「${after}」に直します`;
}

/** SE ルール 1 件の人間向け表示テキスト。近傍テロップ（文脈）が空なら文脈を省く。 */
function seRuleText(rule: SeRule): string {
  if (rule.action === 'add') {
    return rule.contextText === ''
      ? `${rule.seFile} を入れます`
      : `「${rule.contextText}」の近くに ${rule.seFile} を入れます`;
  }
  return rule.contextText === ''
    ? `${rule.seFile} は入れません`
    : `「${rule.contextText}」の近くでは ${rule.seFile} を入れません`;
}

/** POST /api/learning/approve: 承認済み差分を確定し、昇格・競合の件数を返す。 */
export function handleLearningApprove(
  dir: string,
  body: LearningApproveRequest,
): LearningApproveResponse {
  const videoId = basename(dir);
  /** 今回新しく自動ルールになった内容（カテゴリ順に積む）。 */
  const promotedRules: LearningPromotedRule[] = [];

  // カット: CutFeedbackEntry へ変換して記録。
  // 件数は累積でなく「このリクエストで新たに昇格/競合した差分」を返す（words 側と対称）。
  let cutRulesPromoted = 0;
  let cutConflicts = 0;
  // 無音区間は学習キーとして意味を持たないので記録しない（記録件数もこの除外後で数える）。
  const cutItems = body.cut.filter((c) => c.text !== SILENT_CUT_TEXT);
  // 件数は「jsonl に新しく増えた行数」で数える（ストアの重複照合で弾かれた分は含めない。設計書 D9）。
  const cutLinesBefore = countJsonlLines(cutFeedbackPath());
  if (cutItems.length > 0) {
    const before = loadCutRules();
    const now = new Date().toISOString();
    const entries: CutFeedbackEntry[] = cutItems.map((c) => ({
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
    for (const rule of addedRules(before.rules, updated.rules, (r) => `${r.action}${KEY_SEP}${r.text}`)) {
      promotedRules.push({ category: 'cut', text: cutRuleText(rule) });
    }
  }

  // 語句: 承認済みサブセットで learnFinish 相当を組む（learnFinish は全承認前提なので使わない）。
  const rules: WordReplacement[] = body.words.map((w) => ({ before: w.before, after: w.after }));
  const storeBefore = loadStore();
  const { promotable, conflicts } = partitionByConflict(storeBefore, rules);
  // 既に同じ before が辞書にあるものは「今回から自動ルールになった」ではないので表示しない
  // （promotable には再観測も含まれる＝wordsPromoted 件数とは一致しないことがある）。
  for (const rule of promotable.filter((r) => storeBefore.typoDict.replace[r.before] === undefined)) {
    promotedRules.push({ category: 'word', text: replaceRuleText(rule.before, rule.after) });
  }
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
  const telopLinesBefore = countJsonlLines(telopFeedbackPath());
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
    for (const rule of addedRules(before.rules, updated.rules, (r: TelopRule) => `${r.before}${KEY_SEP}${r.after}`)) {
      promotedRules.push({ category: 'telop', text: replaceRuleText(rule.before, rule.after) });
    }
  }

  // SE: SeFeedbackEntry へ変換して記録。
  let seRulesPromoted = 0;
  let seConflicts = 0;
  const ses = body.ses ?? [];
  const seLinesBefore = countJsonlLines(seFeedbackPath());
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
    for (const rule of addedRules(before.rules, updated.rules, (r) => `${r.action}${KEY_SEP}${r.seFile}${KEY_SEP}${r.contextText}`)) {
      promotedRules.push({ category: 'se', text: seRuleText(rule) });
    }
  }

  // 行数の差は 0〜送った件数に収める（外から同じ jsonl が書き換えられても、記録済みの件数が負や送った件数超えにならない）。
  const newLines = (sent: number, path: string, before: number) =>
    Math.min(sent, Math.max(0, countJsonlLines(path) - before));
  const recorded = {
    cut: newLines(cutItems.length, cutFeedbackPath(), cutLinesBefore),
    // 語句は jsonl を持たない。辞書に入った件数（競合でスキップした分を除く）。
    words: promotable.length,
    telops: newLines(telops.length, telopFeedbackPath(), telopLinesBefore),
    ses: newLines(ses.length, seFeedbackPath(), seLinesBefore),
  };

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
    recorded,
    alreadyRecorded: (cutItems.length - recorded.cut) + (telops.length - recorded.telops) + (ses.length - recorded.ses),
    promotedRules,
  };
}

/** 承認された項目が1件も無いときの応答（何も書かない。設計書 D11「0件の承認は今回は学習しないと同じ」）。 */
function emptyApproveResponse(): LearningApproveResponse {
  return {
    cutRulesPromoted: 0, cutConflicts: 0, wordsPromoted: 0, wordConflicts: 0,
    telopRulesPromoted: 0, telopConflicts: 0, seRulesPromoted: 0, seConflicts: 0,
    undistilledCount: countUndistilledFeedback(),
    recorded: { cut: 0, words: 0, telops: 0, ses: 0 },
    alreadyRecorded: 0,
    promotedRules: [],
  };
}

/** 送られた各項目がサーバーで再計算した候補に含まれるか（1件でも外れていれば全体を拒否。設計書 D2）。 */
function assertApprovedCandidates(body: LearningApproveRequest, diff: LearningDiffResponse): void {
  if (body.words.length > 0) throw new HttpError(400, 'この案件では文字起こし修正を学習できません');
  const cut = new Set((diff.cut ?? []).map(cutCandidateKey));
  const telops = new Set((diff.telops ?? []).map(telopCandidateKey));
  const ses = new Set((diff.ses ?? []).map(seCandidateKey));
  if (body.cut.some((c) => !cut.has(cutCandidateKey(c))) || (body.telops ?? []).some((t) => !telops.has(telopCandidateKey(t)))
    || (body.ses ?? []).some((s) => !ses.has(seCandidateKey(s)))) {
    throw new HttpError(400, '書き出しの差分に含まれない項目があるため、学習しませんでした');
  }
}

/**
 * POST /api/learning/approve の本体。呼び出し側（plugin.ts）が runLearningApprove の列で1件ずつ実行する。
 * - 旧形式の案件: 従来どおり handleLearningApprove（互換）
 * - 新形式の案件: jobId・documentId・contentHash を必須にし、同じジョブの差分を再計算して照合してから記録し、
 *   1件以上承認したら harvest_v2 の取り出し済み台帳へ書く（D2・D11）
 * どちらも学習フォルダは開始時に1回決め、記録・昇格・台帳で同じ場所を使う（D12）。
 */
export async function approveLearning(dir: string, body: LearningApproveRequest): Promise<LearningApproveResponse> {
  const learnDir = globalStoreDir();
  if (!hasNativeDocument(dir)) return withLearningHome(learnDir, () => handleLearningApprove(dir, body));
  const { jobId, documentId, contentHash } = body;
  if (!jobId || !documentId || !contentHash) throw new HttpError(400, '新形式の案件の学習には jobId・documentId・contentHash が必要です');
  const computed = await computeNativeLearningDiff(dir, jobId);
  if (!computed.eligible) throw new HttpError(409, `この書き出しは学習の対象外です: ${computed.reason}`);
  const key = computed.response.candidateKey;
  if (key.documentId !== documentId || key.contentHash !== contentHash) throw new HttpError(400, '承認内容が書き出しの記録と一致しません');
  assertApprovedCandidates(body, computed.response);
  // 同じ要求の中の重複は1件として扱う（記録済みの件数・台帳の counts を膨らませない）。
  const approved = uniqueApproved(body);
  if (approved.cut.length + approved.telops.length + approved.ses.length === 0) return emptyApproveResponse();
  return withLearningHome(learnDir, () => {
    const response = handleLearningApprove(dir, approved);
    // 学習の記録（新しく記録した行・記録済みで弾かれた行）が1件も無い承認（無音カットだけ等）は、
    // 「今回は学習しない」と同じ扱いにして台帳に書かない（設計書 D11）。
    const learned = (response.recorded?.cut ?? 0) + (response.recorded?.telops ?? 0) + (response.recorded?.ses ?? 0)
      + (response.alreadyRecorded ?? 0);
    if (learned === 0) return response;
    try {
      recordEditorPanelHarvest(learnDir, documentId, {
        videoId: basename(dir), projectDir: dir, harvestedAt: new Date().toISOString(),
        documentRevision: computed.finish.revision, counts: countApprovedByKind(approved), source: 'editor-panel',
      });
      return response;
    } catch (error) {
      return { ...response, ledgerError: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** 承認項目の文字列の上限（字幕1枚・語1つには十分長く、巨大な値で学習フォルダを膨らませない）。 */
const MAX_ITEM_TEXT_LENGTH = 2000;
/**
 * カットの本文（区間に完全に含まれる語をつないだもの）の上限。区間の長さに比例して伸び、日本語の話し言葉では
 * 5〜6 分で 2000 字を超える。正当な長いカット1件で承認全体を 400 にしないよう、ここだけ大きく取る
 * （本文全体の大きさは readBody の上限で別に抑えている）。
 */
const MAX_CUT_TEXT_LENGTH = 100_000;

/** 各項目の許容する種類と、文字列・数の欄（新形式は候補照合でも守られるが、旧形式の経路はここだけが守る）。 */
const APPROVE_ITEM_SHAPES = {
  cut: { kinds: ['added-cut', 'restored-cut'], strings: ['text'], numbers: ['startFrame', 'endFrame', 'startSec', 'endSec'] },
  words: { kinds: null, strings: ['before', 'after'], numbers: [] },
  telops: { kinds: ['changed', 'added', 'removed'], strings: ['before', 'after'], numbers: ['startFrame', 'endFrame', 'startSec', 'endSec'] },
  ses: { kinds: ['added', 'removed'], strings: ['file', 'nearbyText'], numbers: ['startFrame', 'startSec'] },
} as const;

/** 配列の各要素の型を確かめる。1件でも外れたら 400（何も書かない）。 */
function validateApproveItems(category: keyof typeof APPROVE_ITEM_SHAPES, items: unknown[]): void {
  const shape = APPROVE_ITEM_SHAPES[category];
  items.forEach((item, index) => {
    const where = `${category}[${index}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new HttpError(400, `${where} はオブジェクトである必要があります`);
    const fields = item as Record<string, unknown>;
    if (shape.kinds !== null && !(shape.kinds as readonly unknown[]).includes(fields['kind'])) {
      throw new HttpError(400, `${where}.kind は ${shape.kinds.join(' / ')} のいずれかである必要があります`);
    }
    for (const key of shape.strings) {
      const value = fields[key];
      if (typeof value !== 'string') throw new HttpError(400, `${where}.${key} は文字列である必要があります`);
      const limit = category === 'cut' && key === 'text' ? MAX_CUT_TEXT_LENGTH : MAX_ITEM_TEXT_LENGTH;
      if (value.length > limit) throw new HttpError(400, `${where}.${key} は ${limit} 文字以内である必要があります`);
    }
    for (const key of shape.numbers) {
      const value = fields[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${where}.${key} は有限の数である必要があります`);
    }
  });
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
  for (const key of ['jobId', 'documentId', 'contentHash'] as const) {
    if (b[key] !== undefined && (typeof b[key] !== 'string' || b[key] === '')) {
      throw new HttpError(400, `${key} は空でない文字列である必要があります`);
    }
  }
  for (const category of ['cut', 'words', 'telops', 'ses'] as const) {
    const items = b[category];
    if (Array.isArray(items)) validateApproveItems(category, items);
  }
  return b as unknown as LearningApproveRequest;
}

/** GET /api/learning/status: 未蒸留件数を返す。 */
export function handleLearningStatus(): { undistilledCount: number } {
  return { undistilledCount: countUndistilledFeedback() };
}
