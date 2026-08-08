import { describe, it, expect } from 'vitest';
import {
  resolveSegmentLayout,
  hasPerSegmentLayout,
  activeSegmentIdAt,
  effectiveLayoutAt,
  segmentDiffersFromBase,
  playbackToOriginal,
  playbackFrameToOriginal,
} from './segmentLayout';
import { DEFAULT_MAIN_LAYOUT } from './mainLayout';
import type { MainLayout, SegmentLayout } from './types';

const base: MainLayout = { ...DEFAULT_MAIN_LAYOUT };
const seg: SegmentLayout = { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false };

describe('resolveSegmentLayout', () => {
  it('個別指定があればそれ(背景は全体から)', () => {
    const r = resolveSegmentLayout({ ...base, background: '#123456' }, { 3: seg }, 3);
    expect(r).toEqual({ ...seg, background: '#123456' });
  });
  it('個別指定が無ければ全体ベース', () => {
    expect(resolveSegmentLayout(base, { 3: seg }, 9)).toEqual(base);
  });
});

describe('hasPerSegmentLayout', () => {
  it('全体と異なる区間があれば true', () => { expect(hasPerSegmentLayout(base, { 3: seg })).toBe(true); });
  it('個別指定ゼロなら false', () => { expect(hasPerSegmentLayout(base, {})).toBe(false); });
  it('全体と同一内容の冗長エントリのみなら false', () => {
    const redundant: SegmentLayout = { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false };
    expect(hasPerSegmentLayout(base, { 3: redundant })).toBe(false);
  });
});

describe('segmentDiffersFromBase', () => {
  it('全体と同一内容なら false', () => {
    const same: SegmentLayout = { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false };
    expect(segmentDiffersFromBase(base, same)).toBe(false);
  });
  it('position が異なれば true', () => {
    expect(segmentDiffersFromBase(base, seg)).toBe(true);
  });
  it('flip が異なれば true', () => {
    const flipped: SegmentLayout = { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: true, flipV: false };
    expect(segmentDiffersFromBase(base, flipped)).toBe(true);
  });
});

describe('activeSegmentIdAt', () => {
  const ranges = [ { id: 1, start: 0, end: 100 }, { id: 2, start: 100, end: 250 } ];
  it('区間内の frame は該当 id', () => { expect(activeSegmentIdAt(50, ranges)).toBe(1); expect(activeSegmentIdAt(100, ranges)).toBe(2); });
  it('末尾は排他(end は含まない)', () => { expect(activeSegmentIdAt(99, ranges)).toBe(1); expect(activeSegmentIdAt(249, ranges)).toBe(2); });
  it('範囲外は null', () => { expect(activeSegmentIdAt(300, ranges)).toBeNull(); expect(activeSegmentIdAt(-1, ranges)).toBeNull(); });
});

describe('effectiveLayoutAt', () => {
  const kept = [ { id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }, { id: 2, originalStart: 100, playbackStart: 100, playbackEnd: 250 } ];
  it('区間 2 に個別指定があればそのフレームで反映', () => {
    const l = effectiveLayoutAt(120, kept, base, { 2: seg }, false);
    expect(l).toEqual({ ...seg, background: base.background });
  });
  it('区間 1 は個別指定なし→全体ベース', () => {
    expect(effectiveLayoutAt(10, kept, base, { 2: seg }, false)).toEqual(base);
  });
  it('hasOverlap のときは区間指定を無視し全体ベース(Plan 3 まで非対応)', () => {
    expect(effectiveLayoutAt(120, kept, base, { 2: seg }, true)).toEqual(base);
  });
});

describe('effectiveLayoutAt × motion（メイン動画の2点アニメ）', () => {
  const base = { position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: false };
  const kept = [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }];

  it('motion 付き区間は進行度で scale が補間される（zoomIn・強さ0.5）', () => {
    const layouts = { 1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false, motion: { preset: 'zoomIn' as const, intensity: 0.5 } } };
    expect(effectiveLayoutAt(0, kept, base, layouts, false).scale).toBe(1);
    // 区間終端は排他的（frame < end）なので end-1 でほぼ 1.4 に到達する
    expect(effectiveLayoutAt(99, kept, base, layouts, false).scale).toBeCloseTo(1.4, 3);
    expect(effectiveLayoutAt(50, kept, base, layouts, false).scale).toBeCloseTo(1.2);
  });

  it('motion 無し区間・区間外は従来どおり', () => {
    const layouts = { 1: { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false } };
    expect(effectiveLayoutAt(50, kept, base, layouts, false).scale).toBe(2);
    expect(effectiveLayoutAt(999, kept, base, layouts, false)).toEqual(base);
  });

  it('motion 付きエントリは segmentDiffersFromBase で常に true（剪定されない）', () => {
    const s = { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false, motion: { preset: 'zoomIn' as const } };
    expect(segmentDiffersFromBase(base, s)).toBe(true);
  });
});

describe('effectiveLayoutAt × layoutKeyframes（大域配列・カット区間を無視して駆動）', () => {
  const base = { position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: false };
  const kept = [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }];
  const layouts = { 1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false } };
  const kfs = [
    { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    { originalFrame: 99, x: 1, y: 0, scale: 3, rotation: 0 },
  ];

  it('区間頭は先頭キーフレーム、末尾付近は終端キーフレームへ収束する', () => {
    expect(effectiveLayoutAt(0, kept, base, layouts, false, kfs).scale).toBe(1);
    expect(effectiveLayoutAt(99, kept, base, layouts, false, kfs).scale).toBeCloseTo(3, 3);
  });

  it('motion と layoutKeyframes が両方指定された場合は layoutKeyframes（大域）を優先する', () => {
    const layoutsWithMotion = {
      1: { ...layouts[1], motion: { preset: 'zoomIn' as const, intensity: 0.5 } },
    };
    const l = effectiveLayoutAt(99, kept, base, layoutsWithMotion, false, kfs);
    expect(l.scale).toBeCloseTo(3, 3);
  });

  it('layoutKeyframes 未指定・空・1点以下なら従来どおり（motion or 個別指定）へフォールバック', () => {
    expect(effectiveLayoutAt(50, kept, base, layouts, false)).toEqual({ ...layouts[1], background: base.background });
    expect(effectiveLayoutAt(50, kept, base, layouts, false, [])).toEqual({ ...layouts[1], background: base.background });
    expect(effectiveLayoutAt(50, kept, base, layouts, false, [kfs[0]!])).toEqual({ ...layouts[1], background: base.background });
  });

  it('hasOverlap では layoutKeyframes 指定があっても base のまま', () => {
    expect(effectiveLayoutAt(50, kept, base, layouts, true, kfs)).toEqual(base);
  });

  it('区間境界を跨いでも originalFrame 空間で連続補間される（区間ごとの進行度リセットが無い）', () => {
    // 隙間の無いカット（originalStart が連続）では、旧・区間ごとリセットモデルなら
    // playback 49→50 の境界で進行度が 1→0 に瞬間リセットされ x が大きく戻っていたが、
    // 大域KFは originalFrame の連続関数なので、境界を挟んでも滑らかに単調変化する。
    const twoSeg = [
      { id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 50 },
      { id: 2, originalStart: 50, playbackStart: 50, playbackEnd: 100 },
    ];
    const globalKfs = [
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 99, x: 1, y: 0, scale: 1, rotation: 0 },
    ];
    const before = effectiveLayoutAt(49, twoSeg, base, {}, false, globalKfs).position.x;
    const at = effectiveLayoutAt(50, twoSeg, base, {}, false, globalKfs).position.x;
    const after = effectiveLayoutAt(51, twoSeg, base, {}, false, globalKfs).position.x;
    expect(at).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(at);
    // 隣接フレーム間の変化量は小さい（段差ではなく連続補間の1フレーム分の変化）。
    expect(at - before).toBeLessThan(0.05);
    expect(after - at).toBeLessThan(0.05);
  });

  it('KFは最初〜最後の範囲内だけ効く: 範囲前は従来の見た目（全体レイアウト）に戻る', () => {
    // KF が [30, 60] の区間だけを覆う場合、frame 0（範囲前）は base のまま。
    // 旧実装は先頭KF値でクランプし全体レイアウト(scale等)を乗っ取っていた。
    const zoomBase = { ...base, scale: 1.45 };
    const rangedKfs = [
      { originalFrame: 30, x: 0, y: 0, scale: 1.45, rotation: 0 },
      { originalFrame: 60, x: 0, y: 0, scale: 2.6, rotation: 0 },
    ];
    expect(effectiveLayoutAt(0, kept, zoomBase, {}, false, rangedKfs)).toEqual(zoomBase);
    expect(effectiveLayoutAt(99, kept, zoomBase, {}, false, rangedKfs)).toEqual(zoomBase);
    // 範囲内は KF が駆動する。
    expect(effectiveLayoutAt(60, kept, zoomBase, {}, false, rangedKfs).scale).toBeCloseTo(2.6, 3);
  });

  it('KF範囲外では区間ごとの motion / 個別レイアウトが生きる（共存）', () => {
    const rangedKfs = [
      { originalFrame: 70, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 90, x: 0, y: 0, scale: 2, rotation: 0 },
    ];
    const layoutsWithMotion = {
      1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false, motion: { preset: 'zoomIn' as const, intensity: 0.5 } },
    };
    // frame 50 は KF 範囲(70..90)の外 → 区間 motion (zoomIn) が効く（scale > 1）。
    const outside = effectiveLayoutAt(50, kept, base, layoutsWithMotion, false, rangedKfs);
    expect(outside.scale).toBeGreaterThan(1);
    // frame 80 は KF 範囲内 → KF が優先（線形+ease補間で 1..2 の間）。
    const inside = effectiveLayoutAt(80, kept, base, layoutsWithMotion, false, rangedKfs);
    expect(inside.scale).toBeGreaterThan(1);
    expect(inside.scale).toBeLessThanOrEqual(2);
  });
});

describe('playbackFrameToOriginal', () => {
  const kept = [
    { originalStart: 0, playbackStart: 0, playbackEnd: 100 },
    { originalStart: 300, playbackStart: 100, playbackEnd: 160 },
  ];
  it('区間内は 1:1 で写す', () => {
    expect(playbackFrameToOriginal(0, kept)).toBe(0);
    expect(playbackFrameToOriginal(50, kept)).toBe(50);
    expect(playbackFrameToOriginal(120, kept)).toBe(320);
  });
  it('先頭より前・末尾より後は最寄りの端でクランプ', () => {
    expect(playbackFrameToOriginal(-10, kept)).toBe(0);
    expect(playbackFrameToOriginal(999, kept)).toBe(360);
  });
  it('keptSegments が空なら恒等', () => {
    expect(playbackFrameToOriginal(50, [])).toBe(50);
  });
});

describe('playbackToOriginal（cutEngine からの再輸出）', () => {
  it('KeyframeMarkers 等の呼び出し元が segmentLayout から直接 import できる', () => {
    expect(typeof playbackToOriginal).toBe('function');
    expect(playbackToOriginal(50, [])).toBe(50);
  });
});
