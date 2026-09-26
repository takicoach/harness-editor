import { describe, expect, it } from 'vitest';
import { applyPreferenceEdit } from './preferenceEdit';
import type { EditState } from './editState';
import { createHistory, current, pushState, undo } from './history';

const state: EditState = {
  telops: [{ id: 1, originalStart: 30, originalEnd: 60, text: '素振りする' }],
  cutRegions: [{ start: 0, end: 20 }], se: [], images: [], videoInserts: [], bgm: [], titles: [], shapes: [],
  selection: { kind: 'telop', id: 1 }, multiTelopIds: [], nextTelopId: 2, nextSeId: 1, nextImageId: 1,
  nextVideoInsertId: 1, nextBgmId: 1, nextTitleId: 1, nextShapeId: 1,
  sceneTransitions: [], nextTransitionId: 1, ducking: { enabled: true, strength: 'mid' },
  mainSpeed: 2, segmentSpeeds: {}, segmentLayouts: {}, layoutKeyframes: [],
};
const context = { projectId: 'video', projectRevision: 'session:2' };
const proposal = { ...context, elementId: '1', before: '素振りする', after: '素振りをする',
  sourceFrameRange: { start: 30, end: 60 }, rule: { id: 'rule', version: 1 }, evidenceIds: ['d1'] };
describe('好みの提案を既存の編集履歴へ反映', () => {
  it('字幕以外の未保存内容と選択を保ち、既存undoで戻せる', () => {
    const next = applyPreferenceEdit(state, proposal, context);
    expect(next.telops[0]?.text).toBe('素振りをする');
    expect(next.cutRegions).toBe(state.cutRegions);
    expect(next.selection).toBe(state.selection);
    expect(next.mainSpeed).toBe(2);
    const history = pushState(createHistory(state), next);
    expect(current(undo(history))).toEqual(state);
  });
  it('案件、版、本文、範囲、対象が変わった古い提案を拒否する', () => {
    for (const patch of [{ projectId: 'other' }, { projectRevision: 'session:3' }, { before: '異なる本文' },
      { sourceFrameRange: { start: 31, end: 60 } }, { elementId: 'missing' }]) {
      expect(() => applyPreferenceEdit(state, { ...proposal, ...patch }, context)).toThrow(/STALE_PROPOSAL/);
    }
    expect(state.telops[0]?.text).toBe('素振りする');
  });
});
