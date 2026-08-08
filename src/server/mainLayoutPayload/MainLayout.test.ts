import { describe, it, expect } from 'vitest';
import { isIdentityLayout, layoutTransform, hasOverlapTransition, isFrameAwareLayout } from './MainLayout';
import type { CutSegmentLite, Layout } from './types';
import type { LayoutKeyframe } from './layoutSegments';

describe('layoutTransform', () => {
  it('中心原点の translate + rotate(0) + scale（core mainLayoutTransform と同一式）', () => {
    expect(
      layoutTransform({ position: { x: 0.5, y: -0.25 }, scale: 1.4, background: '#000000' }),
    ).toBe('translate(25%, -12.5%) rotate(0deg) scale(1.4, 1.4)');
  });
  it('恒等は translate(0%, 0%) rotate(0deg) scale(1, 1)', () => {
    expect(
      layoutTransform({ position: { x: 0, y: 0 }, scale: 1, background: '#000000' }),
    ).toBe('translate(0%, 0%) rotate(0deg) scale(1, 1)');
  });
  it('rotation は rotate(...)deg を出力', () => {
    expect(
      layoutTransform({
        position: { x: 0, y: 0 },
        scale: 1,
        background: '#000000',
        rotation: 45,
      }),
    ).toBe('translate(0%, 0%) rotate(45deg) scale(1, 1)');
  });
  it('flipH は sx が負スケール', () => {
    expect(
      layoutTransform({
        position: { x: 0, y: 0 },
        scale: 1.2,
        background: '#000000',
        flipH: true,
      }),
    ).toBe('translate(0%, 0%) rotate(0deg) scale(-1.2, 1.2)');
  });
  it('flipV は sy が負スケール', () => {
    expect(
      layoutTransform({
        position: { x: 0, y: 0 },
        scale: 1.2,
        background: '#000000',
        flipV: true,
      }),
    ).toBe('translate(0%, 0%) rotate(0deg) scale(1.2, -1.2)');
  });
  it('flipH+flipV 同時は両軸負スケール', () => {
    expect(
      layoutTransform({
        position: { x: 0, y: 0 },
        scale: 1,
        background: '#000000',
        flipH: true,
        flipV: true,
      }),
    ).toBe('translate(0%, 0%) rotate(0deg) scale(-1, -1)');
  });
  it('rotation/flipH/flipV 省略（旧導入プロジェクトの Layout 形）は 0/false 扱いで従来通り', () => {
    const legacy: Layout = { position: { x: 0.5, y: -0.25 }, scale: 1.4, background: '#000000' };
    expect(layoutTransform(legacy)).toBe('translate(25%, -12.5%) rotate(0deg) scale(1.4, 1.4)');
  });
});

describe('isIdentityLayout', () => {
  it('scale===1 && pos0,0 && rotation:0 && flip無し は恒等（背景不問）', () => {
    expect(
      isIdentityLayout({
        position: { x: 0, y: 0 },
        scale: 1,
        background: '#ffffff',
        rotation: 0,
        flipH: false,
        flipV: false,
      }),
    ).toBe(true);
  });
  it('rotation/flipH/flipV 省略（旧導入プロジェクトの Layout 形）でも恒等判定は従来通り', () => {
    expect(isIdentityLayout({ position: { x: 0, y: 0 }, scale: 1, background: '#ffffff' })).toBe(true);
  });
  it('scale≠1 は非恒等', () => {
    expect(isIdentityLayout({ position: { x: 0, y: 0 }, scale: 1.2, background: '#000000' })).toBe(false);
  });
  it('位置ずれは非恒等', () => {
    expect(isIdentityLayout({ position: { x: 0.3, y: 0 }, scale: 1, background: '#000000' })).toBe(false);
  });
  it('rotation≠0 は非恒等', () => {
    expect(
      isIdentityLayout({ position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 90 }),
    ).toBe(false);
  });
  it('flipH は非恒等', () => {
    expect(
      isIdentityLayout({ position: { x: 0, y: 0 }, scale: 1, background: '#000000', flipH: true }),
    ).toBe(false);
  });
  it('flipV は非恒等', () => {
    expect(
      isIdentityLayout({ position: { x: 0, y: 0 }, scale: 1, background: '#000000', flipV: true }),
    ).toBe(false);
  });
});

describe('hasOverlapTransition（M-1: overlap 系トランジション検出・core isOverlapKind と同式）', () => {
  it('crossfade / slide / wipe は overlap 系＝true', () => {
    expect(hasOverlapTransition([{ kind: 'crossfade' }])).toBe(true);
    expect(hasOverlapTransition([{ kind: 'slide' }])).toBe(true);
    expect(hasOverlapTransition([{ kind: 'wipe' }])).toBe(true);
  });
  it('fade 系（fadeBlack/fadeWhite/fadeColor）・空・未指定は false', () => {
    expect(hasOverlapTransition([{ kind: 'fadeBlack' }, { kind: 'fadeColor' }])).toBe(false);
    expect(hasOverlapTransition([])).toBe(false);
    expect(hasOverlapTransition(undefined)).toBe(false);
  });
});

describe('isFrameAwareLayout（M-1: overlap 系トランジション中はプレビュー同様 base 降格）', () => {
  const cut: CutSegmentLite[] = [{ id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 }];
  const kfs: LayoutKeyframe[] = [
    { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    { originalFrame: 90, x: 0.4, y: 0, scale: 1, rotation: 0 },
  ];
  it('大域KF 2 点＋カットあり＋トランジション無し → frame 対応（true）', () => {
    expect(isFrameAwareLayout(cut, {}, kfs, undefined)).toBe(true);
  });
  it('fade トランジションがあっても frame 対応（true）＝プレビューも hasOverlap=false で適用', () => {
    expect(isFrameAwareLayout(cut, {}, kfs, [{ kind: 'fadeBlack' }])).toBe(true);
  });
  it('overlap 系トランジション（crossfade）があると base 降格（false）＝プレビュー hasOverlap→base と一致', () => {
    expect(isFrameAwareLayout(cut, {}, kfs, [{ kind: 'crossfade' }])).toBe(false);
  });
  it('カット無しは常に false', () => {
    expect(isFrameAwareLayout([], {}, kfs, undefined)).toBe(false);
  });
  it('KF 1 点・個別指定無しは false（従来 base）', () => {
    expect(isFrameAwareLayout(cut, {}, [kfs[0]!], undefined)).toBe(false);
  });
});
