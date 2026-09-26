/** 調整タブに並べるボタン。件数はここから数える。 */
export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4, 8] as const;
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 16;

const LN_MIN = Math.log(SPEED_MIN);
const LN_MAX = Math.log(SPEED_MAX);

/**
 * 0..100 のスライダー位置 → 速度（区分対数）。
 * v ∈ [0, 50]: SPEED_MIN..1 の対数補間、v ∈ [50, 100]: 1..SPEED_MAX の対数補間。
 * sliderToRate(50) === 1（等速が中央）。
 */
export function sliderToRate(v: number): number {
  if (!Number.isFinite(v)) return 1;
  const clamped = Math.min(100, Math.max(0, v));
  if (clamped <= 50) {
    return Math.exp(LN_MIN * (1 - clamped / 50));
  } else {
    return Math.exp(LN_MAX * ((clamped - 50) / 50));
  }
}

export function rateToSlider(rate: number): number {
  if (!Number.isFinite(rate)) return 50;
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
  if (clamped <= 1) {
    return Math.round(50 * (1 - Math.log(clamped) / LN_MIN));
  } else {
    return Math.round(50 + 50 * Math.log(clamped) / LN_MAX);
  }
}

/** UI とテストで同じ文言を使うための整形。末尾の 0 を落とす。 */
export function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}x`;
}
