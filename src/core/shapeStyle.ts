import type { ShapeKind, ShapeThickness } from './types';

/** 図形の色プリセット（赤・黄・白・黒・青・緑）。 */
export const SHAPE_COLORS = [
  '#FF3B30',
  '#FFCC00',
  '#FFFFFF',
  '#000000',
  '#0A84FF',
  '#34C759',
] as const;

/** 既定色（赤）。 */
export const DEFAULT_SHAPE_COLOR = '#FF3B30';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 太さ → フレーム高さ比の px（最低 1）。
 * thin 0.5% / medium 1.0% / thick 1.6%。
 */
export function thicknessToPx(thickness: ShapeThickness, frameHeight: number): number {
  const ratio = thickness === 'thin' ? 0.005 : thickness === 'thick' ? 0.016 : 0.01;
  return Math.max(1, Math.round(frameHeight * ratio));
}

/**
 * 区間先頭/末尾 fadeFrames で 0→1→0 の不透明度（線形）。
 * 出入り 8fr 相当を想定。
 */
export function fadeOpacity(
  frame: number,
  durationInFrames: number,
  fadeFrames: number,
): number {
  if (durationInFrames <= 0) return 0;
  if (fadeFrames <= 0) return 1;
  const inFade = clamp(frame / fadeFrames, 0, 1);
  const outFade = clamp((durationInFrames - frame) / fadeFrames, 0, 1);
  return clamp(Math.min(inFade, outFade), 0, 1);
}

/**
 * 画面 px → 映像内正規化座標（0..1・左上原点・クランプ）。
 */
export function pointerToVideoPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  return {
    x: clamp((clientX - rect.left) / rect.width, 0, 1),
    y: clamp((clientY - rect.top) / rect.height, 0, 1),
  };
}

/**
 * 2 点（正規化）＋フレーム実寸から SVG 各図形の座標を求める。
 * - line/arrow: x1/y1/x2/y2 をそのまま使う
 * - rect: rectX/rectY/rectW/rectH（左上原点・正値）
 * - ellipse: cx/cy（中心）、rx/ry（半径）
 */
export function shapeSvgGeometry(
  s: { kind: ShapeKind; x1: number; y1: number; x2: number; y2: number },
  w: number,
  h: number,
): {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  rx: number;
  ry: number;
  cx: number;
  cy: number;
  rectX: number;
  rectY: number;
  rectW: number;
  rectH: number;
} {
  const px1 = s.x1 * w;
  const py1 = s.y1 * h;
  const px2 = s.x2 * w;
  const py2 = s.y2 * h;
  const rectX = Math.min(px1, px2);
  const rectY = Math.min(py1, py2);
  const rectW = Math.abs(px2 - px1);
  const rectH = Math.abs(py2 - py1);
  return {
    x1: px1,
    y1: py1,
    x2: px2,
    y2: py2,
    rx: rectW / 2,
    ry: rectH / 2,
    cx: (px1 + px2) / 2,
    cy: (py1 + py2) / 2,
    rectX,
    rectY,
    rectW,
    rectH,
  };
}
