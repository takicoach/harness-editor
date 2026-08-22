import { describe, it, expect } from 'vitest';
import { visibleTelopBoxes } from './visibleTelopBoxes';
import { telopBoxRect } from './overlayGeometry';

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

  it('bottomOffset を渡すと当たり判定の枠アンカーが実値へ追従する（golf-short-gold 540）', () => {
    const std = visibleTelopBoxes(telops, 60, content, 1080, 1920);
    const gold = visibleTelopBoxes(telops, 60, content, 1080, 1920, 540);
    expect(gold.map((b) => b.id)).toEqual([1, 2]);
    const goldRect = gold[0]?.rect;
    const stdRect = std[0]?.rect;
    if (!goldRect || !stdRect) throw new Error('box が返らない');
    // 枠の下端が (1 - 540/1920) 位置へ上がる（標準 200/1920 より上）。
    expect(goldRect.y + goldRect.h).toBeCloseTo(480 * (1 - 540 / 1920), 6);
    expect(goldRect.y).toBeLessThan(stdRect.y);
  });

  it('拡縮したテロップの当たり判定も枠と同じ式（telopBoxRect）で出る — 姉妹実装の非対称を作らない', () => {
    // scale=2 の可視テロップ 1 件だけを持つ入力。
    const scaled = [
      { id: 9, originalStart: 0, originalEnd: 100, text: 'z', position: { x: 0, y: 0 }, scale: 2 },
    ] as unknown as typeof telops;
    const out = visibleTelopBoxes(scaled, 10, content, 1080, 1920, 540);
    const rect = out[0]?.rect;
    if (!rect) throw new Error('box が返らない');
    // 実描画: transformOrigin Y は標準固定 (1 - 200/1920)、テキスト下端 (1 - 540/1920) が scale 倍。
    const originFrac = 1 - 200 / 1920;
    const anchorFrac = 1 - 540 / 1920;
    expect(rect.y + rect.h).toBeCloseTo(480 * (originFrac + (anchorFrac - originFrac) * 2), 6);
    expect(rect).toEqual(telopBoxRect(content, { x: 0, y: 0 }, 2, 1080, 1920, 540));
  });

  it('bottomOffset 未指定なら従来の標準アンカーのまま', () => {
    expect(visibleTelopBoxes(telops, 60, content, 1080, 1920, null)).toEqual(
      visibleTelopBoxes(telops, 60, content, 1080, 1920),
    );
  });
});
