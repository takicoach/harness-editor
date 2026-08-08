import { describe, expect, it } from 'vitest';
import { presentationFor, timingFor } from './transitionPresentation';

describe('presentationFor', () => {
  it('fade 系・none は null（Transition を挟まない）', () => {
    expect(presentationFor('fadeBlack')).toBeNull();
    expect(presentationFor('fadeWhite')).toBeNull();
    expect(presentationFor('fadeColor')).toBeNull();
  });
  it('重なる系は presentation を返す', () => {
    expect(presentationFor('crossfade')).not.toBeNull();
    expect(presentationFor('slide', 'left')).not.toBeNull();
    expect(presentationFor('wipe', 'up')).not.toBeNull();
  });
});

describe('timingFor', () => {
  it('linearTiming を返す（getDurationInFrames が overlap）', () => {
    const t = timingFor(20);
    expect(t.getDurationInFrames({ fps: 30 })).toBe(20);
  });
});
