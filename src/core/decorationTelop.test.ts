import { describe, it, expect } from 'vitest';
import {
  isDecorationTelop,
  partitionTelops,
  DECORATION_DEFAULT_POSITION,
  DECORATION_DEFAULT_DURATION_SEC,
} from './decorationTelop';

describe('isDecorationTelop', () => {
  it('manual:true を飾りと判定する', () => {
    expect(isDecorationTelop({ manual: true })).toBe(true);
  });
  it('manual 無し/false は字幕扱い', () => {
    expect(isDecorationTelop({})).toBe(false);
    expect(isDecorationTelop({ manual: false })).toBe(false);
  });
});

describe('partitionTelops', () => {
  it('字幕と飾りを順序保持で分ける', () => {
    const telops = [
      { id: 1, manual: false },
      { id: 2, manual: true },
      { id: 3 },
      { id: 4, manual: true },
    ];
    const { subtitles, decorations } = partitionTelops(telops);
    expect(subtitles.map((t) => t.id)).toEqual([1, 3]);
    expect(decorations.map((t) => t.id)).toEqual([2, 4]);
  });
});

describe('既定値', () => {
  it('左上既定位置と既定尺', () => {
    expect(DECORATION_DEFAULT_POSITION).toEqual({ x: -0.55, y: -0.85 });
    expect(DECORATION_DEFAULT_DURATION_SEC).toBe(5);
  });
});
