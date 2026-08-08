import type { TelopPosition } from './types';

/** 飾りテロップ（文字起こし非依存の装飾テロップ）の判定。唯一の規約は manual:true。 */
export function isDecorationTelop(t: { manual?: boolean }): boolean {
  return t.manual === true;
}

/** テロップ配列を字幕（manual でない）と飾り（manual:true）へ順序保持で分ける純関数。 */
export function partitionTelops<T extends { manual?: boolean }>(
  telops: T[],
): { subtitles: T[]; decorations: T[] } {
  const subtitles: T[] = [];
  const decorations: T[] = [];
  for (const t of telops) {
    if (isDecorationTelop(t)) decorations.push(t);
    else subtitles.push(t);
  }
  return { subtitles, decorations };
}

/** 新規飾りテロップの既定位置（左上）。正規化座標 x:左-1〜右+1 / y:下0〜上-1。 */
export const DECORATION_DEFAULT_POSITION: TelopPosition = { x: -0.55, y: -0.85 };

/** 新規飾りテロップの既定表示長（秒）。ヘッド位置からこの長さで作成する。 */
export const DECORATION_DEFAULT_DURATION_SEC = 5;
