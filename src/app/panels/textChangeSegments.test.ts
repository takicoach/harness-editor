import { describe, expect, it } from 'vitest';
import { textChangeSegments } from './textChangeSegments';

describe('display-only text alignment', () => {
  it('separates the misread kana from a distant ending change', () => {
    const parts = textChangeSegments('長いアイアソ2本ですね', '長いアイアン2本です');
    expect(parts.filter((p) => p.changed)).toEqual([
      { before: 'ソ', after: 'ン', changed: true }, { before: 'ね', after: '', changed: true },
    ]);
  });
  it.each([
    ['👨‍👩‍👧と猫', '👨‍👩‍👦と犬'], ['か\u3099', 'が'], ['左\n右', '左 右'],
    ['', '追加'], ['削除', ''], ['同じ文章', '同じ文章'], ['ABAB', 'BABA'],
    ['前' + 'あ'.repeat(1000) + '後', '前' + 'い'.repeat(1000) + '後'],
  ])('preserves both original strings exactly', (before, after) => {
    const parts = textChangeSegments(before, after);
    expect(parts.map((p) => p.before).join('')).toBe(before);
    expect(parts.map((p) => p.after).join('')).toBe(after);
    expect(parts.filter((p) => !p.changed).every((p) => p.before === p.after)).toBe(true);
  });
  it('keeps a joined emoji and combining character intact', () => {
    expect(textChangeSegments('👨‍👩‍👧か\u3099', '👨‍👩‍👦が').filter((p) => p.changed)).toEqual([
      { before: '👨‍👩‍👧か\u3099', after: '👨‍👩‍👦が', changed: true },
    ]);
  });
});
