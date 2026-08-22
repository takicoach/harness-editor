import { describe, it, expect } from 'vitest';
import { applyCuts, cutRegionsFromCutData, originalToPlayback, playbackToOriginal } from './cutEngine';
import {
  buildCutOrdering,
  cutOrderFromCutData,
  reorderSe,
  reorderStartEnd,
  unreorderSe,
  unreorderStartEnd,
} from './cutOrder';
import { parseCutData } from './cutData';
import {
  CUT_DATA_REORDERED_SOURCE,
  EXPECTED_PLAYBACK_ORDER,
} from './__fixtures__/cutDataReordered.fixture';
import type { CutSegment } from './types';

const TOTAL = 11228;

function reorderedOrdering(): ReturnType<typeof buildCutOrdering> {
  const cutData = parseCutData(CUT_DATA_REORDERED_SOURCE);
  const regions = cutRegionsFromCutData(cutData, TOTAL);
  return buildCutOrdering(TOTAL, regions, cutOrderFromCutData(cutData));
}

describe('cutOrderFromCutData', () => {
  it('cutData.ts の配列を再生順（playbackStart 昇順）のアンカーへ写す', () => {
    const cutData = parseCutData(CUT_DATA_REORDERED_SOURCE);
    const anchors = cutOrderFromCutData(cutData);
    expect(anchors).toHaveLength(14);
    expect(anchors[0]).toEqual({ originalStart: 378, originalEnd: 589 });
    // 再生順 6 番目が原素材 602-1383（＝原素材順なら 2 番目）。
    expect(anchors[5]).toEqual({ originalStart: 602, originalEnd: 1383 });
  });

  it('配列が再生順に並んでいなくても playbackStart で並べ直す', () => {
    const cuts: CutSegment[] = [
      { id: 2, originalStart: 0, originalEnd: 10, playbackStart: 5, playbackEnd: 15 },
      { id: 1, originalStart: 50, originalEnd: 55, playbackStart: 0, playbackEnd: 5 },
    ];
    expect(cutOrderFromCutData(cuts)).toEqual([
      { originalStart: 50, originalEnd: 55 },
      { originalStart: 0, originalEnd: 10 },
    ]);
  });
});

describe('buildCutOrdering', () => {
  it('恒等順列なら identity=true で applyCuts の出力そのもの（従来経路と同一）', () => {
    const regions = [{ start: 100, end: 200 }];
    const expected = applyCuts(1000, regions);
    const anchors = cutOrderFromCutData(expected);
    const ordering = buildCutOrdering(1000, regions, anchors);
    expect(ordering.identity).toBe(true);
    expect(ordering.segments).toEqual(expected);
  });

  it('アンカー未指定（cutData.ts 不在）でも identity=true', () => {
    const ordering = buildCutOrdering(1000, [{ start: 100, end: 200 }], undefined);
    expect(ordering.identity).toBe(true);
    expect(ordering.segments).toEqual(applyCuts(1000, [{ start: 100, end: 200 }]));
  });

  it('並び替えプロジェクトを再生順へ並べ、playbackStart/End を並び順で再計算する', () => {
    const ordering = reorderedOrdering();
    expect(ordering.identity).toBe(false);
    expect(
      ordering.segments.map((s) => ({
        originalStart: s.originalStart,
        originalEnd: s.originalEnd,
        playbackStart: s.playbackStart,
        playbackEnd: s.playbackEnd,
      })),
    ).toEqual(EXPECTED_PLAYBACK_ORDER);
    // id は再生順に振り直す（cutData.ts の慣習＝配列順に 1..n）。
    expect(ordering.segments.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('隣接アンカー間のカットを解除して融合しても、融合区間は先頭側の rank に留まる', () => {
    const cutData = parseCutData(CUT_DATA_REORDERED_SOURCE);
    const anchors = cutOrderFromCutData(cutData);
    const regions = cutRegionsFromCutData(cutData, TOTAL)
      // 13 フレームのカット [589,602) を解除して [378,589) と [602,1383) を融合させる。
      .filter((r) => !(r.start === 589 && r.end === 602));
    const ordering = buildCutOrdering(TOTAL, regions, anchors);
    expect(ordering.segments[0]).toMatchObject({ originalStart: 378, originalEnd: 1383, playbackStart: 0 });
  });

  it('どのアンカーにも重ならない新出区間は原素材順で近傍へ挿入する', () => {
    // アンカー: [200,300) → [0,100) の 2 区間（並び替えあり）。
    const anchors = [
      { originalStart: 200, originalEnd: 300 },
      { originalStart: 0, originalEnd: 100 },
    ];
    // 新たに [400,500) が素材として増えた（カット解除）状態。
    const regions = [
      { start: 100, end: 200 },
      { start: 300, end: 400 },
    ];
    const ordering = buildCutOrdering(500, regions, anchors);
    // [400,500) はアンカー不明。原素材順で直前の [200,300) の直後へ挿す。
    expect(ordering.segments.map((s) => s.originalStart)).toEqual([200, 400, 0]);
  });
});

describe('並び替え対応のフレーム写像', () => {
  it('原素材→再生: 並び替え後の位置を返す', () => {
    const o = reorderedOrdering();
    const regions = cutRegionsFromCutData(parseCutData(CUT_DATA_REORDERED_SOURCE), TOTAL);
    // 原素材 602 は再生 875（再生順 5 番目の先頭）。
    expect(originalToPlayback(602, regions, o)).toBe(875);
    expect(originalToPlayback(700, regions, o)).toBe(875 + 98);
    // 区間の直前フレーム（別の再生位置）
    expect(originalToPlayback(378, regions, o)).toBe(0);
    // カット区間内は null（従来と同じ）
    expect(originalToPlayback(1500, regions, o)).toBeNull();
  });

  it('再生→原素材: 並び替えを逆に辿る', () => {
    const o = reorderedOrdering();
    const regions = cutRegionsFromCutData(parseCutData(CUT_DATA_REORDERED_SOURCE), TOTAL);
    expect(playbackToOriginal(875, regions, o)).toBe(602);
    expect(playbackToOriginal(973, regions, o)).toBe(700);
    // 直前フレームは別の原素材位置（再生順 4 番目 [2661,2788) の末尾）
    expect(playbackToOriginal(874, regions, o)).toBe(2787);
    // 先頭・末尾
    expect(playbackToOriginal(0, regions, o)).toBe(378);
    expect(playbackToOriginal(3271, regions, o)).toBe(11024);
  });

  it('ordering 未指定なら従来（単調）の写像と完全に一致する', () => {
    const regions = [{ start: 100, end: 200 }];
    for (const f of [0, 99, 100, 200, 300]) {
      expect(originalToPlayback(f, regions, undefined)).toBe(originalToPlayback(f, regions));
      expect(playbackToOriginal(f, regions, undefined)).toBe(playbackToOriginal(f, regions));
    }
  });
});

describe('要素の再生座標の並び替え（stage 変換）', () => {
  it('区間内に収まる要素は区間ごと平行移動する（往復で元に戻る）', () => {
    const o = reorderedOrdering();
    // 単調モデルでの再生座標: 原素材 602-1383 は単調では 211-992。
    const items = [{ id: 1, startFrame: 211, endFrame: 992 }];
    const moved = reorderStartEnd(items, o);
    expect(moved[0]).toMatchObject({ startFrame: 875, endFrame: 1656 });
    expect(unreorderStartEnd(moved, o)).toEqual(items);
  });

  it('endFrame 省略可能な要素（SE）も同じ規則で写る', () => {
    const o = reorderedOrdering();
    const items = [{ id: 1, startFrame: 211, endFrame: undefined }];
    const moved = reorderSe(items, o);
    expect(moved[0]!.startFrame).toBe(875);
    expect(moved[0]!.endFrame).toBeUndefined();
    expect(unreorderSe(moved, o)).toEqual(items);
  });

  it('恒等順列では同一参照を返す（従来出力とバイト同値を保証する）', () => {
    const regions = [{ start: 100, end: 200 }];
    const o = buildCutOrdering(1000, regions, undefined);
    const items = [{ id: 1, startFrame: 10, endFrame: 20 }];
    expect(reorderStartEnd(items, o)).toBe(items);
    expect(unreorderStartEnd(items, o)).toBe(items);
    expect(reorderSe(items, o)).toBe(items);
    expect(unreorderSe(items, o)).toBe(items);
  });

  it('区間をまたぐ要素は連続する区間の末尾で打ち切る（end<start の逆転を防ぐ）', () => {
    const o = reorderedOrdering();
    // 単調 211（原素材 602）開始 → 単調 1000（原素材 1791＝別の再生位置）終了。
    const moved = reorderStartEnd([{ id: 1, startFrame: 211, endFrame: 1000 }], o);
    expect(moved[0]!.endFrame).toBe(1656); // 再生順 5 番目の末尾
    expect(moved[0]!.startFrame).toBeLessThan(moved[0]!.endFrame);
  });

  it('順方向でも不連続にまたぐ要素は開始 run の末尾で打ち切る（保存方向）', () => {
    const o = reorderedOrdering();
    // 単調 200（1 番目 [378,589) の中）→ 単調 250（原素材順で次の [602,1383) の中）。
    // 並び替え後は両者が離れているため、素通しすると間の無関係な区間を丸呑みする。
    const moved = reorderStartEnd([{ id: 1, startFrame: 200, endFrame: 250 }], o);
    expect(moved[0]).toMatchObject({ startFrame: 200, endFrame: 211 });
  });

  it('順方向でも不連続にまたぐ要素は開始 run の末尾で打ち切る（読込方向）', () => {
    const o = reorderedOrdering();
    // 再生 1600（5 番目 [602,1383) の中）→ 再生 1700（6 番目 [4517,5275) の中）。
    const moved = unreorderStartEnd([{ id: 1, startFrame: 1600, endFrame: 1700 }], o);
    expect(moved[0]).toMatchObject({ startFrame: 936, endFrame: 992 });
  });
});
