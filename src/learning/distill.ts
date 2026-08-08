import type { WordReplacement } from './types';

/**
 * 生の語句置換を辞書ルール候補へ蒸留する。
 * - 重複除去
 * - 句読点（。、）を含む置換は「文の書き換え」とみなし語句ルールにしない
 * - before が空、または maxLen 文字超の置換は除外
 * - after が maxLen 文字超の置換は除外（辞書への書き込み値を制限）
 */
export function distillWordRules(
  replacements: WordReplacement[],
  maxLen = 12,
): WordReplacement[] {
  const seen = new Set<string>();
  const out: WordReplacement[] = [];
  for (const r of replacements) {
    if (r.before.length === 0 || r.before.length > maxLen || r.after.length > maxLen) continue;
    if (/[。、]/.test(r.before) || /[。、]/.test(r.after)) continue;
    const key = `${r.before}\0${r.after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ before: r.before, after: r.after });
  }
  return out;
}
