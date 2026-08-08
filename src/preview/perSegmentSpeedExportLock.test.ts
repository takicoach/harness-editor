// src/preview/perSegmentSpeedExportLock.test.ts
import { describe, it, expect } from 'vitest';
import { speedSegments, speedCompositionDuration } from '../server/speedPayload/speedSegments';
import { resolveSpeedSegments, playbackToSpeed, speedTotalFrames } from '../core/speedEngine';

const CUTS = [
  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 300, originalEnd: 360, playbackStart: 100, playbackEnd: 160 },
  { id: 3, originalStart: 500, originalEnd: 540, playbackStart: 160, playbackEnd: 200 },
];

describe('payload 区分線形 == core 区分線形（preview=export lock）', () => {
  const SEG_SPEEDS = { 1: 0.5, 3: 2 }; // 2 は mainSpeed に従う
  const MAIN = 1;
  const segs = resolveSpeedSegments(CUTS, MAIN, SEG_SPEEDS);

  it('各区間の from が core playbackToSpeed(playbackStart) と一致', () => {
    const payloadSegs = speedSegments(CUTS, MAIN, SEG_SPEEDS);
    CUTS.forEach((cut, i) => {
      expect(payloadSegs[i]!.from).toBe(playbackToSpeed(cut.playbackStart, segs));
    });
  });
  it('合成尺が core speedTotalFrames と一致', () => {
    const cutDuration = CUTS.at(-1)!.playbackEnd; // 200
    expect(speedCompositionDuration(CUTS, cutDuration, MAIN, SEG_SPEEDS)).toBe(speedTotalFrames(segs));
  });
  it('複数 rate・クランプ境界（0.1 / 16）でも一致', () => {
    const ss = { 1: 0.1, 2: 16 };
    const segs2 = resolveSpeedSegments(CUTS, 1, ss);
    const payloadSegs = speedSegments(CUTS, 1, ss);
    CUTS.forEach((cut, i) => {
      expect(payloadSegs[i]!.from).toBe(playbackToSpeed(cut.playbackStart, segs2));
    });
  });
  it('範囲外 rate(0.05/32) は clamp 後に payload==core で一致', () => {
    const ss = { 1: 0.05, 2: 32 }; // clamp→0.1 / 16
    const segsX = resolveSpeedSegments(CUTS, 1, ss);
    const payloadSegs = speedSegments(CUTS, 1, ss);
    CUTS.forEach((cut, i) => {
      expect(payloadSegs[i]!.from).toBe(playbackToSpeed(cut.playbackStart, segsX));
    });
    expect(speedCompositionDuration(CUTS, CUTS.at(-1)!.playbackEnd, 1, ss)).toBe(speedTotalFrames(segsX));
  });
});
