// タイムライン高さ（リサイズ）の純関数。DOM / localStorage には触れない。
export const MIN_TIMELINE_H = 192;
/** 既定高さ。トラックが増えたため最小より一回り高くし、主要トラックが見える状態で始める。 */
export const DEFAULT_TIMELINE_H = 240;

/** ビューポート連動の既定高さの下限・上限・比率。 */
export const DEFAULT_H_MIN = 220;
export const DEFAULT_H_MAX = 460;
export const DEFAULT_H_RATIO = 0.32;

/**
 * 保存値が無いときの既定高さ（ビューポート連動）。
 *
 * 固定 240px だと 900 高の画面でも動画・じまく の 2 本しか見えず、テロップ・画像・
 * 効果音・BGM・図形は下端 1139〜1347px で画面外に出ていた。
 * `clamp(220px, 32vh, 460px)` 相当をここで計算する（CSS ではなく純関数に置くのは、
 * リサイザの永続値と同じ「希望値」の系に載せるため）。
 */
export function defaultTimelineHeight(viewportH: number): number {
  if (!Number.isFinite(viewportH) || viewportH <= 0) return DEFAULT_TIMELINE_H;
  const desired = Math.round(viewportH * DEFAULT_H_RATIO);
  return Math.max(DEFAULT_H_MIN, Math.min(DEFAULT_H_MAX, desired));
}
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
