import { describe, expect, it } from 'vitest';
import {
  mergeTelopWithNext,
  splitTelopAt,
  splitTelopWithText,
  toggleSegmentCut,
  toggleWordCut,
  resizeCutRegion,
  insertTelop,
  computeInsertSpan,
  cutRange,
  openCutRange,
  rangeOverlapsCut,
  addTelopAtFrame,
  addSubtitleAtFrame,
  subtitleInsertSpan,
  MIN_SUBTITLE_FRAMES,
  TELOP_DEFAULT_DURATION_SEC,
  cutButtonMode,
} from './cutOps';
import type { EditState } from './editState';
import type { WordChip } from '../../core/types';

function state(): EditState {
  return {
    telops: [
      { id: 1, originalStart: 30, originalEnd: 150, text: 'ゆる素振り' },
      { id: 2, originalStart: 200, originalEnd: 320, text: '長いアイアン2本ですね' },
    ],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    selection: null,
    multiTelopIds: [],
    nextTelopId: 3,
    nextSeId: 1,
    nextImageId: 1,
    nextVideoInsertId: 1,
    nextBgmId: 1,
    titles: [],
    nextTitleId: 1,
    shapes: [],
    nextShapeId: 1,
    sceneTransitions: [],
    nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const },
    mainSpeed: 1,
    segmentSpeeds: {},
    segmentLayouts: {}, layoutKeyframes: [],
  };
}

const chip = (s: number, e: number): WordChip => ({ text: 'x', originalStart: s, originalEnd: e });

describe('toggleWordCut', () => {
  it('未カットの単語チップを削除するとチップ区間が cutRegions へ追加される', () => {
    const next = toggleWordCut(state(), chip(50, 70));
    expect(next.cutRegions).toEqual([{ start: 50, end: 70 }]);
  });

  it('カット済みの単語チップを再トグルするとカットが解除される', () => {
    const cut = toggleWordCut(state(), chip(50, 70));
    const back = toggleWordCut(cut, chip(50, 70));
    expect(back.cutRegions).toEqual([]);
  });
});

describe('toggleSegmentCut', () => {
  it('セグメント行を削除するとセグメント区間まるごとが cutRegions へ追加される', () => {
    const next = toggleSegmentCut(state(), 1);
    expect(next.cutRegions).toEqual([{ start: 30, end: 150 }]);
  });

  it('カット済みセグメントを再トグルすると解除される', () => {
    const cut = toggleSegmentCut(state(), 1);
    const back = toggleSegmentCut(cut, 1);
    expect(back.cutRegions).toEqual([]);
  });

  it('存在しない ID はそのまま返す', () => {
    const before = state();
    expect(toggleSegmentCut(before, 999).cutRegions).toEqual([]);
  });
});

describe('splitTelopAt', () => {
  it('セグメントを atFrame で 2 つに分割し新 ID を採番する', () => {
    const next = splitTelopAt(state(), 1, 90, 'ゆる', '素振り');
    expect(next.telops).toHaveLength(3);
    expect(next.telops[0]).toMatchObject({ id: 1, originalStart: 30, originalEnd: 90, text: 'ゆる' });
    expect(next.telops[1]).toMatchObject({ id: 3, originalStart: 90, originalEnd: 150, text: '素振り' });
    expect(next.nextTelopId).toBe(4);
    // 後半は元の並び順を保ち、id:1 の直後へ挿入される
    expect(next.telops[2]?.id).toBe(2);
  });

  it('分割位置が区間端なら何もしない（コアが throw するため握りつぶす）', () => {
    const before = state();
    expect(splitTelopAt(before, 1, 30, 'a', 'b').telops).toHaveLength(2);
    expect(splitTelopAt(before, 1, 150, 'a', 'b').telops).toHaveLength(2);
  });

  it('存在しない ID はそのまま返す', () => {
    expect(splitTelopAt(state(), 999, 90, 'a', 'b').telops).toHaveLength(2);
  });

  it('分割後は右（後半）断片を選択する（分割直後の打ち替え先を左に据え置かない）', () => {
    const next = splitTelopAt(state(), 1, 90, 'ゆる', '素振り');
    expect(next.selection).toEqual({ kind: 'telop', id: 3 });
  });

  it('分割できなかったときは選択を書き換えない', () => {
    const before = { ...state(), selection: { kind: 'telop', id: 2 } as const };
    expect(splitTelopAt(before, 1, 30, 'a', 'b').selection).toEqual({ kind: 'telop', id: 2 });
    expect(splitTelopAt(before, 999, 90, 'a', 'b').selection).toEqual({ kind: 'telop', id: 2 });
  });
});

describe('openCutRange / rangeOverlapsCut', () => {
  const withCut = (): EditState => ({ ...state(), cutRegions: [{ start: 100, end: 500 }] });

  it('カット区間の中央を開けると区間が 2 つに割れる', () => {
    const next = openCutRange(withCut(), 200, 300);
    expect(next.cutRegions).toEqual([
      { start: 100, end: 200 },
      { start: 300, end: 500 },
    ]);
  });

  it('端に重なる範囲はその分だけ短くなる', () => {
    expect(openCutRange(withCut(), 50, 150).cutRegions).toEqual([{ start: 150, end: 500 }]);
    expect(openCutRange(withCut(), 450, 600).cutRegions).toEqual([{ start: 100, end: 450 }]);
  });

  it('カットと重ならない範囲・不正範囲は state をそのまま返す', () => {
    const before = withCut();
    expect(openCutRange(before, 600, 700)).toBe(before);
    expect(openCutRange(before, 300, 200)).toBe(before);
    expect(openCutRange(before, Number.NaN, 300)).toBe(before);
  });

  it('rangeOverlapsCut は 1 フレームでも重なれば true', () => {
    const regions = [{ start: 100, end: 500 }];
    expect(rangeOverlapsCut(regions, 499, 600)).toBe(true);
    expect(rangeOverlapsCut(regions, 500, 600)).toBe(false);
    expect(rangeOverlapsCut(regions, 0, 100)).toBe(false);
  });
});

describe('splitTelopWithText', () => {
  it('チップ境界で本文を左右へ分配して分割する（分割ボタンの文字空白バグ回帰）', () => {
    const chips: WordChip[] = [
      { text: 'ゆる', originalStart: 30, originalEnd: 80 },
      { text: '素振り', originalStart: 80, originalEnd: 150 },
    ];
    const next = splitTelopWithText(state(), 1, 90, chips);
    expect(next.telops[0]).toMatchObject({ originalEnd: 90, text: 'ゆる' });
    expect(next.telops[1]).toMatchObject({ originalStart: 90, text: '素振り' });
  });

  it('チップ無しなら時間比で本文を分ける（右側が空にならない）', () => {
    const next = splitTelopWithText(state(), 1, 90, []);
    expect(next.telops[0]?.text.length).toBeGreaterThan(0);
    expect(next.telops[1]?.text.length).toBeGreaterThan(0);
    expect((next.telops[0]?.text ?? '') + (next.telops[1]?.text ?? '')).toBe('ゆる素振り');
  });

  it('存在しない ID はそのまま返す', () => {
    expect(splitTelopWithText(state(), 999, 90, []).telops).toHaveLength(2);
  });

  it('手動テロップは本文を割らず両断片へ複製する（transcript と無関係なため）', () => {
    // 実機不具合の再現値（04_golf-short-0811 #30）。transcript 側の単語チップは
    // 本文と対応しないので、以前は末尾 1 文字だけが右へ渡っていた。
    const manual: EditState = {
      ...state(),
      telops: [{ id: 1, originalStart: 875, originalEnd: 1655, text: '当たり前ですよね.', manual: true }],
      multiTelopIds: [],
      nextTelopId: 2,
    };
    const chips: WordChip[] = [
      { text: 'ゴルフスイングの', originalStart: 875, originalEnd: 1200 },
      { text: '基本は', originalStart: 1200, originalEnd: 1452 },
      { text: 'とても大事', originalStart: 1452, originalEnd: 1655 },
    ];
    const next = splitTelopWithText(manual, 1, 1452, chips);
    expect(next.telops[0]).toMatchObject({ id: 1, originalEnd: 1452, text: '当たり前ですよね.' });
    expect(next.telops[1]).toMatchObject({ id: 2, originalStart: 1452, text: '当たり前ですよね.' });
  });
});

describe('mergeTelopWithNext', () => {
  it('指定セグメントを次のセグメントと結合する', () => {
    const next = mergeTelopWithNext(state(), 1);
    expect(next.telops).toHaveLength(1);
    expect(next.telops[0]).toMatchObject({
      id: 3,
      originalStart: 30,
      originalEnd: 320,
      text: 'ゆる素振り長いアイアン2本ですね',
    });
    expect(next.nextTelopId).toBe(4);
  });

  it('最後のセグメントには次が無いのでそのまま返す', () => {
    const before = state();
    expect(mergeTelopWithNext(before, 2).telops).toHaveLength(2);
  });

  it('存在しない ID はそのまま返す', () => {
    expect(mergeTelopWithNext(state(), 999).telops).toHaveLength(2);
  });

  it('結合対象（first）を選択中なら selection が新 ID になる', () => {
    const s = { ...state(), selection: { kind: 'telop' as const, id: 1 } };
    const next = mergeTelopWithNext(s, 1);
    expect(next.selection).toEqual({ kind: 'telop', id: 3 });
  });

  it('結合対象（second）を選択中なら selection が新 ID になる', () => {
    const s = { ...state(), selection: { kind: 'telop' as const, id: 2 } };
    const next = mergeTelopWithNext(s, 1);
    expect(next.selection).toEqual({ kind: 'telop', id: 3 });
  });

  it('無関係なテロップを選択中なら selection は維持される', () => {
    const telops = [
      ...state().telops,
      { id: 99, originalStart: 400, originalEnd: 500, text: '別テロップ' },
    ];
    const s: EditState = { ...state(), telops, images: [], nextImageId: 1, selection: { kind: 'telop' as const, id: 99 } };
    const next = mergeTelopWithNext(s, 1);
    expect(next.selection).toEqual({ kind: 'telop', id: 99 });
  });

  it('未選択（null）の場合は selection が null のまま', () => {
    const s = { ...state(), selection: null };
    const next = mergeTelopWithNext(s, 1);
    expect(next.selection).toBeNull();
  });
});

describe('resizeCutRegion', () => {
  function stateWithCut(): EditState {
    return {
      telops: [],
      cutRegions: [{ start: 100, end: 200 }],
      se: [],
      images: [],
      videoInserts: [],
      bgm: [],
      selection: null,
      multiTelopIds: [],
      nextTelopId: 1,
      nextSeId: 1,
      nextImageId: 1,
      nextVideoInsertId: 1,
      nextBgmId: 1,
      titles: [],
      nextTitleId: 1,
      shapes: [],
      nextShapeId: 1,
      sceneTransitions: [],
      nextTransitionId: 1,
      ducking: { enabled: true, strength: 'mid' as const },
      mainSpeed: 1,
      segmentSpeeds: {},
      segmentLayouts: {}, layoutKeyframes: [],
    };
  }

  it('開始端を左へ動かすとカット区間が広がる', () => {
    const next = resizeCutRegion(stateWithCut(), { start: 100, end: 200 }, 'start', 60);
    expect(next.cutRegions).toEqual([{ start: 60, end: 200 }]);
  });

  it('終了端を右へ動かすとカット区間が広がる', () => {
    const next = resizeCutRegion(stateWithCut(), { start: 100, end: 200 }, 'end', 260);
    expect(next.cutRegions).toEqual([{ start: 100, end: 260 }]);
  });

  it('開始端を終了端より右へ動かすと区間が潰れて除去される', () => {
    const next = resizeCutRegion(stateWithCut(), { start: 100, end: 200 }, 'start', 250);
    expect(next.cutRegions).toEqual([]);
  });

  it('開始端を終了端ぴったりへ動かしても区間が潰れて除去される', () => {
    const next = resizeCutRegion(stateWithCut(), { start: 100, end: 200 }, 'start', 200);
    expect(next.cutRegions).toEqual([]);
  });

  it('負のフレームは 0 へクランプする', () => {
    const next = resizeCutRegion(stateWithCut(), { start: 100, end: 200 }, 'start', -50);
    expect(next.cutRegions).toEqual([{ start: 0, end: 200 }]);
  });

  it('小数フレームは丸める', () => {
    const next = resizeCutRegion(stateWithCut(), { start: 100, end: 200 }, 'end', 250.7);
    expect(next.cutRegions).toEqual([{ start: 100, end: 251 }]);
  });

  it('対象区間が現在の cutRegions に無ければ state をそのまま返す', () => {
    const s = stateWithCut();
    const next = resizeCutRegion(s, { start: 500, end: 600 }, 'end', 700);
    expect(next).toBe(s);
  });

  it('他のカット区間は保持される', () => {
    const s: EditState = {
      telops: [],
      cutRegions: [{ start: 100, end: 200 }, { start: 400, end: 500 }],
      se: [],
      images: [],
      videoInserts: [],
      bgm: [],
      selection: null,
      multiTelopIds: [],
      nextTelopId: 1,
      nextSeId: 1,
      nextImageId: 1,
      nextVideoInsertId: 1,
      nextBgmId: 1,
      titles: [],
      nextTitleId: 1,
      shapes: [],
      nextShapeId: 1,
      sceneTransitions: [],
      nextTransitionId: 1,
      ducking: { enabled: true, strength: 'mid' as const },
      mainSpeed: 1,
      segmentSpeeds: {},
      segmentLayouts: {}, layoutKeyframes: [],
    };
    const next = resizeCutRegion(s, { start: 100, end: 200 }, 'end', 250);
    expect(next.cutRegions).toEqual([{ start: 100, end: 250 }, { start: 400, end: 500 }]);
  });

  it('NaN フレームは state をそのまま返す', () => {
    const s = stateWithCut();
    expect(resizeCutRegion(s, { start: 100, end: 200 }, 'end', NaN)).toBe(s);
  });

  it('端を動かした結果が隣のカット区間と重なればマージされる', () => {
    const s: EditState = {
      telops: [],
      cutRegions: [{ start: 100, end: 200 }, { start: 400, end: 500 }],
      se: [],
      images: [],
      videoInserts: [],
      bgm: [],
      selection: null,
      multiTelopIds: [],
      nextTelopId: 1,
      nextSeId: 1,
      nextImageId: 1,
      nextVideoInsertId: 1,
      nextBgmId: 1,
      titles: [],
      nextTitleId: 1,
      shapes: [],
      nextShapeId: 1,
      sceneTransitions: [],
      nextTransitionId: 1,
      ducking: { enabled: true, strength: 'mid' as const },
      mainSpeed: 1,
      segmentSpeeds: {},
      segmentLayouts: {}, layoutKeyframes: [],
    };
    // 区間 100..200 の終了端を 420 へ伸ばす → 400..500 と重なってマージ
    const next = resizeCutRegion(s, { start: 100, end: 200 }, 'end', 420);
    expect(next.cutRegions).toEqual([{ start: 100, end: 500 }]);
  });
});

describe('insertTelop', () => {
  it('afterTelopId の直後へ新テロップを挿入し nextTelopId を採番・選択する', () => {
    const next = insertTelop(state(), 1, 150, 270);
    expect(next.telops).toHaveLength(3);
    expect(next.telops[1]).toMatchObject({ id: 3, originalStart: 150, originalEnd: 270 });
    expect(next.nextTelopId).toBe(4);
    expect(next.selection).toEqual({ kind: 'telop', id: 3 });
  });

  it('afterTelopId が null なら末尾へ挿入する', () => {
    const next = insertTelop(state(), null, 400, 500);
    expect(next.telops).toHaveLength(3);
    expect(next.telops[2]).toMatchObject({ id: 3 });
  });

  it('afterTelopId が不在なら末尾へ挿入する', () => {
    const next = insertTelop(state(), 999, 400, 500);
    expect(next.telops[2]).toMatchObject({ id: 3 });
  });

  it('start>=end の不正区間は無視して state をそのまま返す', () => {
    const s = state();
    expect(insertTelop(s, 1, 300, 300)).toBe(s);
    expect(insertTelop(s, 1, 300, 200)).toBe(s);
  });

  it('負の originalStart は 0 へクランプし小数は丸める', () => {
    const next = insertTelop(state(), null, -40, 270.6);
    expect(next.telops[2]).toMatchObject({ originalStart: 0, originalEnd: 271 });
  });

  it('丸めの結果 start>=end になる区間は無視して state をそのまま返す', () => {
    const s = state();
    // 100.4 -> 100, 100.4 -> 100 で start>=end
    expect(insertTelop(s, null, 100.4, 100.4)).toBe(s);
  });

  it('originalStart/End が非有限数なら state をそのまま返す', () => {
    const s = state();
    expect(insertTelop(s, null, NaN, 270)).toBe(s);
    expect(insertTelop(s, null, 30, Infinity)).toBe(s);
  });

  it('直前テロップの template を継承する', () => {
    const base = {
      telops: [
        { id: 1, originalStart: 0, originalEnd: 30, text: 'a', template: 7 },
        { id: 2, originalStart: 30, originalEnd: 60, text: 'b', template: 7 },
      ],
      multiTelopIds: [],
      nextTelopId: 3,
      cutRegions: [],
      se: [],
      images: [],
      selection: null,
    } as unknown as EditState;
    const next = insertTelop(base, 1, 100, 130); // id1 の直後へ挿入
    const inserted = next.telops.find((t) => t.id === 3)!;
    expect(inserted.template).toBe(7);
  });

  it('追加したテロップは manual:true（装飾）になる', () => {
    const next = insertTelop(state(), null, 400, 500);
    const added = next.telops[next.telops.length - 1]!;
    expect(added.manual).toBe(true);
  });
});

describe('computeInsertSpan', () => {
  // fps=30, durationFrames=600 (20 秒) の基本設定。2 秒 = 60 フレーム。
  const FPS = 30;
  const DUR = 600;

  it('アンカー無し（selectedTelopId=null）→ 末尾テロップ終端から 2 秒', () => {
    const telops = state().telops; // id:1 end=150, id:2 end=320
    const result = computeInsertSpan(telops, null, FPS, DUR);
    expect(result).toEqual({ start: 320, end: 380 }); // 320 + 60
  });

  it('アンカー有り → そのテロップの originalEnd から 2 秒', () => {
    const telops = state().telops;
    const result = computeInsertSpan(telops, 1, FPS, DUR);
    expect(result).toEqual({ start: 150, end: 210 }); // 150 + 60
  });

  it('アンカー終端が動画末尾近く（残り尺 < 2 秒）→ end が durationFrames にクランプされ start はアンカー終端のまま', () => {
    const telops = [
      { id: 1, originalStart: 0, originalEnd: 570, text: 'x' }, // 570 + 60 = 630 > 600
    ];
    const result = computeInsertSpan(telops, 1, FPS, DUR);
    // start=570, end=min(600,570+60)=600, start(570) < end(600) → 有効
    expect(result).toEqual({ start: 570, end: 600 });
  });

  it('アンカー終端が durationFrames ちょうど → null（挿入余地なし）', () => {
    const telops = [
      { id: 1, originalStart: 0, originalEnd: 600, text: 'x' },
    ];
    expect(computeInsertSpan(telops, 1, FPS, DUR)).toBeNull();
  });

  it('アンカー終端が durationFrames 超過 → start がクランプされ null になる', () => {
    const telops = [
      { id: 1, originalStart: 0, originalEnd: 700, text: 'x' }, // 700 > 600
    ];
    // start = min(700, 600) = 600, end = min(600, 600+60) = 600, start>=end → null
    expect(computeInsertSpan(telops, 1, FPS, DUR)).toBeNull();
  });

  it('telops 空 → start=0, end=min(dur,durationFrames)', () => {
    const result = computeInsertSpan([], null, FPS, DUR);
    expect(result).toEqual({ start: 0, end: 60 });
  });

  it('durationFrames=0 → null', () => {
    const telops = state().telops;
    expect(computeInsertSpan(telops, null, FPS, 0)).toBeNull();
  });

  it('telops 空 かつ durationFrames=0 → null', () => {
    expect(computeInsertSpan([], null, FPS, 0)).toBeNull();
  });

  it('通常ケースで start < end（健全性確認）', () => {
    const result = computeInsertSpan(state().telops, 1, FPS, DUR);
    expect(result).not.toBeNull();
    if (result) expect(result.start).toBeLessThan(result.end);
  });

  it('fps<=0 でも dur は最低 1 になりクラッシュしない', () => {
    const telops = [{ id: 1, originalStart: 0, originalEnd: 10, text: 'x' }];
    const result = computeInsertSpan(telops, 1, 0, 100);
    // dur = max(1, round(2*0)) = max(1,0) = 1, start=10, end=min(100,10+1)=11
    expect(result).toEqual({ start: 10, end: 11 });
  });
});

describe('mergeTelopWithNext は飾りテロップを飛ばす', () => {
  it('字幕1と次の字幕2を結合し、間の飾りは残す', () => {
    const state = {
      telops: [
        { id: 1, originalStart: 0, originalEnd: 60, text: 'A' },
        { id: 9, originalStart: 0, originalEnd: 300, text: 'deco', manual: true },
        { id: 2, originalStart: 60, originalEnd: 120, text: 'B' },
      ],
      cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
      selection: null,
      multiTelopIds: [],
      nextTelopId: 10, nextSeId: 1, nextImageId: 1, nextVideoInsertId: 1, nextBgmId: 1,
    } as const;
    const next = mergeTelopWithNext(state as any, 1);
    const ids = next.telops.map((t) => t.id);
    expect(ids).toContain(9); // 飾りは保持
    // 字幕1+2 が結合され nextTelopId(10) で採番、字幕の元 id 1,2 は消える
    expect(ids).toContain(10);
    expect(ids).not.toContain(2);
    const merged = next.telops.find((t) => t.id === 10)!;
    expect(merged.originalStart).toBe(0);
    expect(merged.originalEnd).toBe(120);
  });
});

describe('cutRange', () => {
  it('範囲をカット区間として追加する', () => {
    const next = cutRange(state(), 50, 90);
    expect(next.cutRegions).toEqual([{ start: 50, end: 90 }]);
  });

  it('start>=end の範囲はカットしない（state そのまま）', () => {
    const s = state();
    expect(cutRange(s, 90, 90)).toBe(s);
    expect(cutRange(s, 90, 50)).toBe(s);
  });

  it('負のフレームは 0 へクランプし小数は丸める', () => {
    const next = cutRange(state(), -20, 90.6);
    expect(next.cutRegions).toEqual([{ start: 0, end: 91 }]);
  });

  it('既存カットと重なる範囲はマージされる', () => {
    const base = cutRange(state(), 50, 100);
    const next = cutRange(base, 80, 140);
    expect(next.cutRegions).toEqual([{ start: 50, end: 140 }]);
  });

  it('非有限フレームは state そのまま', () => {
    const s = state();
    expect(cutRange(s, NaN, 90)).toBe(s);
    expect(cutRange(s, 50, Infinity)).toBe(s);
  });
});

describe('addTelopAtFrame', () => {
  const base = (over = {}) => ({
    telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [], titles: [],
    selection: null, multiTelopIds: [], nextTelopId: 5, nextSeId: 1, nextImageId: 1,
    nextVideoInsertId: 1, nextBgmId: 1, nextTitleId: 1,
    shapes: [], nextShapeId: 1,
    sceneTransitions: [], nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const }, mainSpeed: 1, segmentSpeeds: {}, segmentLayouts: {}, layoutKeyframes: [], ...over,
  });
  it('再生ヘッド原本フレームに既定3秒・manual の装飾テロップを足して選択する', () => {
    const fps = 30;
    const next = addTelopAtFrame(base(), 90, fps);
    expect(next.telops).toHaveLength(1);
    expect(next.telops[0]).toMatchObject({
      id: 5, originalStart: 90, originalEnd: 90 + TELOP_DEFAULT_DURATION_SEC * fps, // 90 + 90 = 180
      text: '新しいテロップ', manual: true,
    });
    expect(next.selection).toEqual({ kind: 'telop', id: 5 });
    expect(next.nextTelopId).toBe(6);
  });
  it('originalStart<0 は 0 へクランプ', () => {
    expect(addTelopAtFrame(base(), -10, 30).telops[0]!.originalStart).toBe(0);
  });
  it('TELOP_DEFAULT_DURATION_SEC は 3', () => {
    expect(TELOP_DEFAULT_DURATION_SEC).toBe(3);
  });
});

describe('addSubtitleAtFrame（＋追加メニューの「字幕」）', () => {
  const FPS = 30;
  /** 字幕2件（#1 [30,150] / #2 [200,320]）を持つ既定 state を使う。 */

  it('カット区間などの空きに既定3秒・manual なしの字幕を足して選択する', () => {
    const next = addSubtitleAtFrame(state(), 400, FPS);
    const added = next.telops.find((t) => t.id === 3);
    expect(added).toMatchObject({
      id: 3,
      originalStart: 400,
      originalEnd: 400 + TELOP_DEFAULT_DURATION_SEC * FPS,
      text: '新しい字幕',
    });
    // 字幕は manual を「付けない」（付けると飾りテロップ扱いになり別トラック・別色になる）。
    expect('manual' in (added ?? {})).toBe(false);
    expect(next.selection).toEqual({ kind: 'telop', id: 3 });
    expect(next.nextTelopId).toBe(4);
  });

  it('隣の字幕と重なる場合は端を詰める（clampSubtitleRange 系）', () => {
    // #2 は [200,320]。160 から 3 秒（=90f）欲しいが 200 で止まる。
    const next = addSubtitleAtFrame(state(), 160, FPS);
    const added = next.telops.find((t) => t.id === 3);
    expect(added).toMatchObject({ originalStart: 160, originalEnd: 200 });
  });

  it('既存字幕の内側など有効区間が10フレーム未満なら no-op（同一参照を返す）', () => {
    const s = state();
    // #1 [30,150] の内側。start は 150 まで押し出され、end は #2 の 200 で止まる…
    // ではなく、直後の字幕が #2 なので [150,200]＝50f 取れる。取れない例を作る。
    const tight: EditState = {
      ...s,
      telops: [
        { id: 1, originalStart: 30, originalEnd: 150, text: 'A' },
        { id: 2, originalStart: 155, originalEnd: 320, text: 'B' },
      ],
    };
    // ヘッドが #1 の内側 → start=150 / end=155 → 5f < 10f → no-op。
    expect(addSubtitleAtFrame(tight, 100, FPS)).toBe(tight);
  });

  it('隙間ぴったり10フレームなら追加できる（境界）', () => {
    const s = state();
    const tight: EditState = {
      ...s,
      telops: [
        { id: 1, originalStart: 30, originalEnd: 150, text: 'A' },
        { id: 2, originalStart: 160, originalEnd: 320, text: 'B' },
      ],
    };
    const next = addSubtitleAtFrame(tight, 100, FPS);
    expect(next).not.toBe(tight);
    expect(next.telops.find((t) => t.id === 3)).toMatchObject({ originalStart: 150, originalEnd: 160 });
    expect(MIN_SUBTITLE_FRAMES).toBe(10);
  });

  it('配列上も時間順（直前の字幕の直後）へ挿入する', () => {
    const s = state();
    // 末尾に古い順序で並んでいない字幕がある状態でも、時間順で #1 の直後に入る。
    const next = addSubtitleAtFrame(s, 160, FPS);
    expect(next.telops.map((t) => t.id)).toEqual([1, 3, 2]);
  });

  it('直前に字幕が無ければ先頭へ挿入する', () => {
    const next = addSubtitleAtFrame(state(), 0, FPS);
    expect(next.telops.map((t) => t.id)).toEqual([3, 1, 2]);
    expect(next.telops[0]).toMatchObject({ originalStart: 0, originalEnd: 30 });
  });

  it('時間軸上で直前の字幕から template / style を継承する', () => {
    const s = state();
    const styled: EditState = {
      ...s,
      telops: [
        { id: 1, originalStart: 30, originalEnd: 150, text: 'A', template: 7, style: 'emphasis' as const },
        { id: 2, originalStart: 900, originalEnd: 1000, text: 'B', template: 2 },
      ],
    };
    const added = addSubtitleAtFrame(styled, 400, FPS).telops.find((t) => t.id === 3);
    expect(added).toMatchObject({ template: 7, style: 'emphasis' });
  });

  it('飾りテロップ（manual）は継承元にも境界にもしない', () => {
    const s = state();
    const withManual: EditState = {
      ...s,
      telops: [
        { id: 1, originalStart: 30, originalEnd: 150, text: 'A', template: 7 },
        { id: 9, originalStart: 380, originalEnd: 500, text: '飾り', template: 30, manual: true },
      ],
    };
    const next = addSubtitleAtFrame(withManual, 400, FPS);
    const added = next.telops.find((t) => t.id === 3);
    // 飾りと重なっても詰めない・飾りの template も継がない。
    expect(added).toMatchObject({ originalStart: 400, originalEnd: 490, template: 7 });
  });

  it('複数選択中に追加すると新字幕の単一選択へ正規化される', () => {
    const s = state();
    const multi: EditState = { ...s, selection: { kind: 'telop', id: 1 }, multiTelopIds: [1, 2] };
    const next = addSubtitleAtFrame(multi, 400, FPS);
    expect(next.selection).toEqual({ kind: 'telop', id: 3 });
    expect(next.multiTelopIds).toEqual([]);
  });

  it('非有限値・fps<=0 は no-op（同一参照）', () => {
    const s = state();
    expect(addSubtitleAtFrame(s, NaN, FPS)).toBe(s);
    expect(addSubtitleAtFrame(s, 400, 0)).toBe(s);
  });

  it('負のフレームは 0 へクランプ', () => {
    expect(addSubtitleAtFrame(state(), -50, FPS).telops[0]).toMatchObject({ originalStart: 0 });
  });
});

describe('cutButtonMode', () => {
  const regions = [{ start: 100, end: 200 }];

  it('未カット範囲は cut', () => {
    expect(cutButtonMode(regions, 300, 400)).toBe('cut');
  });

  it('カット区間に完全に内包される範囲は open', () => {
    expect(cutButtonMode(regions, 120, 180)).toBe('open');
    expect(cutButtonMode(regions, 100, 200)).toBe('open'); // 区間ぴったり
  });

  it('またぎ（部分重なり）は cut（カットを広げる意図）', () => {
    expect(cutButtonMode(regions, 50, 150)).toBe('cut');
    expect(cutButtonMode(regions, 150, 250)).toBe('cut');
    expect(cutButtonMode(regions, 50, 250)).toBe('cut'); // 包含する側
  });

  it('カット無し・不正範囲は cut', () => {
    expect(cutButtonMode([], 0, 100)).toBe('cut');
    expect(cutButtonMode(regions, 150, 150)).toBe('cut'); // start>=end
  });

  it('複数カット区間: どれか1つに内包されれば open', () => {
    const multi = [{ start: 0, end: 50 }, { start: 100, end: 200 }];
    expect(cutButtonMode(multi, 10, 40)).toBe('open');
    expect(cutButtonMode(multi, 60, 90)).toBe('cut');
  });
});

describe('subtitleInsertSpan（字幕追加の可否と「ヘッドからずれたか」）', () => {
  const FPS = 30;
  const telops = [
    { id: 1, originalStart: 30, originalEnd: 150, text: 'A' },
    { id: 2, originalStart: 400, originalEnd: 600, text: 'B' },
  ];

  it('空きにそのまま入るときは shifted:false', () => {
    expect(subtitleInsertSpan(telops, 3, 200, FPS)).toEqual({ start: 200, end: 290, shifted: false });
  });

  it('ヘッドが既存字幕の内側なら、その字幕の直後へ寄せて shifted:true', () => {
    // #1 [30,150] の内側 → 開始は 150 へ。3 秒（90f）は #2 の 400 に届かないのでそのまま。
    expect(subtitleInsertSpan(telops, 3, 100, FPS)).toEqual({ start: 150, end: 240, shifted: true });
  });

  it('隙間が最小尺に満たなければ null（追加不可）', () => {
    const tight = [
      { id: 1, originalStart: 30, originalEnd: 150, text: 'A' },
      { id: 2, originalStart: 155, originalEnd: 320, text: 'B' },
    ];
    expect(subtitleInsertSpan(tight, 3, 100, FPS)).toBeNull();
  });

  it('非有限値・fps<=0 は null', () => {
    expect(subtitleInsertSpan(telops, 3, Number.NaN, FPS)).toBeNull();
    expect(subtitleInsertSpan(telops, 3, 200, 0)).toBeNull();
  });
});

describe('addSubtitleAtFrame: ヘッドが既存字幕の内側のとき（P2-3 仕様確定）', () => {
  const FPS = 30;

  it('no-op にせず、直後の空きへ寄せて追加する', () => {
    const s = state();
    const roomy: EditState = {
      ...s,
      telops: [
        { id: 1, originalStart: 30, originalEnd: 150, text: 'A', template: 4 },
        { id: 2, originalStart: 400, originalEnd: 600, text: 'B', template: 9 },
      ],
    };
    const next = addSubtitleAtFrame(roomy, 100, FPS);
    expect(next).not.toBe(roomy);
    const added = next.telops.find((t) => t.id === 3);
    // 直前の字幕（#1）の直後・その template を継承・配列上も #1 の直後。
    expect(added).toMatchObject({ originalStart: 150, originalEnd: 240, template: 4 });
    expect(next.telops.map((t) => t.id)).toEqual([1, 3, 2]);
    expect(next.selection).toEqual({ kind: 'telop', id: 3 });
  });
});

describe('splitTelopWithText: チップと本文が対応しない字幕は時間比で割る（P2-4）', () => {
  /** 発話区間のチップ（本文と無関係）。 */
  const chips: WordChip[] = [
    { text: 'ゆる', originalStart: 0, originalEnd: 20 },
    { text: '素振り', originalStart: 20, originalEnd: 60 },
    { text: 'です', originalStart: 60, originalEnd: 100 },
  ];

  it('手動追加した字幕（manual なし・本文は transcript と無関係）をチップ境界で割らない', () => {
    const st: EditState = {
      ...state(),
      telops: [{ id: 1, originalStart: 0, originalEnd: 100, text: '新しい字幕' }],
    };
    const next = splitTelopWithText(st, 1, 50, chips);
    // チップ側の文字数（'ゆる素振り'=5）を本文の切り出し位置に使うと ['新しい字','幕']。
    // 本文とチップが対応しないので時間比（50%）で割るのが正しい。
    expect(next.telops.map((t) => t.text)).toEqual(['新しい', '字幕']);
  });

  it('本文とチップが対応する通常の字幕は従来どおりチップ境界で割る（恒等性の回帰）', () => {
    const st: EditState = {
      ...state(),
      telops: [{ id: 1, originalStart: 0, originalEnd: 100, text: 'ゆる素振りです' }],
    };
    const next = splitTelopWithText(st, 1, 50, chips);
    expect(next.telops.map((t) => t.text)).toEqual(['ゆる素振り', 'です']);
  });

  it('改行入りの本文もチップと対応していればチップ境界で割る（改行は照合から除く）', () => {
    const st: EditState = {
      ...state(),
      telops: [{ id: 1, originalStart: 0, originalEnd: 100, text: 'ゆる素振り\nです' }],
    };
    const next = splitTelopWithText(st, 1, 50, chips);
    expect(next.telops.map((t) => t.text)).toEqual(['ゆる素振り', 'です']);
  });
});

describe('splitTelopWithText: 誤字修正済み本文はチップ文字数の近似で割る（P2-2）', () => {
  // transcript は「効き目」、本文は typo_dict / 手直しで「利き目」へ直っている。
  // 文字列は一致しないが**文字数は対応している**ので、チップ境界の近似が使える。
  const chips: WordChip[] = [
    { text: '効き目が', originalStart: 0, originalEnd: 80 },
    { text: '大事', originalStart: 80, originalEnd: 100 },
  ];

  it('1 文字だけ違う（長さは同じ）本文はチップ境界で割れる', () => {
    const st: EditState = {
      ...state(),
      telops: [{ id: 1, originalStart: 0, originalEnd: 100, text: '利き目が大事' }],
    };
    const next = splitTelopWithText(st, 1, 80, chips);
    // 時間比（80%）で割ると ['利き目が大','事'] になり語の途中で切れる。
    expect(next.telops.map((t) => t.text)).toEqual(['利き目が', '大事']);
  });

  it('文字数が対応しない本文は従来どおり時間比（P2-4 の判定は維持）', () => {
    const st: EditState = {
      ...state(),
      telops: [{ id: 1, originalStart: 0, originalEnd: 100, text: '新しい字幕' }],
    };
    const next = splitTelopWithText(st, 1, 80, chips);
    expect(next.telops.map((t) => t.text)).toEqual(['新しい字', '幕']);
  });
});
