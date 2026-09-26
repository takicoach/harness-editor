import { describe, expect, it } from 'vitest';
import { nearestKeptOriginalFrame } from './cutViewFocus';

describe('nearestKeptOriginalFrame', () => {
  it('keeps a visible source frame unchanged', () => {
    expect(nearestKeptOriginalFrame(42, 100, [{ start: 50, end: 70 }])).toBe(42);
  });

  it('uses the nearest visible edge inside a cut', () => {
    expect(nearestKeptOriginalFrame(52, 100, [{ start: 50, end: 70 }])).toBe(49);
    expect(nearestKeptOriginalFrame(68, 100, [{ start: 50, end: 70 }])).toBe(70);
  });

  it('handles cuts that cover an outer edge', () => {
    expect(nearestKeptOriginalFrame(2, 100, [{ start: 0, end: 10 }])).toBe(10);
    expect(nearestKeptOriginalFrame(98, 100, [{ start: 90, end: 100 }])).toBe(89);
  });
});
