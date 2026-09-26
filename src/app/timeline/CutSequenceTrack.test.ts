import { describe, expect, it } from 'vitest';
import { cutSequenceLayout, cutSequenceThumbnailFrames, sequenceRangeToSource } from './CutSequenceTrack';

describe('cutSequenceLayout', () => {
  it('maps a swept range through reordered and speed-adjusted clips without cutting the source gap', () => {
    expect(sequenceRangeToSource([
      { id: 1, originalStart: 200, originalEnd: 300, playbackStart: 0, playbackEnd: 50 },
      { id: 2, originalStart: 0, originalEnd: 120, playbackStart: 50, playbackEnd: 170 },
    ], [], 40, 70)).toEqual([{ start: 280, end: 300 }, { start: 0, end: 20 }]);
  });
  it('includes both visible source contributions inside a crossfade', () => {
    expect(sequenceRangeToSource([
      { id: 1, originalStart: 0, originalEnd: 60, playbackStart: 0, playbackEnd: 60 },
      { id: 2, originalStart: 120, originalEnd: 180, playbackStart: 60, playbackEnd: 120 },
    ], [{ boundary: 60, overlap: 15 }], 50, 55)).toEqual([{ start: 50, end: 55 }, { start: 125, end: 130 }]);
  });
  it('keeps playback order and uses the speed-adjusted playback duration for both lanes', () => {
    const layouts = cutSequenceLayout([
      { id: 1, originalStart: 200, originalEnd: 300, playbackStart: 0, playbackEnd: 50 },
      { id: 2, originalStart: 0, originalEnd: 120, playbackStart: 50, playbackEnd: 170 },
    ], 2, []);
    expect(layouts).toEqual([
      { id: 1, originalStart: 200, originalEnd: 300, sourceFramesPerFinalFrame: 2, left: 88, width: 100 },
      { id: 2, originalStart: 0, originalEnd: 120, sourceFramesPerFinalFrame: 1, left: 188, width: 240 },
    ]);
  });

  it('uses final coordinates after a transition overlap', () => {
    const layouts = cutSequenceLayout([
      { id: 1, originalStart: 0, originalEnd: 60, playbackStart: 0, playbackEnd: 60 },
      { id: 2, originalStart: 120, originalEnd: 180, playbackStart: 60, playbackEnd: 120 },
    ], 1, [{ boundary: 60, overlap: 15 }]);
    expect(layouts.map(({ left, width }) => ({ left, width }))).toEqual([
      { left: 88, width: 60 },
      { left: 133, width: 60 },
    ]);
  });

  it('chooses source frames through the reordered layout', () => {
    const layouts = cutSequenceLayout([
      { id: 1, originalStart: 200, originalEnd: 300, playbackStart: 0, playbackEnd: 100 },
      { id: 2, originalStart: 0, originalEnd: 100, playbackStart: 100, playbackEnd: 200 },
    ], 1, []);
    expect(cutSequenceThumbnailFrames(layouts, 2)).toEqual([250, 50]);
  });
});
