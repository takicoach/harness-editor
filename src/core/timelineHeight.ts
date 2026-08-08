// タイムライン高さ（リサイズ）の純関数。DOM / localStorage には触れない。
export const MIN_TIMELINE_H = 192;
/** 既定高さ。トラックが増えたため最小より一回り高くし、主要トラックが見える状態で始める。 */
export const DEFAULT_TIMELINE_H = 240;
export const MAX_HEIGHT_RATIO = 0.7;
export const TIMELINE_HEIGHT_STORAGE_KEY = 'sme.timelineHeight';

/** ビューポート高に対する上限（70% を四捨五入）。 */
export function maxTimelineHeight(viewportH: number): number {
  return Math.round(viewportH * MAX_HEIGHT_RATIO);
}

/** 望み高さを [MIN, max] にクランプ。max < MIN の極小ビューポートでは MIN が勝つ。 */
export function clampTimelineHeight(desired: number, viewportH: number): number {
  const max = maxTimelineHeight(viewportH);
  return Math.max(MIN_TIMELINE_H, Math.min(desired, max));
}

/** ドラッグ中の高さ。上ドラッグ（currentY < startY）で高くなる。 */
export function computeResizeHeight(
  startHeight: number,
  startClientY: number,
  currentClientY: number,
  viewportH: number,
): number {
  const delta = startClientY - currentClientY;
  return clampTimelineHeight(startHeight + delta, viewportH);
}

/** localStorage の生値を有限正数のみ通す（clamp はしない＝復元側で viewport 依存クランプ）。 */
export function parseStoredHeight(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
