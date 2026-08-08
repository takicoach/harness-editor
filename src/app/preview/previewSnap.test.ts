import { describe, it, expect } from 'vitest';
import { snapAxis, snapPosition, SNAP_LINES, SNAP_THRESHOLD } from './previewSnap';

describe('SNAP_LINES', () => {
  it('中央 0 と三分割線 ±1/3 を持つ', () => {
    expect(SNAP_LINES).toEqual([-1 / 3, 0, 1 / 3]);
  });
});

describe('snapAxis', () => {
  it('しきい値内なら最寄りの吸着線へ吸い付く', () => {
    const r = snapAxis(0.02, SNAP_THRESHOLD);
    expect(r.value).toBe(0);
    expect(r.line).toBe(0);
  });

  it('しきい値外なら吸着せず元の値・line=null', () => {
    const r = snapAxis(0.2, SNAP_THRESHOLD);
    expect(r.value).toBe(0.2);
    expect(r.line).toBeNull();
  });

  it('三分割線へも吸着する', () => {
    const r = snapAxis(1 / 3 + 0.01, SNAP_THRESHOLD);
    expect(r.line).toBeCloseTo(1 / 3);
  });
});

describe('snapPosition', () => {
  it('x/y を独立に吸着しガイド線を返す', () => {
    const r = snapPosition({ x: 0.01, y: 0.5 });
    expect(r.position.x).toBe(0);
    expect(r.guideX).toBe(0);
    expect(r.position.y).toBe(0.5);
    expect(r.guideY).toBeNull();
  });
});
