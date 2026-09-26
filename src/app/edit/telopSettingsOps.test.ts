import { describe, expect, it } from 'vitest';
import {
  setTelopTemplate,
  setTelopStyle,
  setTelopHighlight,
  setTelopTiming,
  setTelopPosition,
  setTelopScale,
  setTelopManual,
  setAllTelopTemplates,
  setAllTelopPositions,
  removeTelop,
  moveTelop,
  setTelopsPosition,
  setTelopsScale,
  removeTelops,
} from './telopSettingsOps';
import type { EditState } from './editState';

function state(): EditState {
  return {
    telops: [
      { id: 1, originalStart: 30, originalEnd: 150, text: 'ゆる素振り', style: 'normal' },
      { id: 2, originalStart: 200, originalEnd: 320, text: '長いアイアン' },
    ],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    selection: { kind: 'telop' as const, id: 1 },
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

describe('setTelopTemplate', () => {
  it('テンプレート番号を設定する', () => {
    expect(setTelopTemplate(state(), 1, 4).telops[0]?.template).toBe(4);
  });
  it('存在しない ID は telops を変更せずそのまま返す', () => {
    const before = state();
    expect(setTelopTemplate(before, 999, 4).telops).toEqual(before.telops);
  });
});

describe('setTelopStyle', () => {
  it('スタイルを設定する', () => {
    expect(setTelopStyle(state(), 1, 'emphasis').telops[0]?.style).toBe('emphasis');
  });
});

describe('setTelopHighlight', () => {
  it('ハイライト語を設定する', () => {
    expect(setTelopHighlight(state(), 1, 'ゆる素振り').telops[0]?.highlight).toBe('ゆる素振り');
  });
  it('空文字を渡すと highlight プロパティを取り除く', () => {
    const withHl = setTelopHighlight(state(), 1, 'x');
    const cleared = setTelopHighlight(withHl, 1, '');
    expect('highlight' in (cleared.telops[0] ?? {})).toBe(false);
  });
});

describe('setTelopTiming', () => {
  it('原本フレームの開始・終了を設定する', () => {
    const next = setTelopTiming(state(), 1, 40, 140);
    expect(next.telops[0]).toMatchObject({ originalStart: 40, originalEnd: 140 });
  });
  it('start >= end の不正入力は無視して元の state を返す', () => {
    const before = state();
    expect(setTelopTiming(before, 1, 200, 100)).toBe(before);
    expect(setTelopTiming(before, 1, 100, 100)).toBe(before);
  });
  it('負のフレームは 0 にクランプする', () => {
    expect(setTelopTiming(state(), 1, -10, 140).telops[0]?.originalStart).toBe(0);
  });
});

describe('setTelopPosition', () => {
  it('位置 x を -1..1、y を -1..0 へクランプする（テロップは下端固定）', () => {
    expect(setTelopPosition(state(), 1, 0.5, -0.3).telops[0]?.position).toEqual({ x: 0.5, y: -0.3 });
    expect(setTelopPosition(state(), 1, 9, -9).telops[0]?.position).toEqual({ x: 1, y: -1 });
  });
  it('y>0（下方向）は 0 でクランプ（画面外へ出さない）', () => {
    expect(setTelopPosition(state(), 1, 0, 0.8).telops[0]?.position).toEqual({ x: 0, y: 0 });
  });
});

describe('setTelopScale', () => {
  it('スケールを設定し 0.3..3.0 へクランプする', () => {
    expect(setTelopScale(state(), 1, 1.5).telops[0]?.scale).toBe(1.5);
    expect(setTelopScale(state(), 1, 99).telops[0]?.scale).toBe(3);
    expect(setTelopScale(state(), 1, 0.01).telops[0]?.scale).toBe(0.3);
  });
});

function st(): EditState {
  return {
    telops: [
      { id: 1, originalStart: 0, originalEnd: 30, text: 'a', template: 1 },
      { id: 2, originalStart: 30, originalEnd: 60, text: 'b' },
    ],
    cutRegions: [],
    se: [],
    images: [],
    selection: null,
  } as unknown as EditState;
}

describe('setAllTelopTemplates', () => {
  it('全テロップの template を設定する', () => {
    const next = setAllTelopTemplates(st(), 7);
    expect(next.telops.map((t) => t.template)).toEqual([7, 7]);
  });
});

describe('setAllTelopPositions', () => {
  it('全テロップへ position/scale を一括適用する', () => {
    const next = setAllTelopPositions(st(), { x: -0.5, y: -0.5 }, 1.5);
    expect(next.telops.map((t) => t.position)).toEqual([
      { x: -0.5, y: -0.5 },
      { x: -0.5, y: -0.5 },
    ]);
    expect(next.telops.map((t) => t.scale)).toEqual([1.5, 1.5]);
  });

  it('範囲外は個別設定と同じ範囲（x:-1..1 / y:-1..0 / scale:0.3..3）へクランプ', () => {
    const next = setAllTelopPositions(st(), { x: 9, y: 9 }, 99);
    expect(next.telops[0]?.position).toEqual({ x: 1, y: 0 });
    expect(next.telops[0]?.scale).toBe(3);
  });

  it('各テロップは独立した position オブジェクトを持つ（共有参照にしない）', () => {
    const next = setAllTelopPositions(st(), { x: 0, y: -0.5 }, 1.2);
    expect(next.telops[0]?.position).not.toBe(next.telops[1]?.position);
  });

  it('一括適用は一回きり：その後 1 つを変えても他テロップへ波及しない', () => {
    // 適用 → 全テロップ同じ位置・大きさ
    let s = setAllTelopPositions(st(), { x: 0, y: -0.5 }, 1.5);
    // テロップ1 だけ大きさ・位置を微調整
    s = setTelopScale(s, 1, 2.4);
    s = setTelopPosition(s, 1, -0.3, -0.2);
    // テロップ2 は一括適用時の値のまま（波及しない）
    expect(s.telops[1]?.scale).toBe(1.5);
    expect(s.telops[1]?.position).toEqual({ x: 0, y: -0.5 });
    // テロップ1 は微調整が反映されている
    expect(s.telops[0]?.scale).toBe(2.4);
    expect(s.telops[0]?.position).toEqual({ x: -0.3, y: -0.2 });
  });
});

describe('setTelopManual', () => {
  it('manual=true でフラグを付ける', () => {
    const next = setTelopManual(state(), 1, true);
    expect(next.telops[0]!.manual).toBe(true);
  });
  it('manual=false で manual フィールドを取り除く', () => {
    const withFlag = setTelopManual(state(), 1, true);
    const next = setTelopManual(withFlag, 1, false);
    expect('manual' in next.telops[0]!).toBe(false);
  });
  it('不在 ID は state をそのまま返す', () => {
    const s = state();
    expect(setTelopManual(s, 999, true)).toBe(s);
  });
});

describe('removeTelop', () => {
  it('指定 ID のテロップを配列から取り除く', () => {
    const next = removeTelop(state(), 1);
    expect(next.telops.map((t) => t.id)).toEqual([2]);
  });
  it('削除したテロップが選択中なら選択を外す', () => {
    // state() は selection = { kind:'telop', id:1 }
    const next = removeTelop(state(), 1);
    expect(next.selection).toBeNull();
  });
  it('別のテロップが選択中なら選択は維持する', () => {
    const next = removeTelop(state(), 2);
    expect(next.selection).toEqual({ kind: 'telop', id: 1 });
  });
  it('不在 ID は state をそのまま返す', () => {
    const s = state();
    expect(removeTelop(s, 999)).toBe(s);
  });
});

describe('moveTelop', () => {
  const base = (over = {}) => ({
    telops: [{ id: 1, originalStart: 100, originalEnd: 220, text: 'a', manual: true }],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    titles: [],
    selection: null,
    multiTelopIds: [],
    nextTelopId: 2,
    nextSeId: 1,
    nextImageId: 1,
    nextVideoInsertId: 1,
    nextBgmId: 1,
    nextTitleId: 1,
    shapes: [],
    nextShapeId: 1,
    sceneTransitions: [],
    nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const },
    mainSpeed: 1,
    segmentSpeeds: {},
    segmentLayouts: {}, layoutKeyframes: [],
    ...over,
  });
  it('区間長を保って originalStart を変える', () => {
    const next = moveTelop(base(), 1, 50);
    expect(next.telops[0]?.originalStart).toBe(50);
    expect(next.telops[0]?.originalEnd).toBe(170); // 50 + (220-100)
  });
  it('originalStart < 0 は 0 へクランプし長さを保つ', () => {
    const next = moveTelop(base(), 1, -10);
    expect(next.telops[0]?.originalStart).toBe(0);
    expect(next.telops[0]?.originalEnd).toBe(120);
  });
  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = base();
    expect(moveTelop(s, 1, Number.NaN)).toBe(s);
    expect(moveTelop(s, 99, 50)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// 一括 ops（複数選択・設計書 §3）
// ---------------------------------------------------------------------------

/** 字幕 2 件（id 1,2）＋ 手動テロップ 2 件（id 3,4）。#1 と #3 を複数選択中。 */
function bulk(): EditState {
  return {
    ...state(),
    telops: [
      { id: 1, originalStart: 30, originalEnd: 150, text: 'じまくA' },
      { id: 2, originalStart: 200, originalEnd: 320, text: 'じまくB' },
      { id: 3, originalStart: 400, originalEnd: 500, text: '飾りA', manual: true },
      { id: 4, originalStart: 600, originalEnd: 700, text: '飾りB', manual: true },
    ],
    nextTelopId: 5,
    selection: { kind: 'telop' as const, id: 1 },
    multiTelopIds: [1, 3],
  };
}

describe('setTelopsPosition', () => {
  it('指定 ID のテロップだけへ position を適用する（選択外へ波及しない）', () => {
    const next = setTelopsPosition(bulk(), [1, 3], -0.5, -0.4);
    expect(next.telops[0]?.position).toEqual({ x: -0.5, y: -0.4 });
    expect(next.telops[2]?.position).toEqual({ x: -0.5, y: -0.4 });
    expect(next.telops[1]?.position).toBeUndefined();
    expect(next.telops[3]?.position).toBeUndefined();
  });

  it('クランプは単体版と同一（x:-1..1 / y:-1..0）', () => {
    const next = setTelopsPosition(bulk(), [1], 9, 9);
    expect(next.telops[0]?.position).toEqual({ x: 1, y: 0 });
    const neg = setTelopsPosition(bulk(), [1], -9, -9);
    expect(neg.telops[0]?.position).toEqual({ x: -1, y: -1 });
  });

  it('NaN / Infinity は no-op（同一 state 参照）', () => {
    const s = bulk();
    expect(setTelopsPosition(s, [1, 3], Number.NaN, 0)).toBe(s);
    expect(setTelopsPosition(s, [1, 3], 0, Number.POSITIVE_INFINITY)).toBe(s);
  });

  it('重複 ID は Set 化されて 1 回だけ適用される（結果は同じ）', () => {
    const dup = setTelopsPosition(bulk(), [1, 1, 3, 3], -0.5, -0.4);
    const uniq = setTelopsPosition(bulk(), [1, 3], -0.5, -0.4);
    expect(dup.telops).toEqual(uniq.telops);
  });

  it('不在 ID は無視する', () => {
    const next = setTelopsPosition(bulk(), [1, 999], 0.2, -0.2);
    expect(next.telops[0]?.position).toEqual({ x: 0.2, y: -0.2 });
    expect(next.telops.map((t) => t.id)).toEqual([1, 2, 3, 4]);
  });

  it('空配列・実在対象ゼロは同一 state 参照（空 Undo を積まない）', () => {
    const s = bulk();
    expect(setTelopsPosition(s, [], 0.2, -0.2)).toBe(s);
    expect(setTelopsPosition(s, [999], 0.2, -0.2)).toBe(s);
  });

  it('結果が全て同値なら同一 state 参照（空 Undo を積まない）', () => {
    const applied = setTelopsPosition(bulk(), [1, 3], -0.5, -0.4);
    expect(setTelopsPosition(applied, [1, 3], -0.5, -0.4)).toBe(applied);
  });

  it('各テロップは独立した position オブジェクトを持つ（参照共有しない）', () => {
    const next = setTelopsPosition(bulk(), [1, 3], -0.5, -0.4);
    expect(next.telops[0]?.position).not.toBe(next.telops[2]?.position);
  });
});

describe('setTelopsScale', () => {
  it('指定 ID のテロップだけへ scale を適用する', () => {
    const next = setTelopsScale(bulk(), [1, 3], 1.8);
    expect(next.telops[0]?.scale).toBe(1.8);
    expect(next.telops[2]?.scale).toBe(1.8);
    expect(next.telops[1]?.scale).toBeUndefined();
  });

  it('0.3..3.0 へクランプする（単体版と同一）', () => {
    expect(setTelopsScale(bulk(), [1], 99).telops[0]?.scale).toBe(3);
    expect(setTelopsScale(bulk(), [1], 0.01).telops[0]?.scale).toBe(0.3);
  });

  it('NaN は no-op（同一 state 参照）', () => {
    const s = bulk();
    expect(setTelopsScale(s, [1, 3], Number.NaN)).toBe(s);
  });

  it('空配列・実在対象ゼロ・全同値は同一 state 参照', () => {
    const s = bulk();
    expect(setTelopsScale(s, [], 2)).toBe(s);
    expect(setTelopsScale(s, [999], 2)).toBe(s);
    const applied = setTelopsScale(s, [1, 3], 2);
    expect(setTelopsScale(applied, [1, 3], 2)).toBe(applied);
  });

  it('重複 ID は Set 化される', () => {
    const dup = setTelopsScale(bulk(), [1, 1], 2);
    expect(dup.telops[0]?.scale).toBe(2);
  });
});

describe('removeTelops', () => {
  it('手動テロップ（manual:true）だけを削除し、字幕はスキップする', () => {
    const next = removeTelops(bulk(), [1, 3]);
    // 字幕 #1 は残り、手動 #3 だけ消える（字幕の削除＝区間カットという既存契約を維持）。
    expect(next.telops.map((t) => t.id)).toEqual([1, 2, 4]);
  });

  it('手動テロップを複数まとめて削除できる', () => {
    const s = { ...bulk(), selection: { kind: 'telop' as const, id: 3 }, multiTelopIds: [3, 4] };
    const next = removeTelops(s, [3, 4]);
    expect(next.telops.map((t) => t.id)).toEqual([1, 2]);
  });

  it('字幕だけを指定した場合は同一 state 参照（空 Undo を積まない）', () => {
    const s = bulk();
    expect(removeTelops(s, [1, 2])).toBe(s);
  });

  it('空配列・不在 ID のみは同一 state 参照', () => {
    const s = bulk();
    expect(removeTelops(s, [])).toBe(s);
    expect(removeTelops(s, [999])).toBe(s);
  });

  it('重複 ID を渡しても壊れない', () => {
    const s = { ...bulk(), selection: { kind: 'telop' as const, id: 3 }, multiTelopIds: [3, 4] };
    expect(removeTelops(s, [3, 3, 4]).telops.map((t) => t.id)).toEqual([1, 2]);
  });

  it('削除後に normalizeMultiSelection が効き、集合に消えた ID が残らない', () => {
    const s = { ...bulk(), selection: { kind: 'telop' as const, id: 3 }, multiTelopIds: [3, 4] };
    const next = removeTelops(s, [3, 4]);
    expect(next.multiTelopIds).toEqual([]);
    expect(next.selection).toBeNull();
  });

  it('削除でプライマリが消えたら選択も外す', () => {
    const s = { ...bulk(), selection: { kind: 'telop' as const, id: 4 }, multiTelopIds: [3, 4] };
    const next = removeTelops(s, [4]);
    expect(next.selection).toBeNull();
    expect(next.multiTelopIds).toEqual([]);
  });

  it('削除されなかったプライマリの選択は維持する', () => {
    const s = { ...bulk(), selection: { kind: 'telop' as const, id: 1 }, multiTelopIds: [1, 3] };
    const next = removeTelops(s, [3]);
    expect(next.selection).toEqual({ kind: 'telop', id: 1 });
    expect(next.multiTelopIds).toEqual([]);
  });
});
