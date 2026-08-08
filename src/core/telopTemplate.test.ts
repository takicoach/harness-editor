import { describe, it, expect } from 'vitest';
import { resolveTemplate } from './telopTemplate';

describe('resolveTemplate', () => {
  it('1..count はそのまま', () => {
    expect(resolveTemplate(1, 30)).toBe(1);
    expect(resolveTemplate(30, 30)).toBe(30);
    expect(resolveTemplate(15, 30)).toBe(15);
  });
  it('範囲外・未定義・非整数は 1', () => {
    expect(resolveTemplate(0, 30)).toBe(1);
    expect(resolveTemplate(31, 30)).toBe(1);
    expect(resolveTemplate(undefined, 30)).toBe(1);
    expect(resolveTemplate(2.5, 30)).toBe(1);
    expect(resolveTemplate(Number.NaN, 30)).toBe(1);
  });
});
