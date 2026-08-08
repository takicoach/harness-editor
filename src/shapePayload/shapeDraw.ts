/**
 * shapePayload の描画ユーティリティ。
 * src/core/shapeStyle.ts（shapeSvgGeometry / thicknessToPx / fadeOpacity）と
 * 同一ロジックの独立コピー。
 * staticFile / node:vm に依存しない。
 */

import type { ShapeKind, ShapeThickness } from './types';

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 太さ → フレーム高さ比の px（最低 1）。
 * thin 0.5% / medium 1.0% / thick 1.6%。
 * src/core/shapeStyle.ts の thicknessToPx と一致させる契約。
 */
export function thicknessToPx(thickness: ShapeThickness, frameHeight: number): number {
  const ratio = thickness === 'thin' ? 0.005 : thickness === 'thick' ? 0.016 : 0.01;
  return Math.max(1, Math.round(frameHeight * ratio));
}

/**
 * 区間先頭/末尾 fadeFrames で 0→1→0 の不透明度（線形）。
 * 出入り 8fr 相当を想定。
 * src/core/shapeStyle.ts の fadeOpacity と一致させる契約。
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
 * 2 点（正規化）＋フレーム実寸から SVG 各図形の座標を求める。
 * - line/arrow: x1/y1/x2/y2 をそのまま使う
 * - rect: rectX/rectY/rectW/rectH（左上原点・正値）
 * - ellipse: cx/cy（中心）、rx/ry（半径）
 * src/core/shapeStyle.ts の shapeSvgGeometry と一致させる契約。
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
