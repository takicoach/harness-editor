import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  globalStoreDir,
  cutFeedbackPath,
  cutRulesPath,
  distillStatePath,
  telopFeedbackPath,
  seFeedbackPath,
} from './paths';
import { applyCutFeedback, emptyCutRules, normalizeCutRulesFile } from './cutRules';
import type { CutFeedbackEntry, CutRulesFile } from './cutRules';

/** 既存 feedback と (videoId, kind, startFrame, endFrame, text) が一致するかの重複キー（timestamp は無視）。 */
function feedbackDedupeKey(e: CutFeedbackEntry): string {
  return JSON.stringify([e.videoId, e.kind, e.startFrame, e.endFrame, e.text]);
}

/** cut_feedback.jsonl の既存行を読み、重複キーの集合を返す（未作成なら空集合）。 */
function existingFeedbackKeys(): Set<string> {
  const p = cutFeedbackPath();
  if (!existsSync(p)) return new Set();
  const lines = readFileSync(p, 'utf8').split('\n').filter((line) => line.trim() !== '');
  return new Set(lines.map((line) => feedbackDedupeKey(JSON.parse(line) as CutFeedbackEntry)));
}

/**
 * 承認済みカット差分を cut_feedback.jsonl へ追記する（mkdir 込み）。
 * (videoId, kind, startFrame, endFrame, text) が既存行と一致する entry は timestamp が異なっても
 * 追記しない（同一動画の再書き出し・再承認による jsonl 側の二重計上を防止 = I-1）。
 */
export function appendCutFeedback(entries: CutFeedbackEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(globalStoreDir(), { recursive: true });
  const seenKeys = existingFeedbackKeys();
  const toAppend = entries.filter((e) => {
    const key = feedbackDedupeKey(e);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  if (toAppend.length === 0) return;
  const lines = toAppend.map((e) => `${JSON.stringify(e)}\n`).join('');
  writeFileSync(cutFeedbackPath(), lines, { flag: 'a' });
}

/** 集計済みカットルールを読む。未作成・破損時は空のルール集合を返す。 */
export function loadCutRules(): CutRulesFile {
  const p = cutRulesPath();
  if (!existsSync(p)) return emptyCutRules();
  try {
    return normalizeCutRulesFile(JSON.parse(readFileSync(p, 'utf8')) as CutRulesFile);
  } catch (err) {
    console.warn(`[cutStore] cut_rules.json の読み込みに失敗したため空から再構築します: ${String(err)}`);
    return emptyCutRules();
  }
}

/** 集計済みカットルールを保存する。 */
export function saveCutRules(rules: CutRulesFile): void {
  mkdirSync(globalStoreDir(), { recursive: true });
  writeFileSync(cutRulesPath(), `${JSON.stringify(rules, null, 2)}\n`);
}

/**
 * 承認済みカット差分を feedback へ追記し、集計済みルールへ反映して保存する一括処理。
 * API から呼ぶ入口。
 */
export function recordApprovedCutFeedback(entries: CutFeedbackEntry[]): CutRulesFile {
  appendCutFeedback(entries);
  const updated = applyCutFeedback(loadCutRules(), entries);
  saveCutRules(updated);
  return updated;
}

/** distill_state.json の内容。旧形式は consumedLines（cut 専用・数値）のみを持つ。 */
interface DistillState {
  /** 旧形式（cut 専用）。ファイル別 consumedLines が無いときの後方互換フォールバック。 */
  consumedLines?: number;
  cutConsumedLines?: number;
  telopConsumedLines?: number;
  seConsumedLines?: number;
}

function readDistillState(): DistillState {
  const statePath = distillStatePath();
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as DistillState;
  } catch (err) {
    console.warn(`[cutStore] distill_state.json の読み込みに失敗したため 0 扱いにします: ${String(err)}`);
    return {};
  }
}

/** jsonl の空でない行数（未作成なら 0）。承認の前後で比べて「新しく記録した行数」を求めるのにも使う。 */
export function countJsonlLines(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * cut_feedback.jsonl / telop_feedback.jsonl / se_feedback.jsonl の総行数から、
 * それぞれの distill 消化済み行数を引いた未蒸留件数の合算を返す。
 * 後方互換: distill_state.json が旧形式 `{ consumedLines }` のときは cut の消費分として読み、
 * telop/se の消費分は 0 扱い（新形式が来る前に蒸留した分は cut にしか無かったため正しい）。
 */
export function countUndistilledFeedback(): number {
  const state = readDistillState();
  const cutConsumed = state.cutConsumedLines ?? state.consumedLines ?? 0;
  const telopConsumed = state.telopConsumedLines ?? 0;
  const seConsumed = state.seConsumedLines ?? 0;

  const cutRemaining = Math.max(0, countJsonlLines(cutFeedbackPath()) - cutConsumed);
  const telopRemaining = Math.max(0, countJsonlLines(telopFeedbackPath()) - telopConsumed);
  const seRemaining = Math.max(0, countJsonlLines(seFeedbackPath()) - seConsumed);
  return cutRemaining + telopRemaining + seRemaining;
}
