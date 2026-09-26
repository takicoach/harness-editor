import { describe, expect, it } from 'vitest';
import { formatTimecode, parseTimecode } from './timecode';

describe('precise playback timecode', () => {
  it('shows the two-frame shortfall hidden by a rounded 1:00 duration', () => {
    expect(formatTimecode(1798, 30)).toBe('00:00:59:28');
    expect(formatTimecode(1800, 30)).toBe('00:01:00:00');
    expect(formatTimecode(899, 30)).toBe('00:00:29:29');
    expect(formatTimecode(1801, 30)).toBe('00:01:00:01');
  });
  it.each(['30', '0:30', '00:00:30', '00:00:30:00', '900f'])('seeks the exact 30 second boundary from %s', (input) => {
    expect(parseTimecode(input, 30)).toBe(900);
  });
  it('distinguishes actual seconds from NDF timecode for fractional fps', () => {
    expect(parseTimecode('30', 30000 / 1001)).toBe(899);
    expect(parseTimecode('00:00:30:00', 30000 / 1001)).toBe(900);
    expect(formatTimecode(900, 30000 / 1001)).toBe('00:00:30:00');
  });
  it.each(['', ' ', '-1', 'NaN', 'Infinity', '1e3', '00:60:00:00', '00:00:60:00', '00:00:00:30', '00:00:30;00', '1:60', '1::2', '9007199254740992f'])('rejects invalid or ambiguous input %s', (input) => {
    expect(parseTimecode(input, 30)).toBeNull();
  });
  it('supports fractional seconds, hour boundaries and high frame rates', () => {
    expect(parseTimecode('1:02.5', 30)).toBe(1875);
    expect(formatTimecode(108001, 30)).toBe('01:00:00:01');
    expect(formatTimecode(119, 120)).toBe('00:00:00:119');
    expect(parseTimecode('00:00:00:119', 120)).toBe(119);
    expect(parseTimecode('1', 0)).toBeNull();
  });
});
