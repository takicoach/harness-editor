import { describe, it, expect } from 'vitest';
import { clipFramesFromDuration, SE_FALLBACK_FRAMES } from './audioClipGeometry';

describe('clipFramesFromDuration', () => {
  it('長さ×fps を四捨五入（最低1）', () => {
    expect(clipFramesFromDuration(2, 30, SE_FALLBACK_FRAMES)).toBe(60);
    expect(clipFramesFromDuration(0.5, 30, SE_FALLBACK_FRAMES)).toBe(15);
    expect(clipFramesFromDuration(0.001, 30, SE_FALLBACK_FRAMES)).toBe(1); // round(0.03)=0 → max(1,0)=1
  });
  it('長さ不明（null/非有限/0以下）は fallback', () => {
    expect(clipFramesFromDuration(null, 30, SE_FALLBACK_FRAMES)).toBe(SE_FALLBACK_FRAMES);
    expect(clipFramesFromDuration(Number.NaN, 30, SE_FALLBACK_FRAMES)).toBe(SE_FALLBACK_FRAMES);
    expect(clipFramesFromDuration(0, 30, SE_FALLBACK_FRAMES)).toBe(SE_FALLBACK_FRAMES);
    expect(clipFramesFromDuration(-1, 30, SE_FALLBACK_FRAMES)).toBe(SE_FALLBACK_FRAMES);
  });
  it('fps<=0 は fallback（ゼロ/負で破綻しない）', () => {
    expect(clipFramesFromDuration(2, 0, SE_FALLBACK_FRAMES)).toBe(SE_FALLBACK_FRAMES);
  });
});
