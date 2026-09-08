import { describe, it, expect } from 'vitest';
import { restoreDragTarget } from './dragCancel';
import { initialEditState, type EditState } from '../edit/editState';

function base(): EditState {
  return {
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops: [
      { id: 1, originalStart: 100, originalEnd: 200, text: 'A', template: 1 },
      { id: 2, originalStart: 500, originalEnd: 600, text: 'B', template: 1 },
    ],
    se: [{ id: 7, originalStart: 10, originalEnd: 40, file: 'pop.mp3' }],
    cutRegions: [{ start: 0, end: 50 }],
    selection: { kind: 'telop', id: 1 },
  };
}

describe('restoreDragTarget', () => {
  it('掴んだテロップの区間だけを戻す', () => {
    const before = base();
    const current: EditState = {
      ...before,
      telops: before.telops.map((t) => (t.id === 2 ? { ...t, originalStart: 900, originalEnd: 1000 } : t)),
      selection: { kind: 'telop', id: 2 },
    };
    const next = restoreDragTarget(current, before, { kind: 'telop', id: 2 });
    expect(next.telops.find((t) => t.id === 2)).toEqual(before.telops[1]);
  });

  it('選択（selection / multiTelopIds）は巻き戻さない＝掴んだ対象のまま残る', () => {
    const before = base();
    const current: EditState = { ...before, selection: { kind: 'telop', id: 2 }, multiTelopIds: [1, 2] };
    const next = restoreDragTarget(current, before, { kind: 'telop', id: 2 });
    expect(next.selection).toEqual({ kind: 'telop', id: 2 });
    expect(next.multiTelopIds).toEqual([1, 2]);
  });

  it('掴んでいない対象へドラッグ中に入った変更を巻き添えで捨てない', () => {
    const before = base();
    const current: EditState = {
      ...before,
      telops: [
        { ...before.telops[0]!, text: 'ドラッグ中に別経路で書き換えた' },
        { ...before.telops[1]!, originalStart: 900, originalEnd: 1000 },
      ],
      se: [{ ...before.se[0]!, originalStart: 999 }],
    };
    const next = restoreDragTarget(current, before, { kind: 'telop', id: 2 });
    expect(next.telops.find((t) => t.id === 1)?.text).toBe('ドラッグ中に別経路で書き換えた');
    expect(next.se[0]?.originalStart, 'SE も掴んでいないので現在値のまま').toBe(999);
  });

  it('cut はカット区間だけを戻す（選択・テロップは現在値）', () => {
    const before = base();
    const current: EditState = {
      ...before,
      cutRegions: [{ start: 0, end: 300 }],
      selection: { kind: 'cutSegment', id: 3 },
    };
    const next = restoreDragTarget(current, before, { kind: 'cut' });
    expect(next.cutRegions).toEqual(before.cutRegions);
    expect(next.selection).toEqual({ kind: 'cutSegment', id: 3 });
  });

  it('ドラッグ前に存在しない対象は触らない（戻す先が無い）', () => {
    const before = base();
    const current: EditState = {
      ...before,
      telops: [...before.telops, { id: 99, originalStart: 0, originalEnd: 10, text: '新', template: 1 }],
    };
    const next = restoreDragTarget(current, before, { kind: 'telop', id: 99 });
    expect(next.telops).toHaveLength(3);
  });
});
