import { describe, it, expect } from 'vitest';
import { visibleTelopBoxes } from './visibleTelopBoxes';

const content = { x: 0, y: 0, w: 270, h: 480 };
const telops = [
  { id: 1, originalStart: 0, originalEnd: 100, text: 'a' },
  { id: 2, originalStart: 50, originalEnd: 200, text: 'b', position: { x: 0, y: -1 }, scale: 1 },
  { id: 3, originalStart: 300, originalEnd: 400, text: 'c' },
] as any;

describe('visibleTelopBoxes', () => {
  it('現在フレームで可視のテロップだけ box 付きで入力順に返す', () => {
    const out = visibleTelopBoxes(telops, 60, content, 1080, 1920);
    expect(out.map((b) => b.id)).toEqual([1, 2]);
    // 各 box は content 内の有限な矩形
    for (const b of out) {
      expect(Number.isFinite(b.rect.x)).toBe(true);
      expect(b.rect.w).toBeGreaterThan(0);
      expect(b.rect.h).toBeGreaterThan(0);
    }
  });
  it('該当フレーム無しは空配列', () => {
    expect(visibleTelopBoxes(telops, 250, content, 1080, 1920)).toEqual([]);
  });
});
