import { describe, expect, it } from 'vitest';
import { buildSlideLayers } from './build';
import { slidesFixture, slidePage } from './fixtures';
import { charWidthEm, fitText, measureLines, pageFit } from './fit';
import { resolveSlideTheme } from './themes';

describe('文字の収まり（受け入れ 5）', () => {
  it('全角は 1 文字、半角は約 0.58 文字の幅で折り返しを数える', () => {
    expect([charWidthEm('あ'), charWidthEm('a'), charWidthEm(' ')]).toEqual([1, .58, .33]);
    expect(measureLines('あ'.repeat(20), 20, 0, 400)).toBe(1);
    expect(measureLines('あ'.repeat(21), 20, 0, 400)).toBe(2);
    expect(measureLines('一\n二\n三', 20, 0, 400)).toBe(3);
  });
  it('収まる最大の大きさまで縮める', () => {
    expect(fitText({ text: 'あ'.repeat(100), width: 432, height: 200, fontSize: 40, minFontSize: 20, lineHeight: 1.5, letterSpacing: 0 }))
      .toEqual({ fontSize: 20, fits: true, height: 166 });
  });
  it('最小で収まらなければ「収まらない」。大きさは最小を下回らない', () => {
    const result = fitText({ text: 'あ'.repeat(200), width: 432, height: 200, fontSize: 40, minFontSize: 20, lineHeight: 1.5, letterSpacing: 0 });
    expect(result).toMatchObject({ fontSize: 20, fits: false });
    expect(result.height).toBeGreaterThan(200);
  });
  it('刻みで最小を飛び越さない（最小ちょうどまで試す）', () => {
    expect(fitText({ text: 'あ'.repeat(200), width: 432, height: 200, fontSize: 41, minFontSize: 20, lineHeight: 1.5, letterSpacing: 0 }).fontSize).toBe(20);
  });
  it('組み立ての結果は最小を下回らず、ページの判定は「収まらない」と提案を出す', () => {
    // 1 項目 約 215 字。最小 40px でも 1 項目 5 行以上 × 5 項目で、枠の高さ 780px を超える。
    const document = slidesFixture(), long = Array.from({ length: 5 }, (_, index) => `${index + 1}つ目の要点は${'とても長い説明'.repeat(30)}`);
    const page = slidePage(document, 'page-long', 'points', { heading: '長い要点', bullets: long });
    const bullets = page.layers.find(layer => page.bindings[layer.id]?.slot === 'bullets')!;
    expect(bullets.content.kind === 'text' && bullets.content.appearance.fontSize).toBe(40);
    const fit = pageFit(page);
    expect(fit.status).toBe('overflow');
    expect(fit.slots.find(slot => slot.slot === 'bullets')).toMatchObject({ status: 'overflow', fontSize: 40, minFontSize: 40, limit: 780 });
    expect(fit.suggestions).toEqual(['split', 'shorten', 'layout']);
  });
  it('収まっていれば ok。分けられないレイアウトには「分ける」を出さない', () => {
    expect(pageFit(slidesFixture().pages[1]!)).toMatchObject({ status: 'ok', suggestions: [] });
    const document = slidesFixture(), compare = slidePage(document, 'cmp', 'compare', { heading: '比較', left: { title: '左', body: 'あ'.repeat(400) }, right: { title: '右', body: '短い' } });
    expect(pageFit(compare)).toMatchObject({ status: 'overflow', suggestions: ['shorten', 'layout'] });
  });
  it('人が最小より小さくした文字は「小さすぎ」のまま（警告を消さない）', () => {
    const document = slidesFixture(), page = structuredClone(document.pages[1]!);
    const bullets = page.layers.find(layer => page.bindings[layer.id]?.slot === 'bullets')!;
    if (bullets.content.kind !== 'text') throw new Error('文字ではありません');
    bullets.content.appearance.fontSize = 20;
    expect(pageFit(page)).toMatchObject({ status: 'small', suggestions: ['shorten', 'layout'] });
    bullets.content.appearance.fontSize = 40; bullets.visual.scale = .5;
    expect(pageFit(page).slots.find(slot => slot.slot === 'bullets')).toMatchObject({ status: 'small', fontSize: 20 });
  });
  it('枠に結び付いていない文字（人が足した文字）は数えない', () => {
    const document = slidesFixture(), page = structuredClone(document.pages[1]!);
    const extra = buildSlideLayers('cover', { title: 'あ'.repeat(300) }, resolveSlideTheme(document.theme), slot => `free-${slot}`).layers.find(layer => layer.id === 'free-title')!;
    page.layers.push(extra);
    expect(pageFit(page).slots.map(slot => slot.layerId)).not.toContain('free-title');
  });
});
