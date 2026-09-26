import { createRequire } from 'node:module';
import type { ShapeSegment } from '../core/types';
import { shapeSvgGeometry, thicknessToPx } from '../core/shapeStyle';
import { angleDecorations, trianglePoints } from '../core/shapeGeometry';

// I-1: @resvg/resvg-js はトップレベルで import しない。ネイティブアドオンのロード失敗を
// dev サーバー起動失敗まで増幅させないため（ptySession.ts:11-16 の node-pty と同じ理由）。
// resvg は同期 API（Resvg#render）しか持たず rasterizeShape を非同期化できないため、
// node-pty の `await import()` ではなく createRequire による同期ロードを選ぶ
// （@resvg/resvg-js は `main: index.js`・`exports` 未定義の CJS パッケージなので同期 require が効く）。
// 結果はキャッシュする: undefined=未試行／null=失敗／実体=ロード済み。
type ResvgCtor = new (svg: string, opts: unknown) => { render: () => { asPng: () => Buffer } };
interface ResvgModule { Resvg: ResvgCtor }

// createRequire もモジュール読み込み時ではなく初回ロード時に作る: import.meta.url が
// file URL でない文脈（data: URL 経由の import 等）では createRequire 自体が throw するため、
// ここで実行するとモジュール読み込みごと壊れて I-1 の趣旨（起動を人質に取らない）が崩れる。
let resvgRequire: ((id: string) => unknown) | undefined;
let resvgCtorCache: ResvgCtor | null | undefined;

function loadResvgCtor(): ResvgCtor {
  if (resvgCtorCache === undefined) {
    try {
      resvgRequire ??= createRequire(import.meta.url);
      resvgCtorCache = (resvgRequire('@resvg/resvg-js') as ResvgModule).Resvg;
    } catch {
      resvgCtorCache = null;
    }
  }
  if (resvgCtorCache === null) {
    throw new Error(
      'rasterizeShape: @resvg/resvg-js のロードに失敗しました（図形オーバーレイの PNG 化ができません）',
    );
  }
  return resvgCtorCache;
}

/**
 * テスト専用フック: require 実装の差し替え＋ロード結果キャッシュのリセット。
 * 本体経路（rasterizeShape・fastCutPlan 等）からは呼ばない。
 */
export function __setResvgRequireForTest(fn: (id: string) => unknown): void {
  resvgRequire = fn;
  resvgCtorCache = undefined;
}

/** テスト専用フック: 既定の（実 require による）ロード状態に戻す。 */
export function __resetResvgRequireForTest(): void {
  resvgRequire = undefined;
  resvgCtorCache = undefined;
}

/**
 * Step 0 スパイク結果（doc comment に記録・設計判断10）:
 * resvg（@resvg/resvg-js 2.6系）は `<marker>` を実描画する。
 * 実測: 水平線（stroke-width=10, x1=50,y1=100→x2=150,y2=100）に
 * `points="0 0, 3 1.5, 0 3" refX=3 refY=1.5 markerUnits="strokeWidth"` の
 * marker-end を付けたところ、計算上の三角形領域（tip=(150,100)・
 * base=(120,85)-(120,115)）の内部ピクセル（例: (122,88)）が alpha=255 で
 * 描画され、同一 SVG から marker-end 属性だけ外すと同ピクセルは alpha=0
 * だった（= marker 起因と確認）。→ InsertShape.tsx と同じ marker 構造を
 * そのまま採用する（明示 polygon 展開は不要）。
 */

/** SVG 属性値用にエスケープする（& < > " ' の5文字）。 */
function escapeSvgAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 図形 1 個を SVG 文字列にする。InsertShape.tsx:39-107 と同値の構造。 */
export function buildShapeSvg(shape: ShapeSegment, width: number, height: number): string {
  const g = shapeSvgGeometry(shape, width, height);
  const strokeWidth = thicknessToPx(shape.thickness, height);
  const opacity = shape.opacity ?? 1;
  const markerId = `arrow-${shape.id}`;
  const color = escapeSvgAttr(shape.color);

  const defs = shape.kind === 'arrow'
    ? `<defs><marker id="${markerId}" markerWidth="3" markerHeight="3" refX="3" refY="1.5" orient="auto" markerUnits="strokeWidth"><polygon points="0 0, 3 1.5, 0 3" fill="${color}" /></marker></defs>`
    : '';

  // I-5: 分岐は ShapeKind を網羅する。以前は line/arrow・rect・ellipse の 3 分岐だけで、
  // triangle/angle は `el=''` のまま「中身が空の妥当な SVG」＝完全透過 PNG になっていた
  // （rasterizeShape も例外を投げないので fastCutPlan の Remotion 退避経路にも落ちない）。
  // 末尾の never 検査で、ShapeKind に種別を足したときは tsc が落ちる。
  // 描き方は native の正典 src/preview/native/sceneRenderer.tsx の Shape と同じ。
  let el: string;
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    const markerAttr = shape.kind === 'arrow' ? ` marker-end="url(#${markerId})"` : '';
    el = `<line x1="${g.x1}" y1="${g.y1}" x2="${g.x2}" y2="${g.y2}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"${markerAttr} />`;
  } else if (shape.kind === 'rect') {
    el = `<rect x="${g.rectX}" y="${g.rectY}" width="${g.rectW}" height="${g.rectH}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" stroke-linejoin="round" />`;
  } else if (shape.kind === 'ellipse') {
    const rx = Math.max(0, g.rx);
    const ry = Math.max(0, g.ry);
    el = `<ellipse cx="${g.cx}" cy="${g.cy}" rx="${rx}" ry="${ry}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" />`;
  } else if (shape.kind === 'triangle') {
    const points = trianglePoints(g.x1, g.y1, g.x2, g.y2).map(point => `${point.x},${point.y}`).join(' ');
    el = `<polygon points="${points}" stroke="${color}" stroke-width="${strokeWidth}" fill="none" stroke-linejoin="round" />`;
  } else if (shape.kind === 'angle') {
    // 装飾の式は core/shapeGeometry が正本。native（preview/native/sceneRenderer）と同じ関数を呼ぶ。
    const { p1, p2, p3, arcPath, arcStroke, label, fontSize, degrees } = angleDecorations(shape, width, height, strokeWidth);
    el = `<g>`
      + `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />`
      + `<line x1="${p1.x}" y1="${p1.y}" x2="${p3.x}" y2="${p3.y}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />`
      + `<path d="${arcPath}" stroke="${color}" stroke-width="${arcStroke}" fill="none" />`
      // 角度の読み取り値。resvg はシステムフォントで描く（ブラウザとグリフは一致しないが、
      // 「読み取り値がそこにある」ことは native の描画と揃う）。
      + `<text x="${label.x}" y="${label.y}" fill="${color}" text-anchor="middle" dominant-baseline="middle"`
      + ` font-size="${fontSize}" font-weight="700">${degrees.toFixed(1)}°</text>`
      + `</g>`;
  } else {
    const unsupported: never = shape.kind;
    throw new Error(`buildShapeSvg: 未対応の図形種別です: ${String(unsupported)}`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" opacity="${opacity}">${defs}${el}</svg>`;
}

/** 図形 1 個を width×height の PNG（RGBA）にラスタライズする。 */
export function rasterizeShape(shape: ShapeSegment, width: number, height: number): Buffer {
  const svg = buildShapeSvg(shape, width, height);
  const Resvg = loadResvgCtor();
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  const png = resvg.render();
  return png.asPng();
}
