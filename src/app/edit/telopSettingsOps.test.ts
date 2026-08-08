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
  applyTelopTemplateForScope,
  setAllTelopPositions,
  removeTelop,
  moveTelop,
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

// スタイル選択のスコープ（このテロップ / 全テロップ）は「選ぶ前」に決める。
// 適用先を選択の後に別ボタンで指定する形だと、押し忘れに気づけないため。
describe('applyTelopTemplateForScope', () => {
  it("scope='one' は指定テロップだけを変える", () => {
    const next = applyTelopTemplateForScope(st(), 2, 3, 'one');
    expect(next.telops.map((t) => t.template)).toEqual([1, 3]);
  });

  it("scope='all' は全テロップを変える", () => {
    const next = applyTelopTemplateForScope(st(), 2, 3, 'all');
    expect(next.telops.map((t) => t.template)).toEqual([3, 3]);
  });

  it("scope='all' は選択中でないテロップ id を渡しても全件に効く", () => {
    const next = applyTelopTemplateForScope(st(), 999, 2, 'all');
    expect(next.telops.map((t) => t.template)).toEqual([2, 2]);
  });

  it("scope='one' で不在 id なら何も変えない", () => {
    const next = applyTelopTemplateForScope(st(), 999, 2, 'one');
    expect(next.telops.map((t) => t.template)).toEqual([1, undefined]);
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
