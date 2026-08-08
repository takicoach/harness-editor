import { describe, it, expect } from 'vitest';
import {
  thicknessToPx,
  fadeOpacity,
  pointerToVideoPoint,
  shapeSvgGeometry,
  SHAPE_COLORS,
  DEFAULT_SHAPE_COLOR,
} from './shapeStyle';

describe('shapeStyle', () => {
  it('SHAPE_COLORS は 6 色で既定は赤', () => {
    expect(SHAPE_COLORS).toHaveLength(6);
    expect(DEFAULT_SHAPE_COLOR).toBe('#FF3B30');
    expect(SHAPE_COLORS).toContain(DEFAULT_SHAPE_COLOR);
  });

  it('thicknessToPx は高さ比でフレーム高さに比例し最低 1', () => {
    expect(thicknessToPx('medium', 1080)).toBe(Math.round(1080 * 0.01));
    expect(thicknessToPx('thin', 1080)).toBeLessThan(thicknessToPx('thick', 1080));
    expect(thicknessToPx('medium', 10)).toBeGreaterThanOrEqual(1);
  });

  it('fadeOpacity は端で 0、中央で 1', () => {
    expect(fadeOpacity(0, 100, 8)).toBe(0);
    expect(fadeOpacity(50, 100, 8)).toBe(1);
    expect(fadeOpacity(100, 100, 8)).toBe(0);
    expect(fadeOpacity(4, 100, 8)).toBeCloseTo(0.5);
  });

  it('pointerToVideoPoint は 0..1 へ変換しクランプ', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 };
    expect(pointerToVideoPoint(200, 100, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(pointerToVideoPoint(0, 0, rect)).toEqual({ x: 0, y: 0 });
    expect(pointerToVideoPoint(9999, 9999, rect)).toEqual({ x: 1, y: 1 });
  });

  it('shapeSvgGeometry は楕円の中心と半径を出す', () => {
    const g = shapeSvgGeometry({ kind: 'ellipse', x1: 0, y1: 0, x2: 1, y2: 0.5 }, 100, 100);
    expect(g.cx).toBe(50);
    expect(g.cy).toBe(25);
    expect(g.rx).toBe(50);
    expect(g.ry).toBe(25);
    expect(g.rectW).toBe(100);
    expect(g.rectH).toBe(50);
  });
});
