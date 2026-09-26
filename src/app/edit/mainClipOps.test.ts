import { describe, expect, it } from 'vitest';
import { cutOrderingOf } from '../../core/cutOrder';
import type { SegmentLayout } from '../../core/types';
import { initialEditState, type EditState } from './editState';
import {
  cutMainSourceRanges,
  deleteMainClip,
  mainClipDeleteBlockedReason,
  mainClipSplitBlockedReason,
  splitMainClip,
  mainClipTrimBounds,
  trimMainClip,
} from './mainClipOps';

function layout(scale: number): SegmentLayout {
  return { position: { x: 0, y: 0 }, scale, rotation: 0, flipH: false, flipV: false };
}

function state(): EditState {
  return {
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    originalTotalFrames: 300,
    cutRegions: [{ start: 100, end: 110 }, { start: 200, end: 210 }],
    segmentSpeeds: { 1: 1.25, 2: 1.5, 3: 2 },
    segmentLayouts: { 1: layout(1.1), 2: layout(1.2), 3: layout(1.3) },
    sceneTransitions: [
      { id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 10 },
      { id: 2, at: 100, kind: 'crossfade', durationFrames: 12 },
      { id: 3, at: 200, kind: 'fadeWhite', durationFrames: 8 },
      { id: 4, at: 'tail', kind: 'fadeBlack', durationFrames: 10 },
    ],
  };
}

it('finishing trim preserves clip order, speed/layout, transitions and independent overlays', () => {
  const before = state();
  before.cutOrder = [{ originalStart: 110, originalEnd: 200 }, { originalStart: 0, originalEnd: 100 }, { originalStart: 210, originalEnd: 300 }];
  before.images = [{ id: 1, file: 'a.png', type: 'photo', originalStart: 0, originalEnd: 10, timelinePlacement: { startFrame: 25, endFrame: 35 } }];
  const target = cutOrderingOf(before).segments.find(s => s.originalStart === 110)!;
  const trimmed = trimMainClip(before, target.id, 115, 195);
  expect(cutOrderingOf(trimmed).segments.map(s => [s.originalStart, s.originalEnd])).toEqual([[115, 195], [0, 100], [210, 300]]);
  const kept = cutOrderingOf(trimmed).segments[0]!;
  expect(trimmed.segmentSpeeds[kept.id]).toBe(before.segmentSpeeds[target.id]);
  expect(trimmed.segmentLayouts[kept.id]).toEqual(before.segmentLayouts[target.id]);
  expect(trimmed.images).toBe(before.images);
  expect(trimmed.sceneTransitions.find(t => t.id === 3)?.at).toBe(195);
  const restored = trimMainClip(trimmed, kept.id, 105, 205);
  expect(cutOrderingOf(restored).segments[0]).toMatchObject({ originalStart: 105, originalEnd: 205 });
  expect(mainClipTrimBounds(before, target.id)).toMatchObject({ min: 100, max: 210 });
  expect(trimMainClip(before, target.id, 99, 200)).toBe(before);
  expect(trimMainClip(before, target.id, 200, 200)).toBe(before);
});

function ranges(value: EditState) {
  return cutOrderingOf(value).segments.map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd }));
}

describe('splitMainClip', () => {
  it('persists a forward-adjacent split and copies source settings to both fragments', () => {
    const before = state();
    const after = splitMainClip(before, 150);

    expect(after.cutRegions).toBe(before.cutRegions);
    expect(after.cutOrder).toEqual([
      { originalStart: 0, originalEnd: 100 },
      { originalStart: 110, originalEnd: 150 },
      { originalStart: 150, originalEnd: 200 },
      { originalStart: 210, originalEnd: 300 },
    ]);
    expect(ranges(after)).toEqual(after.cutOrder);
    expect(after.segmentSpeeds).toEqual({ 1: 1.25, 2: 1.5, 3: 1.5, 4: 2 });
    expect(after.segmentLayouts).toEqual({ 1: layout(1.1), 2: layout(1.2), 3: layout(1.2), 4: layout(1.3) });
    expect(after.selection).toEqual({ kind: 'cutSegment', id: 3 });
    expect(after.sceneTransitions).toEqual(before.sceneTransitions);
    expect(before.cutOrder).toBeUndefined();
  });

  it('splits the source clip in its current playback position after reordering', () => {
    const before: EditState = {
      ...state(),
      cutOrder: [
        { originalStart: 210, originalEnd: 300 },
        { originalStart: 0, originalEnd: 100 },
        { originalStart: 110, originalEnd: 200 },
      ],
    };
    const after = splitMainClip(before, 150);
    expect(after.cutOrder).toEqual([
      { originalStart: 210, originalEnd: 300 },
      { originalStart: 0, originalEnd: 100 },
      { originalStart: 110, originalEnd: 150 },
      { originalStart: 150, originalEnd: 200 },
    ]);
    expect(after.segmentSpeeds).toEqual({ 1: 1.25, 2: 1.5, 3: 2, 4: 2 });
    expect(after.selection).toEqual({ kind: 'cutSegment', id: 4 });
  });

  it('is a no-op outside the interior of a kept clip', () => {
    const before = state();
    expect(splitMainClip(before, 100)).toBe(before);
    expect(splitMainClip(before, 105)).toBe(before);
    expect(splitMainClip(before, Number.NaN)).toBe(before);
  });

  it('rejects a split that would shorten an adjacent overlap transition', () => {
    const before: EditState = {
      ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
      originalTotalFrames: 180,
      cutRegions: [{ start: 60, end: 120 }],
      sceneTransitions: [{ id: 1, at: 60, kind: 'crossfade', durationFrames: 15 }],
      nextTransitionId: 2,
    };

    expect(mainClipSplitBlockedReason(before, 50)).toMatch(/場面転換の長さが変わります/);
    expect(splitMainClip(before, 50)).toBe(before);
    expect(mainClipSplitBlockedReason(before, 125)).toMatch(/場面転換の長さが変わります/);
    expect(splitMainClip(before, 125)).toBe(before);
  });

  it('allows a split far enough from an overlap and ignores non-overlap transitions', () => {
    const overlap: EditState = {
      ...initialEditState({ mainSpeed: 1.5, segmentSpeeds: { 1: 1.25, 2: 2 } }),
      originalTotalFrames: 240,
      cutRegions: [{ start: 90, end: 150 }],
      sceneTransitions: [{ id: 1, at: 90, kind: 'crossfade', durationFrames: 15 }],
      nextTransitionId: 2,
    };
    expect(mainClipSplitBlockedReason(overlap, 45)).toBeNull();
    expect(splitMainClip(overlap, 45)).not.toBe(overlap);

    const fade: EditState = {
      ...overlap,
      sceneTransitions: [{ id: 1, at: 90, kind: 'fadeBlack', durationFrames: 15 }],
    };
    expect(mainClipSplitBlockedReason(fade, 80)).toBeNull();
    expect(splitMainClip(fade, 80)).not.toBe(fade);
  });

  it('rejects only per-segment-speed splits whose independent rounding changes the completed duration', () => {
    const before: EditState = {
      ...initialEditState({ mainSpeed: 1, segmentSpeeds: { 1: 2 } }),
      originalTotalFrames: 60,
    };
    expect(mainClipSplitBlockedReason(before, 1)).toMatch(/速度の丸め/);
    expect(splitMainClip(before, 1)).toBe(before);
    expect(mainClipSplitBlockedReason(before, 2)).toBeNull();
    expect(splitMainClip(before, 2)).not.toBe(before);

    const uniform: EditState = { ...before, mainSpeed: 2, segmentSpeeds: {} };
    expect(mainClipSplitBlockedReason(uniform, 1)).toBeNull();
    expect(splitMainClip(uniform, 1)).not.toBe(uniform);
  });
});

describe('deleteMainClip', () => {
  it('ripple-cuts the selected source clip, remaps settings, and removes transitions whose source join disappeared', () => {
    const before: EditState = {
      ...state(),
      selection: { kind: 'cutSegment', id: 2 },
    };
    const after = deleteMainClip(before, 2);

    expect(after.cutRegions).toEqual([{ start: 100, end: 210 }]);
    expect(after.cutOrder).toEqual([
      { originalStart: 0, originalEnd: 100 },
      { originalStart: 210, originalEnd: 300 },
    ]);
    expect(after.segmentSpeeds).toEqual({ 1: 1.25, 2: 2 });
    expect(after.segmentLayouts).toEqual({ 1: layout(1.1), 2: layout(1.3) });
    expect(after.selection).toBeNull();
    expect(after.multiTelopIds).toEqual([]);
    expect(after.sceneTransitions).toEqual([
      { id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 10 },
      { id: 4, at: 'tail', kind: 'fadeBlack', durationFrames: 10 },
    ]);
  });

  it('preserves the playback order of the remaining clips', () => {
    const before: EditState = {
      ...state(),
      cutOrder: [
        { originalStart: 210, originalEnd: 300 },
        { originalStart: 0, originalEnd: 100 },
        { originalStart: 110, originalEnd: 200 },
      ],
    };
    expect(deleteMainClip(before, 2).cutOrder).toEqual([
      { originalStart: 210, originalEnd: 300 },
      { originalStart: 110, originalEnd: 200 },
    ]);
  });

  it('keeps the state unchanged and exports a reason when deletion would remove all video', () => {
    const before: EditState = {
      ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
      originalTotalFrames: 300,
    };
    expect(mainClipDeleteBlockedReason(before, 1)).toMatch(/少なくとも1つ/);
    expect(deleteMainClip(before, 1)).toBe(before);
    expect(cutMainSourceRanges(before, [{ start: 0, end: 300 }])).toBe(before);
    expect(mainClipDeleteBlockedReason(state(), 2)).toBeNull();
  });
});

describe('cutMainSourceRanges', () => {
  it('cuts several source ranges in one pure update and explicitly preserves every resulting clip', () => {
    const before: EditState = {
      ...initialEditState({ mainSpeed: 1, segmentSpeeds: { 1: 1.5 } }),
      originalTotalFrames: 300,
      segmentLayouts: { 1: layout(1.2) },
      selection: { kind: 'mainVideo' },
    };
    const snapshot = structuredClone(before);
    const after = cutMainSourceRanges(before, [{ start: 50, end: 70 }, { start: 150, end: 170 }]);

    expect(after.cutRegions).toEqual([{ start: 50, end: 70 }, { start: 150, end: 170 }]);
    expect(after.cutOrder).toEqual([
      { originalStart: 0, originalEnd: 50 },
      { originalStart: 70, originalEnd: 150 },
      { originalStart: 170, originalEnd: 300 },
    ]);
    expect(after.segmentSpeeds).toEqual({ 1: 1.5, 2: 1.5, 3: 1.5 });
    expect(after.segmentLayouts).toEqual({ 1: layout(1.2), 2: layout(1.2), 3: layout(1.2) });
    expect(after.selection).toBeNull();
    expect(before).toEqual(snapshot);
  });

  it('moves a transition to the trimmed source boundary without attaching it to another clip', () => {
    const before: EditState = {
      ...state(),
      sceneTransitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 12 }],
    };
    const after = cutMainSourceRanges(before, [{ start: 95, end: 100 }]);
    expect(after.sceneTransitions).toEqual([{ id: 1, at: 95, kind: 'crossfade', durationFrames: 12 }]);
  });

  it('is a no-op for empty, invalid, or already-cut source ranges', () => {
    const before = state();
    expect(cutMainSourceRanges(before, [])).toBe(before);
    expect(cutMainSourceRanges(before, [{ start: Number.NaN, end: 10 }])).toBe(before);
    expect(cutMainSourceRanges(before, [{ start: 101, end: 109 }])).toBe(before);
  });
});
