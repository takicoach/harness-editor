import type { SceneTransitionKind } from './types';

/** シーン転換の色プリセット（黒・白・赤・青・緑）。fadeColor 用。 */
export const SCENE_COLORS = ['#000000', '#FFFFFF', '#FF3B30', '#0A84FF', '#34C759'] as const;

/** fadeColor の既定色（赤）。 */
export const DEFAULT_SCENE_COLOR = '#FF3B30';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 既定の転換長（フレーム）。fps×0.5 秒を四捨五入、最小 2。 */
export function sceneDurationDefault(fps: number): number {
  return Math.max(2, Math.round(fps * 0.5));
}

/** kind→オーバーレイ色。fade 系のみ色を持つ。重なる系（Plan 3）は null。 */
export function overlayColorFor(kind: SceneTransitionKind, color?: string): string | null {
  if (kind === 'fadeBlack') return '#000000';
  if (kind === 'fadeWhite') return '#FFFFFF';
  if (kind === 'fadeColor') return color ?? DEFAULT_SCENE_COLOR;
  return null; // crossfade/slide/wipe はオーバーレイで描かない
}

/**
 * つなぎ目フェードの不透明度。中心 joinFrame で 1、±durationFrames/2 の窓端で 0 の線形の山。
 * 場面 A が色へ沈み（前半）、場面 B が色から出る（後半）＝暗転つなぎ。
 */
export function joinOverlayOpacityAt(frame: number, joinFrame: number, durationFrames: number): number {
  if (durationFrames <= 0) return 0;
  const half = durationFrames / 2;
  const dist = Math.abs(frame - joinFrame);
  if (dist >= half) return 0;
  return clamp(1 - dist / half, 0, 1);
}

/**
 * 頭尾フェードの不透明度。
 * head: 先頭 durationFrames で 1→0（色から出る）。
 * tail: 末尾 durationFrames（[total-dur, total]）で 0→1（色へ沈む）。
 */
export function edgeOverlayOpacityAt(
  frame: number, edge: 'head' | 'tail', totalFrames: number, durationFrames: number,
): number {
  if (durationFrames <= 0) return 0;
  if (edge === 'head') {
    if (frame >= durationFrames) return 0;
    return clamp(1 - frame / durationFrames, 0, 1);
  }
  // tail
  const start = totalFrames - durationFrames;
  if (frame <= start) return 0;
  return clamp((frame - start) / durationFrames, 0, 1);
}
