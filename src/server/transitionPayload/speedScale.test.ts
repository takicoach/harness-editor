import { describe, it, expect } from 'vitest';
import { speedScaleFrame, scaleSegments, scaleTransitions } from './speedScale';
import { speedScale } from '../../core/speedEngine';
import type { CutSegment, SceneTransition } from './types';

describe('speedScaleFrame', () => {
  it('rate===1 は恒等', () => {
    expect(speedScaleFrame(123, 1)).toBe(123);
  });
  it('round(f/rate)', () => {
    expect(speedScaleFrame(100, 0.5)).toBe(200);
    expect(speedScaleFrame(100, 2)).toBe(50);
    expect(speedScaleFrame(101, 2)).toBe(51);
  });
  it('core speedScale と一致（広範囲）', () => {
    for (const f of [0, 1, 7, 50, 101, 999, 1234]) {
      for (const r of [1, 0.5, 0.1, 2, 3, 16, 1.5]) {
        expect(speedScaleFrame(f, r)).toBe(speedScale(f, r));
      }
    }
  });
});

describe('scaleSegments', () => {
  const segs: CutSegment[] = [{ id: 1, originalStart: 10, originalEnd: 110, playbackStart: 0, playbackEnd: 100 }];
  it('rate===1 は同一参照', () => {
    expect(scaleSegments(segs, 1)).toBe(segs);
  });
  it('playbackStart/End のみスケール・original 不変', () => {
    const out = scaleSegments(segs, 0.5);
    expect(out[0]).toEqual({ id: 1, originalStart: 10, originalEnd: 110, playbackStart: 0, playbackEnd: 200 });
  });
});

describe('scaleTransitions', () => {
  const trans: SceneTransition[] = [
    { id: 1, at: 100, kind: 'crossfade', durationFrames: 20 },
    { id: 2, at: 'head', kind: 'fadeBlack', durationFrames: 15 },
  ];
  it('rate===1 は同一参照', () => {
    expect(scaleTransitions(trans, 1)).toBe(trans);
  });
  it('数値 at と durationFrames をスケール・head は据え置き', () => {
    const out = scaleTransitions(trans, 0.5);
    expect(out[0]).toMatchObject({ at: 200, durationFrames: 40 });
    expect(out[1]).toMatchObject({ at: 'head', durationFrames: 30 });
  });
});
