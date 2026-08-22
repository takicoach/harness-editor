import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, createHistory, current, pushState, redo, undo, HISTORY_LIMIT } from './history';
import type { EditState } from './editState';

function st(id: number): EditState {
  // selection を id 由来で変えておくことで、履歴が selection も含めて
  // スナップショットを保持していることを検証できる。
  return {
    telops: [],
    cutRegions: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    selection: id === 0 ? null : { kind: 'telop' as const, id },
    multiTelopIds: [],
    nextTelopId: id,
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

describe('history スタック', () => {
  it('初期履歴は 1 件、Undo/Redo 不可', () => {
    const h = createHistory(st(0));
    expect(current(h).nextTelopId).toBe(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('pushState で進み、undo で戻る', () => {
    let h = createHistory(st(0));
    h = pushState(h, st(1));
    h = pushState(h, st(2));
    expect(current(h).nextTelopId).toBe(2);
    // 履歴は selection も含めてスナップショットを保持する。
    expect(current(h).selection).toEqual({ kind: 'telop', id: 2 });
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(current(h).nextTelopId).toBe(1);
    expect(current(h).selection).toEqual({ kind: 'telop', id: 1 });
    h = undo(h);
    expect(current(h).nextTelopId).toBe(0);
    expect(current(h).selection).toBeNull();
    expect(canUndo(h)).toBe(false);
  });

  it('undo 後の redo で復帰する', () => {
    let h = createHistory(st(0));
    h = pushState(h, st(1));
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(current(h).nextTelopId).toBe(1);
    expect(canRedo(h)).toBe(false);
  });

  it('undo 後に pushState すると redo 分岐が捨てられる', () => {
    let h = createHistory(st(0));
    h = pushState(h, st(1));
    h = pushState(h, st(2));
    h = undo(h); // index -> 1 (st1)
    h = pushState(h, st(9)); // st2 を捨てて st9
    expect(current(h).nextTelopId).toBe(9);
    expect(canRedo(h)).toBe(false);
    h = undo(h);
    expect(current(h).nextTelopId).toBe(1);
  });

  it('履歴は HISTORY_LIMIT 件で頭から切り捨てる', () => {
    let h = createHistory(st(0));
    for (let i = 1; i <= HISTORY_LIMIT + 5; i++) {
      h = pushState(h, st(i));
    }
    expect(current(h).nextTelopId).toBe(HISTORY_LIMIT + 5);
    // 上限まで undo しても最古は切り捨て済み（0 へは戻れない）
    let count = 0;
    while (canUndo(h)) {
      h = undo(h);
      count++;
    }
    expect(count).toBe(HISTORY_LIMIT - 1);
  });
});
