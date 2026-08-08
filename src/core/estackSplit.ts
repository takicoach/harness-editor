// 横型レイアウトでの「文字起こしストリップ高さ」（プレビュー⇔文字起こしの分割）の純関数。
// DOM / localStorage には触れない。timelineHeight.ts と同じ設計。
// プレビューを主役(1fr)に保ち、文字起こしを下部の可変ストリップ(--transcript-h)にする。

export const MIN_TRANSCRIPT_H = 96;
export const DEFAULT_TRANSCRIPT_H = 160;
/** estack コンテナ高に対する上限比。プレビューが常に過半（55%以上）を確保＝細長くならない。 */
export const MAX_TRANSCRIPT_RATIO = 0.45;
export const TRANSCRIPT_HEIGHT_STORAGE_KEY = 'sme.transcriptHeight';
export const TRANSCRIPT_HEIGHT_CSS_VAR = '--transcript-h';

/** estack 高に対する上限（45% を四捨五入）。 */
export function maxTranscriptHeight(containerH: number): number {
  return Math.round(containerH * MAX_TRANSCRIPT_RATIO);
}

/** 望み高さを [MIN, max] にクランプ。max < MIN の極小コンテナでは MIN が勝つ。 */
export function clampTranscriptHeight(desired: number, containerH: number): number {
  const max = maxTranscriptHeight(containerH);
  return Math.max(MIN_TRANSCRIPT_H, Math.min(desired, max));
}

/** ドラッグ中の高さ。上ドラッグ（currentY < startY）で文字起こしが高くなる。 */
export function computeTranscriptHeight(
  startHeight: number,
  startClientY: number,
  currentClientY: number,
  containerH: number,
): number {
  const delta = startClientY - currentClientY;
  return clampTranscriptHeight(startHeight + delta, containerH);
}

/** localStorage の生値を有限正数のみ通す（clamp はしない＝復元側でコンテナ依存クランプ）。 */
export function parseStoredHeight(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
