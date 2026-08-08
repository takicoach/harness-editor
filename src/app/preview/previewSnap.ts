import type { TelopPosition } from '../../core/types';

/**
 * 吸着候補（正規化座標）。中央 0 と三分割線 ±1/3 のみ。
 * 端（±1）は構図上の意味が薄いため意図的に吸着対象外とする。
 */
export const SNAP_LINES = [-1 / 3, 0, 1 / 3];

/** 既定の吸着しきい値（正規化）。端〜端が 2 なので 0.05 ≒ 数十 px 相当。 */
export const SNAP_THRESHOLD = 0.05;

export interface AxisSnap {
  /** 吸着後の値（吸着しなければ入力値）。 */
  value: number;
  /** 吸着した線（吸着しなければ null）。 */
  line: number | null;
}

/** 1 軸の値を最寄りの SNAP_LINES へ吸着する。 */
export function snapAxis(v: number, threshold: number): AxisSnap {
  let best: number | null = null;
  let bestDist = threshold;
  for (const line of SNAP_LINES) {
    const d = Math.abs(line - v);
    if (d <= bestDist) {
      best = line;
      bestDist = d;
    }
  }
  return best === null ? { value: v, line: null } : { value: best, line: best };
}

export interface PositionSnap {
  position: TelopPosition;
  /** 吸着した縦線（x 値）。ガイド表示用。 */
  guideX: number | null;
  /** 吸着した横線（y 値）。ガイド表示用。 */
  guideY: number | null;
}

/** position の x/y を独立に吸着する。 */
export function snapPosition(pos: TelopPosition, threshold = SNAP_THRESHOLD): PositionSnap {
  const sx = snapAxis(pos.x, threshold);
  const sy = snapAxis(pos.y, threshold);
  return {
    position: { x: sx.value, y: sy.value },
    guideX: sx.line,
    guideY: sy.line,
  };
}
