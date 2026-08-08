import { describe, it, expect } from 'vitest';
import { speedSegments, speedCompositionDuration } from './speedSegments';
// payload は自己完結（出荷時 src/core 非依存）だが、本テストは出荷されない（*.test.* 除外）ため
// 正典 speedScale を import して「payload の inline scale ＝ speedEngine.speedScale」をロックできる。
import { speedScale } from '../../core/speedEngine';

const CUTS = [
  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 200, originalEnd: 260, playbackStart: 100, playbackEnd: 160 },
];

describe('speedSegments', () => {
  it('mainSpeed=1: endAt あり・playbackRate なし・等速尺', () => {
    const segs = speedSegments(CUTS, 1);
    expect(segs).toEqual([
      { from: 0, durationInFrames: 100, startFrom: 0, endAt: 100 },
      { from: 100, durationInFrames: 60, startFrom: 200, endAt: 260 },
    ]);
  });
  it('mainSpeed=0.5: 尺 2 倍・playbackRate=0.5・endAt なし・境界連続（隙間ゼロ）', () => {
    const segs = speedSegments(CUTS, 0.5);
    expect(segs[0]!).toEqual({ from: 0, durationInFrames: 200, startFrom: 0, playbackRate: 0.5 });
    expect(segs[1]!).toEqual({ from: 200, durationInFrames: 120, startFrom: 200, playbackRate: 0.5 });
    // 連続性: 前 from+dur == 次 from
    expect(segs[0]!.from + segs[0]!.durationInFrames).toBe(segs[1]!.from);
  });
  it('総尺は round(再生総尺/rate) と一致（speedScale 等価）', () => {
    const segs = speedSegments(CUTS, 0.5);
    const total = segs.reduce((s, x) => s + x.durationInFrames, 0);
    expect(total).toBe(320); // round(160/0.5)=320
  });
  it('空 cutData は空配列', () => {
    expect(speedSegments([], 0.5)).toEqual([]);
  });
  // プレビュー＝書き出しの等価ロック（最終レビュー I-1）。
  // 書き出しの SpeedPlayer（本関数）と、プレビューの applyMainSpeed / serialize の要素焼き込みは
  // どちらも「境界を個別に speedScale して from/尺を出し、playbackRate=r・startFrom=originalStart」で
  // 一致する。payload の inline scale が正典 speedScale から乖離したらここで落ちる。
  it.each([0.25, 0.5, 2, 4])('境界ジオメトリが正典 speedScale と一致（rate=%s）', (r) => {
    const segs = speedSegments(CUTS, r);
    const expected = CUTS.map((c) => ({
      from: speedScale(c.playbackStart, r),
      durationInFrames: Math.max(1, speedScale(c.playbackEnd, r) - speedScale(c.playbackStart, r)),
      startFrom: c.originalStart,
      playbackRate: r,
    }));
    expect(segs).toEqual(expected);
  });
});

describe('speedSegments per-segment (Plan 2)', () => {
  it('個別指定ゼロは uniform と同値（後方互換・引数 undefined / 空 / 冗長）', () => {
    const base = speedSegments(CUTS, 0.5);
    expect(speedSegments(CUTS, 0.5, {})).toEqual(base);
    expect(speedSegments(CUTS, 0.5, { 1: 0.5, 2: 0.5 })).toEqual(base); // 冗長＝uniform
  });
  it('区間ごと: 区間1=0.5x(尺200) 区間2=2x(尺30)・累積連続（隙間ゼロ）', () => {
    const segs = speedSegments(CUTS, 1, { 1: 0.5, 2: 2 });
    expect(segs[0]).toEqual({ from: 0, durationInFrames: 200, startFrom: 0, playbackRate: 0.5 });
    expect(segs[1]).toEqual({ from: 200, durationInFrames: 30, startFrom: 200, playbackRate: 2 });
    expect(segs[0]!.from + segs[0]!.durationInFrames).toBe(segs[1]!.from); // 連続
  });
  it('区間 rate===1 は endAt あり（等速・透明化回避）', () => {
    const segs = speedSegments(CUTS, 1, { 1: 1, 2: 2 });
    expect(segs[0]).toEqual({ from: 0, durationInFrames: 100, startFrom: 0, endAt: 100 });
    expect(segs[1]!.playbackRate).toBe(2);
    expect(segs[1]!.endAt).toBeUndefined();
  });
  it('speedCompositionDuration: 区間ごとは尺合計・uniform は round(total/r)', () => {
    expect(speedCompositionDuration(CUTS, 160, 1, { 1: 0.5, 2: 2 })).toBe(230); // 200+30
    expect(speedCompositionDuration(CUTS, 160, 0.5)).toBe(320); // round(160/0.5)
    expect(speedCompositionDuration(CUTS, 160, 0.5, {})).toBe(320);
  });
  it('cutData に無い id の個別指定は無視（uniform 扱い）', () => {
    // CUTS の id は 1,2。存在しない 99 だけ指定 → uniform と同値
    expect(speedSegments(CUTS, 0.5, { 99: 2 })).toEqual(speedSegments(CUTS, 0.5));
    expect(speedCompositionDuration(CUTS, 160, 0.5, { 99: 2 })).toBe(speedCompositionDuration(CUTS, 160, 0.5));
  });
  it('空 cutData は空配列・尺0', () => {
    expect(speedSegments([], 1, { 1: 2 })).toEqual([]);
    expect(speedCompositionDuration([], 0, 0.5)).toBe(0);
  });
});
