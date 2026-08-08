import { describe, it, expect } from 'vitest';
import { resolveTelopLayout, telopTransform } from './Telop';

// 各スタイルは fontSize/bottomOffset を props で受けるが既定が横動画向け。
// アダプタはプロジェクトのフォーマット（解像度のアスペクト比）から ハーネス標準の
// テロップ寸法（videoConfig.ts の TELOP_CONFIG_MAP と一致）を解決して渡す。
describe('resolveTelopLayout（フォーマット別テロップ寸法）', () => {
  it('縦(short) 1080x1920 → fontSize 56 / bottomOffset 200', () => {
    expect(resolveTelopLayout(1080, 1920)).toEqual({ fontSize: 56, bottomOffset: 200 });
  });

  it('横(youtube) 1920x1080 → fontSize 80 / bottomOffset 100', () => {
    expect(resolveTelopLayout(1920, 1080)).toEqual({ fontSize: 80, bottomOffset: 100 });
  });

  it('正方形(square) 1080x1080 → fontSize 66 / bottomOffset 140', () => {
    expect(resolveTelopLayout(1080, 1080)).toEqual({ fontSize: 66, bottomOffset: 140 });
  });
});

// position/scale を CSS transform へ。最終 remotion render でも位置/サイズが反映される。
// x は中心 50%、y はフォーマット連動の縦係数（1 - 2*bottomFrac）。short の bottomOffset=200/1920。
describe('telopTransform（position/scale → CSS transform）', () => {
  const SHORT_VCOEFF = 1 - 2 * (200 / 1920);

  it('position も scale も無ければ undefined', () => {
    expect(telopTransform(undefined, undefined, 1080, 1920)).toBeUndefined();
  });

  it('scale が 1 だけなら undefined（no-op）', () => {
    expect(telopTransform(undefined, 1, 1080, 1920)).toBeUndefined();
  });

  it('position {0,0} は translate(0%, 0%)', () => {
    expect(telopTransform({ x: 0, y: 0 }, undefined, 1080, 1920)).toBe('translate(0%, 0%)');
  });

  it('x は 50%・y は縦係数で換算する', () => {
    const vy = -1 * SHORT_VCOEFF * 100;
    expect(telopTransform({ x: 0.5, y: -1 }, undefined, 1080, 1920)).toBe(`translate(25%, ${vy}%)`);
  });

  it('position と scale を併用', () => {
    const vy = -0.5 * SHORT_VCOEFF * 100;
    expect(telopTransform({ x: 0, y: -0.5 }, 2, 1080, 1920)).toBe(`translate(0%, ${vy}%) scale(2)`);
  });
});
