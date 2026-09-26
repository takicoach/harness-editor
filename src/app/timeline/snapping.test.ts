import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSnapIndex,
  snapFrameIndexed,
  resetSnapIndexCache,
  type SnapIndex,
} from './snapping';
import type { EditorTelop, Transcript } from '../../core/types';
import { buildDisplayMap } from '../../core/timelineDisplayMap';

function transcript(): Transcript {
  // 30fps 想定。単語は ms。30 フレーム = 1000ms。
  return {
    durationMs: 10000,
    words: [
      { text: 'ゆる', start: 1000, end: 1500 }, // 30..45 フレーム
      { text: '素振り', start: 1500, end: 2000 }, // 45..60 フレーム
      // 2000..4000ms はギャップ（無音）= 60..120 フレーム
      { text: '2本', start: 4000, end: 4500 }, // 120..135 フレーム
    ],
    segments: [],
  };
}

function telops(): EditorTelop[] {
  return [
    { id: 1, originalStart: 30, originalEnd: 60, text: 'ゆる素振り' },
    { id: 2, originalStart: 120, originalEnd: 200, text: '2本ですね' },
  ];
}

function framesOf(index: SnapIndex): number[] {
  return Array.from(index.frames.slice(0, index.length));
}

beforeEach(resetSnapIndexCache);

describe('buildSnapIndex', () => {
  it('単語境界・テロップ境界・無音端を収集する（再生ヘッドは含めない）', () => {
    const index = buildSnapIndex(transcript(), telops(), 30);
    const frames = framesOf(index);
    // 単語境界（msToFrame round）: 30,45,45,60,120,135
    expect(frames).toContain(30);
    expect(frames).toContain(45);
    expect(frames).toContain(60);
    expect(frames).toContain(135);
    // テロップ境界: 30,60,120,200
    expect(frames).toContain(200);
    // 無音区間端（単語間ギャップ 60..120 の両端）
    const kinds = Array.from(index.kinds.slice(0, index.length));
    const silence = frames.filter((_f, i) => kinds[i] === 1);
    expect(silence).toContain(60);
    expect(silence).toContain(120);
    // 再生ヘッド（90）は索引に入らない。
    expect(frames).not.toContain(90);
  });

  it('フレーム昇順に並ぶ（二分探索の前提）', () => {
    const frames = framesOf(buildSnapIndex(transcript(), telops(), 30));
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]).toBeGreaterThanOrEqual(frames[i - 1] as number);
    }
  });

  it('単語が空でもテロップ境界は収集する', () => {
    const empty: Transcript = { durationMs: 0, words: [], segments: [] };
    const index = buildSnapIndex(empty, telops(), 30);
    expect(framesOf(index)).toEqual([30, 60, 120, 200]);
  });

  it('同一入力（参照同値）なら同じ索引オブジェクトを返す＝毎回作り直さない', () => {
    const t = transcript();
    const tl = telops();
    const a = buildSnapIndex(t, tl, 30);
    const b = buildSnapIndex(t, tl, 30);
    expect(b).toBe(a);
  });

  it('テロップ配列が別参照になったら作り直す（編集が反映される）', () => {
    const t = transcript();
    const a = buildSnapIndex(t, telops(), 30);
    const b = buildSnapIndex(t, telops(), 30);
    expect(b).not.toBe(a);
  });
});

describe('snapFrameIndexed（二分探索の境界）', () => {
  const index = (): SnapIndex =>
    buildSnapIndex(
      { durationMs: 0, words: [], segments: [] },
      [
        { id: 1, originalStart: 45, originalEnd: 120, text: 'a' },
        { id: 2, originalStart: 300, originalEnd: 400, text: 'b' },
      ],
      30,
    );

  it('境界1: 距離がしきい値ちょうどなら吸着する', () => {
    const r = snapFrameIndexed(50, index(), 5, undefined, null);
    expect(r.frame).toBe(45);
    expect(r.snapped?.kind).toBe('telop');
  });

  it('境界2: しきい値を 1 超えたら吸着しない（rawFrame をそのまま返す）', () => {
    const r = snapFrameIndexed(51, index(), 5, undefined, null);
    expect(r.frame).toBe(51);
    expect(r.snapped).toBeNull();
  });

  it('境界3: 索引の左端より手前・右端より後ろでも落ちない', () => {
    expect(snapFrameIndexed(0, index(), 5, undefined, null).snapped).toBeNull();
    expect(snapFrameIndexed(44, index(), 5, undefined, null).frame).toBe(45);
    expect(snapFrameIndexed(10000, index(), 5, undefined, null).snapped).toBeNull();
    expect(snapFrameIndexed(401, index(), 5, undefined, null).frame).toBe(400);
  });

  it('索引が空でも吸着しない（探索が破綻しない）', () => {
    const empty = buildSnapIndex({ durationMs: 0, words: [], segments: [] }, [], 30);
    const r = snapFrameIndexed(48, empty, 5, undefined, null);
    expect(r.frame).toBe(48);
    expect(r.snapped).toBeNull();
  });

  it('複数候補が範囲内なら最も近い方へ吸着する', () => {
    const r = snapFrameIndexed(118, index(), 20, undefined, null);
    expect(r.frame).toBe(120);
  });

  it('ラベルは吸着した 1 件だけ組む（単語なら単語名入り）', () => {
    // 46 の最寄りは 45（「ゆる」の終わり＝「素振り」の始まり）。同フレームは
    // 索引の並び順（先に積んだ方＝直前の単語）が勝つ＝従来の配列順と同じ。
    const r = snapFrameIndexed(46, buildSnapIndex(transcript(), [], 30), 3, undefined, null);
    expect(r.snapped?.kind).toBe('word');
    expect(r.snapped?.label).toBe('単語境界:「ゆる」');
  });
});

describe('snapFrameIndexed（再生ヘッド）', () => {
  const empty = (): SnapIndex =>
    buildSnapIndex({ durationMs: 0, words: [], segments: [] }, [], 30);

  it('索引に無い再生ヘッドへも吸着する', () => {
    const r = snapFrameIndexed(92, empty(), 5, undefined, 90);
    expect(r.frame).toBe(90);
    expect(r.snapped?.kind).toBe('playhead');
    expect(r.snapped?.label).toBe('再生ヘッド');
  });

  it('索引側の方が近ければそちらを選ぶ', () => {
    const idx = buildSnapIndex(
      { durationMs: 0, words: [], segments: [] },
      [{ id: 1, originalStart: 91, originalEnd: 200, text: 'a' }],
      30,
    );
    const r = snapFrameIndexed(92, idx, 5, undefined, 88);
    expect(r.frame).toBe(91);
    expect(r.snapped?.kind).toBe('telop');
  });

  it('playhead を null にすればヘッドは候補にならない', () => {
    expect(snapFrameIndexed(92, empty(), 5, undefined, null).snapped).toBeNull();
  });
});

describe('snapFrameIndexed（表示マップ）', () => {
  // id1: 原本 [0, 100) を speed 2x → 表示 [0, 50)
  const map = (): ReturnType<typeof buildDisplayMap> =>
    buildDisplayMap(100, [], [{ id: 1, originalStart: 0, originalEnd: 100 }], { 1: 2 }, 1);

  it('表示距離がしきい値内なら吸着する（原本距離は遠い）', () => {
    // 原本 50 → 表示 25、原本 90 → 表示 45。表示距離 20 ≦ しきい値 25。
    const idx = buildSnapIndex(
      { durationMs: 0, words: [], segments: [] },
      [{ id: 1, originalStart: 90, originalEnd: 99, text: 'a' }],
      30,
    );
    const r = snapFrameIndexed(50, idx, 25, map(), null);
    expect(r.frame).toBe(90);
    expect(r.snapped).not.toBeNull();
  });

  it('表示距離がしきい値外なら吸着しない（原本距離は近い）', () => {
    // 原本 50 → 表示 25、原本 56 → 表示 28。表示距離 3 > しきい値 2。
    const idx = buildSnapIndex(
      { durationMs: 0, words: [], segments: [] },
      [{ id: 1, originalStart: 56, originalEnd: 99, text: 'a' }],
      30,
    );
    const r = snapFrameIndexed(50, idx, 2, map(), null);
    expect(r.frame).toBe(50);
    expect(r.snapped).toBeNull();
  });
});
