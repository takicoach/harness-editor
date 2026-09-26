import { describe, expect, it } from 'vitest';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { cutOrderingOf } from '../../core/cutOrder';
import { initialEditState, samePersistedContent, toEditorProject, type EditState } from './editState';
import { moveCutSegment } from './cutOrderOps';
import type { EditorProject, SegmentLayout } from '../../core/types';

function layout(scale: number): SegmentLayout {
  return { ...DEFAULT_MAIN_LAYOUT, scale };
}

function state(): EditState {
  return {
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    originalTotalFrames: 300,
    cutRegions: [{ start: 100, end: 110 }, { start: 200, end: 210 }],
    segmentSpeeds: { 1: 1.5, 2: 2 },
    segmentLayouts: { 1: layout(1.2), 2: layout(1.4) },
    selection: { kind: 'cutSegment', id: 1 },
  };
}

describe('moveCutSegment', () => {
  it('moves the source clip and carries its per-clip settings and selection', () => {
    const before = state();
    const moved = moveCutSegment(before, 1, 2);
    expect(cutOrderingOf(moved).segments.map((segment) => segment.originalStart)).toEqual([110, 210, 0]);
    expect(moved.cutOrder).toEqual([
      { originalStart: 110, originalEnd: 200 },
      { originalStart: 210, originalEnd: 300 },
      { originalStart: 0, originalEnd: 100 },
    ]);
    expect(moved.segmentSpeeds).toEqual({ 1: 2, 3: 1.5 });
    expect(moved.segmentLayouts).toEqual({ 1: layout(1.4), 3: layout(1.2) });
    expect(moved.selection).toEqual({ kind: 'cutSegment', id: 3 });
    expect(before.cutOrder).toBeUndefined();
  });

  it('returns the same state for an invalid or unchanged move', () => {
    const before = state();
    expect(moveCutSegment(before, 99, 0)).toBe(before);
    expect(moveCutSegment(before, 2, 1)).toBe(before);
  });

  it('is persisted and participates in dirty comparison', () => {
    const before = state();
    const moved = moveCutSegment(before, 1, 2);
    expect(samePersistedContent(before, moved)).toBe(false);
    const base = {
      cutOrder: before.cutOrder,
      videoConfig: { durationFrames: 300 },
    } as EditorProject;
    expect(toEditorProject(moved, base).cutOrder).toEqual(moved.cutOrder);
  });
});
