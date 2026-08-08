// 原本フレーム区間ユーティリティ（純関数・依存ゼロ・クライアント import 可）。
// 区間はすべて半開 [start, end)。CutRegion / WordChip の区間表現と一致させる。

/**
 * 2 つの半開区間 [aStart, aEnd) と [bStart, bEnd) が重なるか。
 * 端が接するだけ（aEnd === bStart 等）は重ならない。
 * 空区間（start >= end）はいずれとも重ならない。
 */
export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < aEnd && bStart < bEnd && aStart < bEnd && bStart < aEnd;
}
