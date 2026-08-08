import { describe, it, expect } from 'vitest';
import {
  MIN_TIMELINE_H,
  DEFAULT_TIMELINE_H,
  maxTimelineHeight,
  clampTimelineHeight,
  computeResizeHeight,
  parseStoredHeight,
} from './timelineHeight';

describe('maxTimelineHeight', () => {
  it('viewport の 70%', () => {
    expect(maxTimelineHeight(1000)).toBe(700);
  });
});

describe('clampTimelineHeight', () => {
  it('中間値はそのまま', () => {
    expect(clampTimelineHeight(400, 1000)).toBe(400);
  });
  it('下限 192 で止まる', () => {
    expect(clampTimelineHeight(100, 1000)).toBe(MIN_TIMELINE_H);
  });
  it('上限（viewport*0.7）で止まる', () => {
    expect(clampTimelineHeight(900, 1000)).toBe(700);
  });
  it('極小 viewport では下限が勝つ', () => {
    expect(clampTimelineHeight(150, 200)).toBe(MIN_TIMELINE_H);
  });
});

describe('computeResizeHeight', () => {
  it('上ドラッグで高くなる（currentY < startY）', () => {
    expect(computeResizeHeight(300, 500, 400, 1000)).toBe(400);
  });
  it('下ドラッグで低くなる', () => {
    expect(computeResizeHeight(300, 500, 560, 1000)).toBe(240);
  });
  it('下げすぎても下限 192', () => {
    expect(computeResizeHeight(300, 500, 900, 1000)).toBe(MIN_TIMELINE_H);
  });
  it('上げすぎても上限でクランプ', () => {
    expect(computeResizeHeight(600, 500, 100, 1000)).toBe(700);
  });
});

describe('parseStoredHeight', () => {
  it('正常値を数値で返す', () => {
    expect(parseStoredHeight('320')).toBe(320);
  });
  it('null は null', () => {
    expect(parseStoredHeight(null)).toBeNull();
  });
  it('非数は null', () => {
    expect(parseStoredHeight('abc')).toBeNull();
  });
  it('0 と負値は null', () => {
    expect(parseStoredHeight('0')).toBeNull();
    expect(parseStoredHeight('-5')).toBeNull();
  });
});

it('DEFAULT は 240・MIN は 192（既定は最小より一回り高い）', () => {
  expect(DEFAULT_TIMELINE_H).toBe(240);
  expect(MIN_TIMELINE_H).toBe(192);
});
