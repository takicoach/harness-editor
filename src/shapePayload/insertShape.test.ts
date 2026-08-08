/**
 * shapePayload/shapeDraw.ts のユニットテスト。
 * - core 版（src/core/shapeStyle.ts）との1:1一致を確認する代表ケース
 * - 楕円の中心座標
 * - 矩形の寸法
 */

import { describe, it, expect } from 'vitest';
import {
  shapeSvgGeometry,
  thicknessToPx,
  fadeOpacity,
} from './shapeDraw';

// ---------------------------------------------------------------------------
// core 版との一致（代表ケース）
// shapePayload 版が src/core/shapeStyle.ts と同一ロジックで動くことを確認。
// ---------------------------------------------------------------------------

describe('shapeSvgGeometry – core 版と一致する代表ケース', () => {
  const w = 1920;
  const h = 1080;

  it('line: x1/y1/x2/y2 をピクセル展開する', () => {
    const s = { kind: 'line' as const, x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9 };
    const g = shapeSvgGeometry(s, w, h);
    expect(g.x1).toBeCloseTo(0.1 * w);
    expect(g.y1).toBeCloseTo(0.2 * h);
    expect(g.x2).toBeCloseTo(0.8 * w);
    expect(g.y2).toBeCloseTo(0.9 * h);
  });

  it('ellipse: 中心座標が 2 点の中点になる', () => {
    const s = { kind: 'ellipse' as const, x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.7 };
    const g = shapeSvgGeometry(s, w, h);
    // cx = (0.2+0.6)/2 * 1920 = 0.4 * 1920 = 768
    expect(g.cx).toBeCloseTo(((s.x1 + s.x2) / 2) * w);
    // cy = (0.3+0.7)/2 * 1080 = 0.5 * 1080 = 540
    expect(g.cy).toBeCloseTo(((s.y1 + s.y2) / 2) * h);
  });

  it('ellipse: 半径が |x2-x1|/2 * w, |y2-y1|/2 * h になる', () => {
    const s = { kind: 'ellipse' as const, x1: 0.2, y1: 0.3, x2: 0.6, y2: 0.7 };
    const g = shapeSvgGeometry(s, w, h);
    expect(g.rx).toBeCloseTo((Math.abs(s.x2 - s.x1) / 2) * w);
    expect(g.ry).toBeCloseTo((Math.abs(s.y2 - s.y1) / 2) * h);
  });

  it('rect: 寸法が |x2-x1|*w x |y2-y1|*h になる', () => {
    const s = { kind: 'rect' as const, x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.8 };
    const g = shapeSvgGeometry(s, w, h);
    expect(g.rectW).toBeCloseTo(Math.abs(s.x2 - s.x1) * w);
    expect(g.rectH).toBeCloseTo(Math.abs(s.y2 - s.y1) * h);
  });

  it('rect: rectX/rectY が min(p1,p2) になる（右→左の描画でも正しい）', () => {
    const s = { kind: 'rect' as const, x1: 0.8, y1: 0.9, x2: 0.2, y2: 0.3 };
    const g = shapeSvgGeometry(s, w, h);
    expect(g.rectX).toBeCloseTo(Math.min(0.8, 0.2) * w);
    expect(g.rectY).toBeCloseTo(Math.min(0.9, 0.3) * h);
  });
});

// ---------------------------------------------------------------------------
// thicknessToPx
// ---------------------------------------------------------------------------

describe('thicknessToPx – core 版と一致する代表ケース', () => {
  const h = 1080;

  it('thin: 0.5% rounded, min 1', () => {
    expect(thicknessToPx('thin', h)).toBe(Math.max(1, Math.round(h * 0.005)));
  });

  it('medium: 1.0% rounded', () => {
    expect(thicknessToPx('medium', h)).toBe(Math.max(1, Math.round(h * 0.01)));
  });

  it('thick: 1.6% rounded', () => {
    expect(thicknessToPx('thick', h)).toBe(Math.max(1, Math.round(h * 0.016)));
  });

  it('min 1 even for frameHeight=0', () => {
    expect(thicknessToPx('thin', 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fadeOpacity
// ---------------------------------------------------------------------------

describe('fadeOpacity – core 版と一致する代表ケース', () => {
  it('duration<=0 は 0 を返す', () => {
    expect(fadeOpacity(0, 0, 8)).toBe(0);
  });

  it('fadeFrames<=0 は常に 1', () => {
    expect(fadeOpacity(5, 60, 0)).toBe(1);
  });

  it('フェードイン中: frame/fadeFrames にクランプ', () => {
    // frame=4, fadeFrames=8 → 4/8 = 0.5
    expect(fadeOpacity(4, 60, 8)).toBeCloseTo(0.5);
  });

  it('中間（フェードなし区間）は 1', () => {
    expect(fadeOpacity(30, 60, 8)).toBe(1);
  });

  it('フェードアウト中: (duration-frame)/fadeFrames', () => {
    // duration=60, frame=56, fadeFrames=8 → (60-56)/8 = 0.5
    expect(fadeOpacity(56, 60, 8)).toBeCloseTo(0.5);
  });

  it('先頭フレーム（0）はフェードイン開始', () => {
    // 0/8 = 0
    expect(fadeOpacity(0, 60, 8)).toBeCloseTo(0);
  });
});
