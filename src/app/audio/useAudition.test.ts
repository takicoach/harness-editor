import { describe, it, expect } from 'vitest';
import { nextPlaying } from './useAudition';

describe('nextPlaying', () => {
  it('別の素材を押すとそれを再生する', () => {
    expect(nextPlaying(null, 'a')).toBe('a');
    expect(nextPlaying('a', 'b')).toBe('b');
  });
  it('再生中の素材をもう一度押すと停止する', () => {
    expect(nextPlaying('a', 'a')).toBeNull();
  });
});
