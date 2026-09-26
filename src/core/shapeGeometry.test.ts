import { describe, expect, it } from 'vitest';
import { angleArcPath, angleDegrees, angleLabelPoint, shapePixelPoints, trianglePoints } from './shapeGeometry';

describe('angleDegrees', () => {
  it('直角・鋭角・鈍角・直線を実寸で求める', () => {
    expect(angleDegrees({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(90, 6);
    expect(angleDegrees({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 })).toBeCloseTo(45, 6);
    expect(angleDegrees({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: -10, y: 10 })).toBeCloseTo(135, 6);
    expect(angleDegrees({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(180, 6);
  });
  it('辺の長さが 0 のときは 0 を返す（描画側が読み取り値を出さない判断に使う）', () => {
    expect(angleDegrees({ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 10, y: 5 })).toBe(0);
  });
});

describe('shapePixelPoints', () => {
  it('横長と縦長で同じ正規化座標が別の角度になる（実寸で計算する根拠）', () => {
    const s = { x1: 0.5, y1: 0.5, x2: 0.75, y2: 0.5, x3: 0.75, y3: 0.75 };
    const wide = shapePixelPoints(s, 1920, 1080), tall = shapePixelPoints(s, 1080, 1920);
    expect(angleDegrees(wide.p1, wide.p2, wide.p3)).toBeCloseTo(Math.atan2(270, 480) * 180 / Math.PI, 6);
    expect(angleDegrees(tall.p1, tall.p2, tall.p3)).toBeCloseTo(Math.atan2(480, 270) * 180 / Math.PI, 6);
    expect(angleDegrees(wide.p1, wide.p2, wide.p3)).not.toBeCloseTo(angleDegrees(tall.p1, tall.p2, tall.p3), 3);
    // 正規化座標のまま（非等方スケール抜き）だと両方 45° になってしまう — 実寸で計算する根拠。
    expect(angleDegrees(wide.p1, wide.p2, wide.p3)).not.toBeCloseTo(45, 3);
    expect(angleDegrees(tall.p1, tall.p2, tall.p3)).not.toBeCloseTo(45, 3);
  });
});

describe('trianglePoints', () => {
  it('2 点の箱に内接する上向き二等辺三角形を返す', () => {
    expect(trianglePoints(10, 100, 50, 20)).toEqual([{ x: 30, y: 20 }, { x: 50, y: 100 }, { x: 10, y: 100 }]);
  });
  it('点の順序が逆でも同じ三角形になる', () => {
    expect(trianglePoints(50, 20, 10, 100)).toEqual(trianglePoints(10, 100, 50, 20));
  });
});

describe('angleArcPath / angleLabelPoint', () => {
  it('頂点から半径 r の円弧を、2 辺の間に描く', () => {
    const path = angleArcPath({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, 5);
    expect(path).toBe('M 5 0 A 5 5 0 0 1 0 5');
  });
  it('読み取り値の置き場所は 2 辺の二等分線上・円弧の外側', () => {
    const at = angleLabelPoint({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, 5);
    expect(at.x).toBeCloseTo(at.y, 6);
    expect(Math.hypot(at.x, at.y)).toBeGreaterThan(5);
  });
});
