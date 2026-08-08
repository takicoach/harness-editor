import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { globalStoreDir, seFeedbackPath, seRulesPath } from './paths';
import { applySeFeedback, emptySeRules, normalizeSeRulesFile } from './seRules';
import type { SeFeedbackEntry, SeRulesFile } from './seRules';

/** 既存 feedback と (videoId, kind, seFile, contextText) が一致するかの重複キー（timestamp は無視）。 */
function feedbackDedupeKey(e: SeFeedbackEntry): string {
  return JSON.stringify([e.videoId, e.kind, e.seFile, e.contextText]);
}

/** se_feedback.jsonl の既存行を読み、重複キーの集合を返す（未作成なら空集合）。 */
function existingFeedbackKeys(): Set<string> {
  const p = seFeedbackPath();
  if (!existsSync(p)) return new Set();
  const lines = readFileSync(p, 'utf8').split('\n').filter((line) => line.trim() !== '');
  return new Set(lines.map((line) => feedbackDedupeKey(JSON.parse(line) as SeFeedbackEntry)));
}

/**
 * 承認済み SE 差分を se_feedback.jsonl へ追記する（mkdir 込み）。
 * (videoId, kind, seFile, contextText) が既存行と一致する entry は timestamp が異なっても
 * 追記しない（cutStore.appendCutFeedback と同じ二重計上防止 = I-1）。
 */
export function appendSeFeedback(entries: SeFeedbackEntry[]): void {
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
  writeFileSync(seFeedbackPath(), lines, { flag: 'a' });
}

/** 集計済み SE ルールを読む。未作成・破損時は空のルール集合を返す。 */
export function loadSeRules(): SeRulesFile {
  const p = seRulesPath();
  if (!existsSync(p)) return emptySeRules();
  try {
    return normalizeSeRulesFile(JSON.parse(readFileSync(p, 'utf8')) as SeRulesFile);
  } catch (err) {
    console.warn(`[seStore] se_rules.json の読み込みに失敗したため空から再構築します: ${String(err)}`);
    return emptySeRules();
  }
}

/** 集計済み SE ルールを保存する。 */
export function saveSeRules(rules: SeRulesFile): void {
  mkdirSync(globalStoreDir(), { recursive: true });
  writeFileSync(seRulesPath(), `${JSON.stringify(rules, null, 2)}\n`);
}

/**
 * 承認済み SE 差分を feedback へ追記し、集計済みルールへ反映して保存する一括処理。
 * API から呼ぶ入口。
 */
export function recordApprovedSeFeedback(entries: SeFeedbackEntry[]): SeRulesFile {
  appendSeFeedback(entries);
  const updated = applySeFeedback(loadSeRules(), entries);
  saveSeRules(updated);
  return updated;
}
