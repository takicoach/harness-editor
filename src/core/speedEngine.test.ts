import { describe, it, expect } from 'vitest';
import {
  MIN_MAIN_SPEED, MAX_MAIN_SPEED, DEFAULT_MAIN_SPEED,
  clampMainSpeed, speedScale, speedUnscale,
  hasPerSegmentSpeed,
  resolveSpeedSegments,
  speedTotalFrames,
  playbackToSpeed,
  speedToPlayback,
} from './speedEngine';

describe('speedEngine', () => {
  it('定数', () => {
    expect(MIN_MAIN_SPEED).toBe(0.1);
    expect(MAX_MAIN_SPEED).toBe(16);
    expect(DEFAULT_MAIN_SPEED).toBe(1);
  });
  it('clampMainSpeed は [0.1,16] へ。非有限は下限', () => {
    expect(clampMainSpeed(0.05)).toBe(0.1);
    expect(clampMainSpeed(99)).toBe(16);
    expect(clampMainSpeed(0.9)).toBe(0.9);
    expect(clampMainSpeed(Number.NaN)).toBe(0.1);
  });
  it('speedScale: rate=1 恒等 / 0.5x で 2 倍 / 2x で半分', () => {
    expect(speedScale(123, 1)).toBe(123);
    expect(speedScale(100, 0.5)).toBe(200);
    expect(speedScale(100, 2)).toBe(50);
  });
  it('speedUnscale: rate=1 恒等 / 逆変換', () => {
    expect(speedUnscale(123, 1)).toBe(123);
    expect(speedUnscale(200, 0.5)).toBe(100);
    expect(speedUnscale(50, 2)).toBe(100);
  });
});

describe('hasPerSegmentSpeed', () => {
  it('個別指定ゼロなら false', () => {
    expect(hasPerSegmentSpeed({}, 1)).toBe(false);
    expect(hasPerSegmentSpeed({}, 0.5)).toBe(false);
  });
  it('全エントリが mainSpeed と一致なら false（冗長＝一律と同値）', () => {
    expect(hasPerSegmentSpeed({ 3: 2, 7: 2 }, 2)).toBe(false);
  });
  it('1 つでも mainSpeed と異なれば true', () => {
    expect(hasPerSegmentSpeed({ 3: 0.5 }, 1)).toBe(true);
    expect(hasPerSegmentSpeed({ 3: 2, 7: 1 }, 2)).toBe(true);
  });
});

describe('resolveSpeedSegments', () => {
  const segs = [
    { id: 1, playbackStart: 0, playbackEnd: 100 },
    { id: 2, playbackStart: 100, playbackEnd: 200 },
  ];
  it('個別指定があればそれ、無ければ mainSpeed', () => {
    const r = resolveSpeedSegments(segs, 1, { 2: 0.5 });
    expect(r).toEqual([
      { id: 1, start: 0, end: 100, rate: 1 },
      { id: 2, start: 100, end: 200, rate: 0.5 },
    ]);
  });
  it('個別指定はクランプされる', () => {
    const r = resolveSpeedSegments(segs, 1, { 1: 999 });
    expect(r.at(0)?.rate).toBe(16);
  });
});

describe('playbackToSpeed / speedToPlayback / speedTotalFrames', () => {
  // 区間1: [0,100) rate1 → 速度後 100 / 区間2: [100,200) rate0.5 → 速度後 200
  const segs = resolveSpeedSegments(
    [
      { id: 1, playbackStart: 0, playbackEnd: 100 },
      { id: 2, playbackStart: 100, playbackEnd: 200 },
    ],
    1,
    { 2: 0.5 },
  );
  it('総尺は各区間 round(len/rate) の合算', () => {
    expect(speedTotalFrames(segs)).toBe(100 + 200);
  });
  it('区間境界で累積オフセット', () => {
    expect(playbackToSpeed(0, segs)).toBe(0);
    expect(playbackToSpeed(100, segs)).toBe(100); // 区間1の終端＝区間2の始端
    expect(playbackToSpeed(150, segs)).toBe(100 + 100); // 区間2内 50/0.5=100
    expect(playbackToSpeed(200, segs)).toBe(300);
  });
  it('speedToPlayback は playbackToSpeed の逆（境界・区間内）', () => {
    expect(speedToPlayback(0, segs)).toBe(0);
    expect(speedToPlayback(100, segs)).toBe(100);
    expect(speedToPlayback(200, segs)).toBe(150);
    expect(speedToPlayback(300, segs)).toBe(200);
  });
  it('範囲外は端でクランプ', () => {
    expect(playbackToSpeed(-10, segs)).toBe(0);
    expect(playbackToSpeed(999, segs)).toBe(300);
    expect(speedToPlayback(-10, segs)).toBe(0);
    expect(speedToPlayback(999, segs)).toBe(200);
  });
});
