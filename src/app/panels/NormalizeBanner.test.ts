import { describe, it, expect } from 'vitest';
import { normalizePhaseLabelJa } from './NormalizeBanner';

describe('normalizePhaseLabelJa', () => {
  it('フェーズ→日本語', () => {
    expect(normalizePhaseLabelJa('preparing')).toBe('準備中');
    expect(normalizePhaseLabelJa('measuring')).toBe('音量を測定中');
    expect(normalizePhaseLabelJa('normalizing')).toBe('音量を調整中');
    expect(normalizePhaseLabelJa('finalizing')).toBe('書き出し中');
  });
  it('未知フェーズはそのまま返す', () => {
    expect(normalizePhaseLabelJa('xyz')).toBe('xyz');
  });
});
