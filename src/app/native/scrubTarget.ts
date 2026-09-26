/**
 * スクラブ・範囲開始で共通のクランプ。`sequenceEndFrame - 1` が負になる空案件では 0 に固定する
 * （現行の `Math.min(Math.max(0, end - 1), at)` は end===0 で -1 を通していた）。
 */
export function scrubFrame(rawFrame: number, sequenceEndFrame: number): number {
  const max = Math.max(0, sequenceEndFrame - 1);
  return Math.min(max, Math.max(0, rawFrame));
}
