/**
 * shapePayload の型定義。
 * src/core/types.ts（ShapeKind / ShapeThickness / ShapeSegment）の独立コピー。
 * src/core への依存を持たない（staticFile / node:vm 非依存）。
 */

/** 図形注釈の種類。 */
export type ShapeKind = 'arrow' | 'line' | 'rect' | 'ellipse';

/** 図形の線の太さ（描画時にフレーム高さ比へ換算）。 */
export type ShapeThickness = 'thin' | 'medium' | 'thick';

/**
 * 図形注釈（再生フレーム基準・プロジェクトの shapeData.ts に出力）。
 * 4 種すべてを 2 点 (x1,y1)-(x2,y2)（正規化 0..1・左上原点）で表す。
 * line/arrow=p1→p2 の線分、rect=2点を対角とする矩形、ellipse=2点の枠に内接する楕円。
 */
export interface ShapeSegment {
  id: number;
  startFrame: number;
  endFrame: number;
  kind: ShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  thickness: ShapeThickness;
  /** 不透明度（0..1、未指定＝1）。 */
  opacity?: number;
}
