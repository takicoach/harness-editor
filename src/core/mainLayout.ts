import type { MainLayout } from './types';

/** メイン動画レイアウトの既定（全画面・黒背景・恒等変形）。 */
export const DEFAULT_MAIN_LAYOUT: MainLayout = {
  position: { x: 0, y: 0 },
  scale: 1,
  background: '#000000',
  rotation: 0,
  flipH: false,
  flipV: false,
};

/** scale のクランプ範囲（サブ動画と一致）。 */
export const MAIN_LAYOUT_MIN_SCALE = 0.1;
export const MAIN_LAYOUT_MAX_SCALE = 5;

/** position 各軸のクランプ（-1..1）。 */
export function clampLayoutPos(v: number): number {
  return Math.min(1, Math.max(-1, v));
}

/** scale のクランプ（0.1..5）。 */
export function clampLayoutScale(s: number): number {
  return Math.min(MAIN_LAYOUT_MAX_SCALE, Math.max(MAIN_LAYOUT_MIN_SCALE, s));
}

/** rotation のクランプ(-180..180)。NaN は 0(±Infinity は境界値にクランプ)。 */
export function clampRotation(r: number): number {
  if (Number.isNaN(r)) return 0;
  return Math.min(180, Math.max(-180, r));
}

/** 恒等レイアウト(全画面・変形なし)か。背景は不問。 */
export function isIdentityMainLayout(l: MainLayout): boolean {
  return (
    l.scale === 1 &&
    l.position.x === 0 &&
    l.position.y === 0 &&
    (l.rotation ?? 0) === 0 &&
    !l.flipH &&
    !l.flipV
  );
}

/**
 * レイアウトの CSS transform 文字列(中心原点)。
 * translate() rotate() scale(sx,sy)。反転は負スケールで表現(sx/sy)。
 * プレビュー(EditorComposition)と書き出し(Plan 2 payload)で同式。
 */
export function mainLayoutTransform(l: MainLayout): string {
  const sx = l.scale * (l.flipH ? -1 : 1);
  const sy = l.scale * (l.flipV ? -1 : 1);
  return `translate(${(l.position.x * 100) / 2}%, ${(l.position.y * 100) / 2}%) rotate(${clampRotation(l.rotation ?? 0)}deg) scale(${sx}, ${sy})`;
}
