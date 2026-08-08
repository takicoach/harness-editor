import type { TranscriptFixed, WordReplacement } from './types';

/**
 * 2 つのセグメントテキストを比較し、共通接頭辞・接尾辞を除いた変化部分を
 * 語句置換として返す。純粋な挿入・削除（片側が空）は LL Phase A の対象外で null。
 */
export function diffSegmentText(before: string, after: string): WordReplacement | null {
  if (before === after) return null;

  const minLen = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < minLen && before[prefix] === after[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);
  if (beforeMiddle === '' || afterMiddle === '') return null;
  return { before: beforeMiddle, after: afterMiddle };
}

/**
 * ベースラインと最終の transcript_fixed を差分し、語句置換の一覧を返す。
 * セグメントは index で対応付ける（誤字修正はセグメント数を変えない前提。
 * カットによるセグメント増減は LL Phase B の扱い）。
 */
export function diffTranscriptFixed(
  baseline: TranscriptFixed,
  final: TranscriptFixed,
): WordReplacement[] {
  // セグメント数が変わる編集（削除/挿入/分割）が起きた場合、index 対応がずれて
  // 誤った語句ルールを生むため、何も学習しない（LL Phase A はセグメント数不変が前提）。
  if (baseline.segments.length !== final.segments.length) return [];

  const out: WordReplacement[] = [];
  const count = baseline.segments.length;
  for (let i = 0; i < count; i++) {
    const replacement = diffSegmentText(baseline.segments[i]!.text, final.segments[i]!.text);
    if (replacement) out.push(replacement);
  }
  return out;
}
