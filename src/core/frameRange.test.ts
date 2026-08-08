import { describe, it, expect } from 'vitest';
import { rangesOverlap } from './frameRange';

describe('rangesOverlap', () => {
  it('重なっていれば true', () => {
    expect(rangesOverlap(0, 10, 5, 15)).toBe(true);
    expect(rangesOverlap(5, 15, 0, 10)).toBe(true);
  });

  it('片方が他方を完全に含む場合も true', () => {
    expect(rangesOverlap(0, 100, 40, 50)).toBe(true);
    expect(rangesOverlap(40, 50, 0, 100)).toBe(true);
  });

  it('端が接するだけ（半開区間）は重ならない', () => {
    expect(rangesOverlap(0, 10, 10, 20)).toBe(false);
    expect(rangesOverlap(10, 20, 0, 10)).toBe(false);
  });

  it('完全に離れていれば false', () => {
    expect(rangesOverlap(0, 5, 100, 200)).toBe(false);
  });

  it('空区間（start >= end）はいずれとも重ならない', () => {
    expect(rangesOverlap(5, 5, 4, 6)).toBe(false);
    expect(rangesOverlap(0, 10, 7, 7)).toBe(false);
  });
});
