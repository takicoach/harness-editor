import { describe, it, expect } from 'vitest';
import { planUnifiedSeries, type UnifiedSequenceItem, type UnifiedTransitionItem } from './unifiedSeries';
import type { CutSegment, SceneTransition } from './types';

const segs: CutSegment[] = [
  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 100, originalEnd: 200, playbackStart: 100, playbackEnd: 200 },
];
const crossfade: SceneTransition[] = [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 20 }];

describe('planUnifiedSeries', () => {
  it('mainSpeed=1: [seq, transition, seq]・区間は endAt・crossfade overlap=20', () => {
    const items = planUnifiedSeries(segs, crossfade, 1);
    expect(items.map((i) => i.type)).toEqual(['sequence', 'transition', 'sequence']);
    const seq0 = items[0] as UnifiedSequenceItem;
    expect(seq0).toMatchObject({ durationInFrames: 100, startFrom: 0, endAt: 100 });
    expect(seq0.playbackRate).toBeUndefined();
    const tr = items[1] as UnifiedTransitionItem;
    expect(tr).toMatchObject({ kind: 'crossfade', overlap: 20, boundary: 100 });
  });

  it('mainSpeed=0.5: 尺・overlap 倍・区間は playbackRate=0.5・endAt 無し', () => {
    const items = planUnifiedSeries(segs, crossfade, 0.5);
    const seq0 = items[0] as UnifiedSequenceItem;
    expect(seq0.durationInFrames).toBe(200);
    expect(seq0.startFrom).toBe(0);
    expect(seq0.endAt).toBeUndefined();
    expect(seq0.playbackRate).toBe(0.5);
    const tr = items[1] as UnifiedTransitionItem;
    expect(tr.overlap).toBe(40);
    expect(tr.boundary).toBe(200);
  });

  it('transitions 空: 全 sequence・transition 無し（後方互換）', () => {
    const items = planUnifiedSeries(segs, [], 1);
    expect(items.map((i) => i.type)).toEqual(['sequence', 'sequence']);
  });

  it('fade 系（重なり無し）は transition item を出さない', () => {
    const fade: SceneTransition[] = [{ id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 }];
    const items = planUnifiedSeries(segs, fade, 1);
    expect(items.map((i) => i.type)).toEqual(['sequence', 'sequence']);
  });
});
