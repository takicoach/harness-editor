import { describe, it, expect } from 'vitest';
import { layoutSegmentRanges, activeLayoutSegmentIdAt, effectiveLayoutAtFrame } from './layoutSegments';
import { speedSegments } from '../speedPayload/speedSegments';
import type { CutSegmentLite, Layout, SegmentLayout } from './types';

const CUTS: CutSegmentLite[] = [
  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 300, originalEnd: 360, playbackStart: 100, playbackEnd: 160 },
  { id: 3, originalStart: 500, originalEnd: 540, playbackStart: 160, playbackEnd: 200 },
];
const base: Layout = { position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 0, flipH: false, flipV: false };
const seg: SegmentLayout = { position: { x: 0.5, y: 0 }, scale: 2, rotation: 0, flipH: false, flipV: false };

describe('layoutSegmentRanges', () => {
  it('等速（mainSpeed=1）はカット再生座標そのまま', () => {
    expect(layoutSegmentRanges(CUTS, 1)).toEqual([
      { id: 1, start: 0, end: 100 },
      { id: 2, start: 100, end: 160 },
      { id: 3, start: 160, end: 200 },
    ]);
  });
  it('一律速度は speedSegments の from/dur と一致（書き出しベースと同一配置）', () => {
    const ranges = layoutSegmentRanges(CUTS, 0.5);
    const segs = speedSegments(CUTS, 0.5);
    ranges.forEach((r, i) => {
      expect(r.start).toBe(segs[i]!.from);
      expect(r.end).toBe(segs[i]!.from + segs[i]!.durationInFrames);
    });
  });
  it('区間ごと速度でも speedSegments の from/dur と一致', () => {
    const ss = { 1: 0.5, 3: 2 };
    const ranges = layoutSegmentRanges(CUTS, 1, ss);
    const segs = speedSegments(CUTS, 1, ss);
    ranges.forEach((r, i) => {
      expect(r.start).toBe(segs[i]!.from);
      expect(r.end).toBe(segs[i]!.from + segs[i]!.durationInFrames);
    });
  });
  it('空 cutData は空配列', () => { expect(layoutSegmentRanges([], 1)).toEqual([]); });
});

describe('activeLayoutSegmentIdAt', () => {
  const ranges = layoutSegmentRanges(CUTS, 1);
  it('区間内の frame は該当 id（start 含む / end 排他）', () => {
    expect(activeLayoutSegmentIdAt(0, ranges)).toBe(1);
    expect(activeLayoutSegmentIdAt(99, ranges)).toBe(1);
    expect(activeLayoutSegmentIdAt(100, ranges)).toBe(2);
    expect(activeLayoutSegmentIdAt(199, ranges)).toBe(3);
  });
  it('範囲外は null', () => {
    expect(activeLayoutSegmentIdAt(200, ranges)).toBeNull();
    expect(activeLayoutSegmentIdAt(-1, ranges)).toBeNull();
  });
});

describe('effectiveLayoutAtFrame', () => {
  const ranges = layoutSegmentRanges(CUTS, 1);
  it('個別指定のある区間フレームはその上書き（背景は base から）', () => {
    expect(effectiveLayoutAtFrame(120, { ...base, background: '#123456' }, { 2: seg }, ranges, CUTS)).toEqual({ ...seg, background: '#123456' });
  });
  it('個別指定の無い区間は base', () => {
    expect(effectiveLayoutAtFrame(10, base, { 2: seg }, ranges, CUTS)).toEqual(base);
  });
  it('区間外（範囲外 frame）は base', () => {
    expect(effectiveLayoutAtFrame(999, base, { 2: seg }, ranges, CUTS)).toEqual(base);
  });
});

describe('effectiveLayoutAtFrame × motion（書き出し側の2点アニメ）', () => {
  it('motion 付き区間はエディタ core と同じ値で補間される', async () => {
    const { effectiveLayoutAtFrame } = await import('./layoutSegments');
    const base = { position: { x: 0, y: 0 }, scale: 1, background: '#000' };
    const layouts = { 1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false, motion: { preset: 'zoomIn' as const, intensity: 0.5 } } };
    const ranges = [{ id: 1, start: 0, end: 100 }];
    const cutData: CutSegmentLite[] = [{ id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 }];
    expect(effectiveLayoutAtFrame(0, base, layouts, ranges, cutData).scale).toBe(1);
    // 区間終端は排他的（frame < end）なので end-1 でほぼ 1.4 に到達する
    expect(effectiveLayoutAtFrame(99, base, layouts, ranges, cutData).scale).toBeCloseTo(1.4, 3);
    expect(effectiveLayoutAtFrame(50, base, layouts, ranges, cutData).scale).toBeCloseTo(1.2);
    // エディタ core（effectiveLayoutAt）と同値（プレビュー＝書き出し一致）
    const { effectiveLayoutAt } = await import('../../core/segmentLayout');
    const coreBase = { ...base, rotation: 0, flipH: false, flipV: false };
    const kept = [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }];
    for (const f of [0, 25, 50, 75, 100]) {
      expect(effectiveLayoutAtFrame(f, base, layouts, ranges, cutData).scale)
        .toBeCloseTo(effectiveLayoutAt(f, kept, coreBase, layouts, false).scale, 10);
    }
  });
});

describe('effectiveLayoutAtFrame × layoutKeyframes（大域配列・カット非依存・書き出し側）', () => {
  const base: Layout = { position: { x: 0, y: 0 }, scale: 1, background: '#000000', rotation: 0, flipH: false, flipV: false };
  const layouts: Record<number, SegmentLayout> = { 1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false } };
  const ranges = [{ id: 1, start: 0, end: 100 }];
  const cutData: CutSegmentLite[] = [{ id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 }];
  const kfs = [
    { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    { originalFrame: 99, x: 1, y: 0, scale: 3, rotation: 0 },
  ];

  it('layoutKeyframes が 2 点以上あれば原本フレームの進行度で補間する', () => {
    expect(effectiveLayoutAtFrame(0, base, layouts, ranges, cutData, kfs).scale).toBe(1);
    expect(effectiveLayoutAtFrame(99, base, layouts, ranges, cutData, kfs).scale).toBeCloseTo(3, 3);
  });

  it('motion と layoutKeyframes が両方あれば layoutKeyframes（大域）を優先する', () => {
    const withMotion = { 1: { ...layouts[1]!, motion: { preset: 'zoomIn' as const, intensity: 0.5 } } };
    expect(effectiveLayoutAtFrame(99, base, withMotion, ranges, cutData, kfs).scale).toBeCloseTo(3, 3);
  });

  it('layoutKeyframes 未指定/1点以下なら従来どおり', () => {
    expect(effectiveLayoutAtFrame(50, base, layouts, ranges, cutData)).toEqual({ ...layouts[1], background: base.background });
    expect(effectiveLayoutAtFrame(50, base, layouts, ranges, cutData, [kfs[0]!])).toEqual({ ...layouts[1], background: base.background });
  });

  it('エディタ core（effectiveLayoutAt）と同値（プレビュー＝書き出し一致）', async () => {
    const { effectiveLayoutAt } = await import('../../core/segmentLayout');
    const coreBase = { ...base, rotation: 0, flipH: false, flipV: false };
    const coreLayouts = { 1: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, flipH: false, flipV: false } };
    const kept = [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }];
    for (const f of [0, 25, 50, 75, 99]) {
      const server = effectiveLayoutAtFrame(f, base, layouts, ranges, cutData, kfs);
      const core = effectiveLayoutAt(f, kept, coreBase, coreLayouts, false, kfs);
      expect(server.scale).toBeCloseTo(core.scale, 10);
      expect(server.position.x).toBeCloseTo(core.position.x, 10);
    }
  });

  it('KFは最初〜最後の範囲内だけ効く: 範囲外は base / 区間motion に戻る（core と同ルール）', async () => {
    const zoomBase: Layout = { ...base, scale: 1.45 };
    const rangedKfs = [
      { originalFrame: 30, x: 0, y: 0, scale: 1.45, rotation: 0 },
      { originalFrame: 60, x: 0, y: 0, scale: 2.6, rotation: 0 },
    ];
    // 範囲前・範囲後は base（全体レイアウト）に戻る。
    expect(effectiveLayoutAtFrame(0, zoomBase, {}, ranges, cutData, rangedKfs).scale).toBe(1.45);
    expect(effectiveLayoutAtFrame(99, zoomBase, {}, ranges, cutData, rangedKfs).scale).toBe(1.45);
    // 範囲内は KF が駆動する。
    expect(effectiveLayoutAtFrame(60, zoomBase, {}, ranges, cutData, rangedKfs).scale).toBeCloseTo(2.6, 3);
    // core と全フレームで一致（範囲境界含む）。
    const { effectiveLayoutAt } = await import('../../core/segmentLayout');
    const kept = [{ id: 1, originalStart: 0, playbackStart: 0, playbackEnd: 100 }];
    const coreZoomBase = { ...zoomBase, rotation: 0, flipH: false, flipV: false };
    for (const f of [0, 29, 30, 45, 60, 61, 99]) {
      const server = effectiveLayoutAtFrame(f, zoomBase, {}, ranges, cutData, rangedKfs);
      const core = effectiveLayoutAt(f, kept, coreZoomBase, {}, false, rangedKfs);
      expect(server.scale).toBeCloseTo(core.scale, 10);
      expect(server.position.x).toBeCloseTo(core.position.x, 10);
    }
  });
});
