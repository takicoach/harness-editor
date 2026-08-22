import { describe, it, expect } from 'vitest';
import { insertTitle, setTitleText, setTitleTiming, splitTitleAt, removeTitle, moveTitle } from './titleOps';
import type { EditState } from './editState';

function baseState(): EditState {
  return {
    telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
    titles: [], selection: null,
    multiTelopIds: [],
    nextTelopId: 1, nextSeId: 1, nextImageId: 1, nextVideoInsertId: 1, nextBgmId: 1, nextTitleId: 1,
    shapes: [], nextShapeId: 1,
    sceneTransitions: [], nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const },
    mainSpeed: 1,
    segmentSpeeds: {},
    segmentLayouts: {}, layoutKeyframes: [],
  };
}

describe('insertTitle', () => {
  it('再生位置から5秒・既定文言で追加し選択する', () => {
    const s = insertTitle(baseState(), 30, 30, 9000); // fps30, head=30(=1秒)
    expect(s.titles).toHaveLength(1);
    expect(s.titles[0]).toMatchObject({ id: 1, originalStart: 30, originalEnd: 180, text: 'タイトル' });
    expect(s.nextTitleId).toBe(2);
    expect(s.selection).toEqual({ kind: 'title', id: 1 });
  });
});

describe('setTitleText', () => {
  it('文字を更新する', () => {
    const s = insertTitle(baseState(), 0, 30, 9000);
    const s2 = setTitleText(s, 1, '練習ドリル｜ゆる素振り');
    expect(s2.titles[0]!.text).toBe('練習ドリル｜ゆる素振り');
  });
});

describe('setTitleTiming', () => {
  it('開始/終了を更新（start>=end は無視）', () => {
    const s = insertTitle(baseState(), 0, 30, 9000);
    expect(setTitleTiming(s, 1, 60, 200).titles[0]).toMatchObject({ originalStart: 60, originalEnd: 200 });
    expect(setTitleTiming(s, 1, 200, 100).titles[0]).toMatchObject({ originalStart: 0, originalEnd: 150 });
  });
});

describe('splitTitleAt', () => {
  it('再生位置で2つに分け、両方とも同じ文字で開始', () => {
    let s = insertTitle(baseState(), 0, 30, 9000); // 0-150
    s = setTitleText(s, 1, 'AB');
    const r = splitTitleAt(s, 1, 75);
    expect(r.titles).toHaveLength(2);
    expect(r.titles[0]).toMatchObject({ originalStart: 0, originalEnd: 75, text: 'AB' });
    expect(r.titles[1]).toMatchObject({ originalStart: 75, text: 'AB' });
    expect(r.titles[1]!.id).toBe(s.nextTitleId);
  });
  it('分割後は右（後半）断片を選択する（cutOps.splitTelopAt と同仕様）', () => {
    const s = insertTitle(baseState(), 0, 30, 9000);
    const r = splitTitleAt(s, 1, 75);
    expect(r.selection).toEqual({ kind: 'title', id: r.titles[1]!.id });
    // 左（元 id）ではないこと＝分割直後の打ち替え先が左に据え置かれないこと。
    expect(r.selection).not.toEqual({ kind: 'title', id: r.titles[0]!.id });
  });
  it('範囲外なら no-op', () => {
    const s = insertTitle(baseState(), 0, 30, 9000);
    expect(splitTitleAt(s, 1, 1000).titles).toHaveLength(1);
  });
});

describe('removeTitle', () => {
  it('削除し、選択中なら選択解除', () => {
    const s = insertTitle(baseState(), 0, 30, 9000);
    const r = removeTitle(s, 1);
    expect(r.titles).toHaveLength(0);
    expect(r.selection).toBeNull();
  });
});

describe('moveTitle', () => {
  const base = (over = {}) => ({
    telops: [], cutRegions: [], se: [], images: [], videoInserts: [], bgm: [],
    titles: [{ id: 1, originalStart: 100, originalEnd: 220, text: 'T' }],
    selection: null, multiTelopIds: [], nextTelopId: 1, nextSeId: 1, nextImageId: 1,
    nextVideoInsertId: 1, nextBgmId: 1, nextTitleId: 2,
    shapes: [], nextShapeId: 1,
    sceneTransitions: [], nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' as const }, mainSpeed: 1, segmentSpeeds: {}, segmentLayouts: {}, layoutKeyframes: [], ...over,
  });
  it('区間長を保って originalStart を変える', () => {
    const next = moveTitle(base(), 1, 50);
    expect(next.titles[0]!.originalStart).toBe(50);
    expect(next.titles[0]!.originalEnd).toBe(170);
  });
  it('originalStart < 0 は 0 へクランプ', () => {
    expect(moveTitle(base(), 1, -10).titles[0]).toMatchObject({ originalStart: 0, originalEnd: 120 });
  });
  it('非有限値・不在 ID は state をそのまま返す', () => {
    const s = base();
    expect(moveTitle(s, 1, Number.NaN)).toBe(s);
    expect(moveTitle(s, 99, 50)).toBe(s);
  });
});
