import { describe, expect, it } from 'vitest';
import { sequenceSourceFrameAt } from './CutSequenceTrack';

const segments = [
  { id: 1, originalStart: 0, originalEnd: 60, playbackStart: 0, playbackEnd: 60 },
  { id: 2, originalStart: 120, originalEnd: 180, playbackStart: 60, playbackEnd: 120 },
];
const overlaps = [{ boundary: 60, overlap: 15 }];

describe('sequenceSourceFrameAt independent audit', () => {
  it('targets the visually-front later clip inside an overlap when nothing is selected', () => {
    expect(sequenceSourceFrameAt(segments, overlaps, 50)).toEqual({ segmentId: 2, originalFrame: 125 });
  });

  it('uses the selected overlapping clip when it contains the playhead, without forcing an unrelated selection', () => {
    expect(sequenceSourceFrameAt(segments, overlaps, 50, 1)).toEqual({ segmentId: 1, originalFrame: 50 });
    expect(sequenceSourceFrameAt(segments, overlaps, 50, 99)).toEqual({ segmentId: 2, originalFrame: 125 });
    expect(sequenceSourceFrameAt(segments, overlaps, 120)).toBeNull();
  });
});
