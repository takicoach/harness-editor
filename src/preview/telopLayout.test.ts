import { describe, it, expect } from 'vitest';
import {
  telopBottomFrac,
  telopVCoeff,
  telopScaleOriginY,
  telopTransform,
} from './telopLayout';

describe('telopBottomFrac / telopVCoeff（フォーマット別）', () => {
  it('short(縦) は bottomFrac=200/1920, vCoeff=1-2*それ', () => {
    expect(telopBottomFrac(1080, 1920)).toBeCloseTo(200 / 1920, 9);
    expect(telopVCoeff(1080, 1920)).toBeCloseTo(1 - 2 * (200 / 1920), 9);
  });
  it('youtube(横) は bottomFrac=100/1080', () => {
    expect(telopBottomFrac(1920, 1080)).toBeCloseTo(100 / 1080, 9);
  });
  it('square は bottomFrac=140/1080', () => {
    expect(telopBottomFrac(1080, 1080)).toBeCloseTo(140 / 1080, 9);
  });
});

describe('telopScaleOriginY（下端基準の拡縮原点）', () => {
  it('short は (1 - bottomFrac)*100 ≒ 89.58%', () => {
    expect(telopScaleOriginY(1080, 1920)).toBeCloseTo((1 - 200 / 1920) * 100, 9);
  });
});

describe('telopTransform（position/scale → CSS transform）', () => {
  it('position も scale も無ければ undefined', () => {
    expect(telopTransform(undefined, undefined, 1080, 1920)).toBeUndefined();
  });
  it('scale が 1 だけなら undefined（no-op）', () => {
    expect(telopTransform(undefined, 1, 1080, 1920)).toBeUndefined();
  });
  it('y は縦係数で換算する（x は 50%）', () => {
    const vy = -1 * telopVCoeff(1080, 1920) * 100;
    expect(telopTransform({ x: 1, y: -1 }, undefined, 1080, 1920)).toBe(`translate(50%, ${vy}%)`);
  });
  it('position と scale を併用', () => {
    expect(telopTransform({ x: 0, y: 0 }, 1.5, 1080, 1920)).toBe('translate(0%, 0%) scale(1.5)');
  });
});
