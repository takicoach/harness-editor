/**
 * shapeRaster.ts のユニットテスト。
 * - buildShapeSvg: 数値展開の pin（insertShape.test.ts の実値を流用）
 * - rasterizeShape: 実 PNG バイト列を共通デコーダ（pngRgba.decodePngRgba）で復号し、ピクセル実証
 *   （PNG デコードは resvg/外部ライブラリに依存せず zlib のみで完結させる。T1 でローカル実装を
 *   共通実装へ置き換え済み。既存アサーションの期待値は変更していない）
 */

import { describe, expect, it } from 'vitest';
import {
  buildShapeSvg,
  rasterizeShape,
  __setResvgRequireForTest,
  __resetResvgRequireForTest,
} from './shapeRaster';
import { decodePngRgba } from './pngRgba';
import { angleArcPath, angleDegrees, shapePixelPoints, trianglePoints } from '../core/shapeGeometry';
import { thicknessToPx } from '../core/shapeStyle';
import type { ShapeSegment } from '../core/types';

const W = 1920;
const H = 1080;

function makeShape(overrides: Partial<ShapeSegment>): ShapeSegment {
  return {
    id: 1,
    startFrame: 0,
    endFrame: 60,
    kind: 'line',
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 1,
    color: '#FF3B30',
    thickness: 'medium',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PNG デコードは共通実装（pngRgba.decodePngRgba）を使用（8bit RGBA・非インターレース。resvg の既定出力形式）
// ---------------------------------------------------------------------------

function decodePng(buf: Buffer): { width: number; height: number; pixels: Uint8Array } {
  const { width, height, data } = decodePngRgba(buf);
  return { width, height, pixels: data };
}

function pixelAt(decoded: { width: number; pixels: Uint8Array }, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const idx = (y * decoded.width + x) * 4;
  return {
    r: decoded.pixels[idx] ?? 0,
    g: decoded.pixels[idx + 1] ?? 0,
    b: decoded.pixels[idx + 2] ?? 0,
    a: decoded.pixels[idx + 3] ?? 0,
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

const TOL = 2; // ピクセル色判定の許容差 ±2/255

function expectColorClose(actual: { r: number; g: number; b: number }, expected: { r: number; g: number; b: number }) {
  expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(TOL);
}

// ---------------------------------------------------------------------------
// buildShapeSvg: 数値展開の pin
// ---------------------------------------------------------------------------

describe('buildShapeSvg', () => {
  it('rect: x/y/width/height が shapeSvgGeometry の実値になる', () => {
    const shape = makeShape({ kind: 'rect', x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8, color: '#0A84FF' });
    const svg = buildShapeSvg(shape, W, H);
    // rectX=192, rectY=216, rectW=768, rectH=648
    expect(svg).toContain('x="192"');
    expect(svg).toContain('y="216"');
    expect(svg).toContain('width="768"');
    expect(svg).toContain('height="648"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke-linejoin="round"');
  });

  it('ellipse: cx/cy/rx/ry が shapeSvgGeometry の実値になる', () => {
    const shape = makeShape({ kind: 'ellipse', x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.7, color: '#34C759' });
    const svg = buildShapeSvg(shape, W, H);
    // cx=768, cy=540, rx=384, ry=216
    expect(svg).toContain('cx="768"');
    expect(svg).toContain('cy="540"');
    expect(svg).toContain('rx="384"');
    expect(svg).toContain('ry="216"');
    expect(svg).toContain('fill="none"');
  });

  it('line/arrow: stroke-width が thicknessToPx の実値になる（medium@1080 = 11）', () => {
    const shape = makeShape({ kind: 'line', thickness: 'medium' });
    const svg = buildShapeSvg(shape, W, H);
    expect(svg).toContain('stroke-width="11"');
    expect(svg).toContain('stroke-linecap="round"');
  });

  it('arrow: marker 定義と marker-end 参照を持つ', () => {
    const shape = makeShape({ id: 7, kind: 'arrow' });
    const svg = buildShapeSvg(shape, W, H);
    expect(svg).toContain('<marker id="arrow-7"');
    expect(svg).toContain('marker-end="url(#arrow-7)"');
  });

  it('ルート svg の opacity 属性に shape.opacity を焼く（未指定は1）', () => {
    const withOpacity = buildShapeSvg(makeShape({ opacity: 0.5 }), W, H);
    expect(withOpacity).toMatch(/<svg[^>]*opacity="0.5"/);
    const withoutOpacity = buildShapeSvg(makeShape({}), W, H);
    expect(withoutOpacity).toMatch(/<svg[^>]*opacity="1"/);
  });

  it('color にエスケープが必要な文字（"><&\'）が含まれても SVG 属性値としてエスケープされ、rasterizeShape が throw しない', () => {
    const shape = makeShape({ kind: 'rect', color: '"><script>&\'' });
    const svg = buildShapeSvg(shape, W, H);
    expect(svg).not.toContain('"><script>');
    expect(svg).toContain('&quot;&gt;&lt;script&gt;&amp;&apos;');
    expect(() => rasterizeShape(shape, W, H)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rasterizeShape: PNG 実バイト列のピクセル実証（1920x1080）
// ---------------------------------------------------------------------------

describe('rasterizeShape', () => {
  it('PNG 寸法が width×height になる', () => {
    const shape = makeShape({});
    const buf = rasterizeShape(shape, W, H);
    const { width, height } = decodePng(buf);
    expect(width).toBe(W);
    expect(height).toBe(H);
  });

  it('rect: 辺上ピクセルは stroke 色・内部/外部は透明', () => {
    const shape = makeShape({ kind: 'rect', x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6, color: '#0A84FF', thickness: 'thick' });
    const buf = rasterizeShape(shape, W, H);
    const decoded = decodePng(buf);
    // 左辺 x=768（strokeWidth=17 が中心線を跨ぐ）・y=540（辺の中点）
    const edge = pixelAt(decoded, 768, 540);
    expect(edge.a).toBeGreaterThan(200);
    expectColorClose(edge, hexToRgb('#0A84FF'));
    // 内部中心（fill=none なので透明）
    const inside = pixelAt(decoded, 960, 540);
    expect(inside.a).toBeLessThanOrEqual(TOL);
    // 外部
    const outside = pixelAt(decoded, 50, 50);
    expect(outside.a).toBeLessThanOrEqual(TOL);
  });

  it('line: 中点が stroke 色になる', () => {
    const shape = makeShape({ kind: 'line', x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, color: '#34C759', thickness: 'thin' });
    const buf = rasterizeShape(shape, W, H);
    const decoded = decodePng(buf);
    const mid = pixelAt(decoded, 960, 540);
    expect(mid.a).toBeGreaterThan(200);
    expectColorClose(mid, hexToRgb('#34C759'));
  });

  it('arrow: 矢頭領域（線の丸端キャップでは説明できない位置）に不透明ピクセルがある', () => {
    const shape = makeShape({ kind: 'arrow', x1: 0.1, y1: 0.5, x2: 0.5, y2: 0.5, color: '#FF3B30', thickness: 'medium' });
    const buf = rasterizeShape(shape, W, H);
    const decoded = decodePng(buf);
    // lineEnd=(960,540)・strokeWidth=11 → 丸キャップは半径5.5までしか届かない。
    // 矢頭三角形（tip=(960,540)・base 側 (927,523.5)-(927,556.5)）内部の点だが、
    // 線分軸（y=540）から外れた (935,550) を見る（線分本体の半幅5.5pxの外・
    // x=935 での三角形半幅12.5pxの内）→ line 本体だけでは説明できず marker 由来でのみ
    // 不透明になりうる（実測: kind='line' に差し替えると alpha=0、'arrow' なら alpha=255）。
    const arrowheadPoint = pixelAt(decoded, 935, 550);
    expect(arrowheadPoint.a).toBeGreaterThan(200);
    expectColorClose(arrowheadPoint, hexToRgb('#FF3B30'));
  });

  it('opacity:0.5 の図形はピクセル alpha ≒ 128（±2）になる', () => {
    const shape = makeShape({ kind: 'rect', x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6, color: '#0A84FF', thickness: 'thick', opacity: 0.5 });
    const buf = rasterizeShape(shape, W, H);
    const decoded = decodePng(buf);
    const edge = pixelAt(decoded, 768, 540);
    expect(Math.abs(edge.a - 128)).toBeLessThanOrEqual(TOL);
  });
});

// ---------------------------------------------------------------------------
// I-1: resvg の遅延ロード（ローダ失敗を rasterizeShape の throw に閉じ込める）
// ---------------------------------------------------------------------------

describe('resvg 遅延ロード', () => {
  it('(a) ローダが失敗すると rasterizeShape が明示 throw する', () => {
    __setResvgRequireForTest(() => {
      throw new Error('resvg 不在（テスト用）');
    });
    try {
      const shape = makeShape({});
      expect(() => rasterizeShape(shape, W, H)).toThrow(/@resvg\/resvg-js/);
    } finally {
      __resetResvgRequireForTest();
    }
  });

  it('(b) ローダ失敗中でもモジュールの他機能（buildShapeSvg）は使える（トップレベル import 撤去の実証）', () => {
    // トップレベルで `import { Resvg } from '@resvg/resvg-js'` していた頃はロード失敗が
    // モジュール読み込みそのものを壊し、buildShapeSvg のような resvg 非依存の関数まで
    // 道連れで使えなくなっていた。遅延ロードにより rasterizeShape 呼び出し時まで
    // 失敗が閉じ込められることを、他機能が生きたままであることで実証する。
    __setResvgRequireForTest(() => {
      throw new Error('resvg 不在（テスト用）');
    });
    try {
      const shape = makeShape({ kind: 'rect', color: '#0A84FF' });
      expect(() => buildShapeSvg(shape, W, H)).not.toThrow();
      expect(buildShapeSvg(shape, W, H)).toContain('#0A84FF');
    } finally {
      __resetResvgRequireForTest();
    }
  });

  it('ローダ復旧後は再びロードを試み、正常に PNG を返す（キャッシュが失敗固定にならない）', () => {
    __setResvgRequireForTest(() => {
      throw new Error('resvg 不在（テスト用）');
    });
    __resetResvgRequireForTest(); // 実ロードへ戻す（キャッシュも undefined に戻る）
    const shape = makeShape({});
    expect(() => rasterizeShape(shape, W, H)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// I-5: triangle / angle。以前はどの分岐にも当たらず、中身が空の妥当な SVG
// （＝完全透過 PNG）を返していた。頂点は core/shapeGeometry と一致させる。
// ---------------------------------------------------------------------------

describe('triangle / angle（I-5）', () => {
  it('triangle は shapeGeometry の 3 頂点をそのまま polygon にする', () => {
    const shape = makeShape({ kind: 'triangle', x1: 0.2, y1: 0.8, x2: 0.6, y2: 0.2 });
    const svg = buildShapeSvg(shape, W, H);
    const expected = trianglePoints(0.2 * W, 0.8 * H, 0.6 * W, 0.2 * H).map(p => `${p.x},${p.y}`).join(' ');
    expect(svg).toContain(`<polygon points="${expected}"`);
    expect(svg).toContain('fill="none"');
  });

  it('angle は頂点から両端点への 2 本の線と、shapeGeometry の弧を描く', () => {
    const shape = makeShape({ kind: 'angle', x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.5, x3: 0.5, y3: 0.1 });
    const svg = buildShapeSvg(shape, W, H);
    const { p1, p2, p3 } = shapePixelPoints(shape, W, H);
    const stroke = thicknessToPx(shape.thickness, H);
    const radius = Math.max(stroke * 3,
      Math.min(Math.hypot(p2.x - p1.x, p2.y - p1.y), Math.hypot(p3.x - p1.x, p3.y - p1.y)) * 0.35);
    expect(svg).toContain(`x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"`);
    expect(svg).toContain(`x1="${p1.x}" y1="${p1.y}" x2="${p3.x}" y2="${p3.y}"`);
    expect(svg).toContain(`d="${angleArcPath(p1, p2, p3, radius)}"`);
    expect(svg).toContain(`${angleDegrees(p1, p2, p3).toFixed(1)}°`);
  });

  for (const shape of [
    makeShape({ kind: 'triangle', x1: 0.2, y1: 0.8, x2: 0.6, y2: 0.2 }),
    makeShape({ kind: 'angle', x1: 0.5, y1: 0.5, x2: 0.9, y2: 0.5, x3: 0.5, y3: 0.1 }),
  ]) {
    it(`${shape.kind} のラスタは透明ではない（画素が実際に乗る）`, () => {
      const decoded = decodePng(rasterizeShape(shape, 480, 270));
      let opaque = 0;
      for (let index = 3; index < decoded.pixels.length; index += 4) if ((decoded.pixels[index] ?? 0) > 0) opaque++;
      expect(opaque).toBeGreaterThan(0);
    });
  }
});
