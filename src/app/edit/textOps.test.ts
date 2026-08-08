import { describe, expect, it } from 'vitest';
import { setTelopText } from './textOps';
import type { EditState } from './editState';

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

describe('setTelopText', () => {
  it('指定 ID のテロップ本文だけを書き換える（カットは発生しない）', () => {
    const next = setTelopText(state(), 2, '長いアイアン3本ですね');
    expect(next.telops[1]?.text).toBe('長いアイアン3本ですね');
    expect(next.telops[0]?.text).toBe('ゆる素振り');
    expect(next.cutRegions).toEqual([]);
  });

  it('元の state を破壊しない（新しいオブジェクトを返す）', () => {
    const before = state();
    const next = setTelopText(before, 1, '変更');
    expect(before.telops[0]?.text).toBe('ゆる素振り');
    expect(next).not.toBe(before);
    expect(next.telops[0]).not.toBe(before.telops[0]);
  });

  it('存在しない ID はそのまま返す', () => {
    const before = state();
    const next = setTelopText(before, 999, 'x');
    expect(next.telops).toEqual(before.telops);
  });

  it('空文字も許可する（テロップ本文を空にできる）', () => {
    const next = setTelopText(state(), 1, '');
    expect(next.telops[0]?.text).toBe('');
  });
});
