import { describe, expect, it } from 'vitest';
import { buildSlideLayers } from './build';
import { fieldIssues, graphemeLength } from './contract';
import { pageFit } from './fit';
import { slidePage, slidesFixture, validFields } from './fixtures';
import { layoutSlots, SLIDE_LAYOUTS, type FieldSpec, type SlideFieldsInput, type TextSlot } from './layouts';
import { SLIDE_LAYOUT_IDS, type SlideLayoutId } from './model';
import { applyThemeToPage } from './pageOps';
import { resolveSlideTheme, SLIDE_THEMES } from './themes';

const textSlots = (layout: SlideLayoutId, fields: SlideFieldsInput = validFields(layout) as unknown as SlideFieldsInput) =>
  layoutSlots(layout, fields).filter((slot): slot is TextSlot => slot.kind === 'text');
const slot = (layout: SlideLayoutId, id: string) => textSlots(layout).find(item => item.id === id)!;
/** 最大文字数・最大件数いっぱいの入力（各文字は全角）。 */
function fullFields(layout: SlideLayoutId): SlideFieldsInput {
  const fields: SlideFieldsInput = {};
  for (const spec of SLIDE_LAYOUTS[layout].fields as readonly FieldSpec[]) {
    if (spec.kind === 'text') fields[spec.name] = 'あ'.repeat(spec.maxChars);
    else if (spec.kind === 'list') fields[spec.name] = Array.from({ length: spec.max }, () => 'あ'.repeat(spec.maxChars));
    else fields[spec.name] = { title: 'あ'.repeat(spec.titleChars), body: 'あ'.repeat(spec.bodyChars) };
  }
  return fields;
}

describe('B0b: 大きさ・上揃え・最大文字数', () => {
  it('大きさの表のとおり（大きさ・最小）', () => {
    expect([slot('cover', 'title').fontSize, slot('cover', 'title').minFontSize, slot('cover', 'subtitle').fontSize, slot('cover', 'subtitle').minFontSize]).toEqual([112, 72, 52, 36]);
    expect([slot('chapter', 'number').fontSize, slot('chapter', 'number').minFontSize, slot('chapter', 'title').fontSize, slot('chapter', 'title').minFontSize]).toEqual([200, 120, 104, 72]);
    expect([slot('points', 'heading').fontSize, slot('points', 'heading').minFontSize]).toEqual([80, 60]);
    expect([slot('points', 'bullets').fontSize, slot('points', 'bullets').minFontSize, slot('points', 'bullets').lineHeight]).toEqual([60, 40, 1.5]);
    expect([slot('image-text', 'bullets').fontSize, slot('image-text', 'bullets').minFontSize]).toEqual([54, 40]);
    expect(layoutSlots('image-text', validFields('image-text') as unknown as SlideFieldsInput).find(item => item.kind === 'image')!.rect).toEqual({ x: 960, y: 280, width: 840, height: 720 });
    expect([slot('compare', 'left-title').fontSize, slot('compare', 'left-title').minFontSize, slot('compare', 'left-body').fontSize, slot('compare', 'left-body').minFontSize]).toEqual([64, 44, 50, 36]);
    const panel = layoutSlots('compare', validFields('compare') as unknown as SlideFieldsInput).find(item => item.id === 'left-panel')!;
    expect([panel.rect.y, panel.rect.y + panel.rect.height]).toEqual([280, 1000]);
    expect(layoutSlots('steps', validFields('steps') as unknown as SlideFieldsInput).find(item => item.id === 'circle-1')!.rect).toMatchObject({ width: 140, height: 140 });
    expect([slot('steps', 'number-1').fontSize, slot('steps', 'step-1').fontSize, slot('steps', 'step-1').minFontSize]).toEqual([72, 52, 36]);
  });
  it('箇条書き・本文・手順の説明は上揃え。要点の枠は見出しの線の下端から 40px 以内で始まる', () => {
    for (const [layout, id] of [['points', 'bullets'], ['image-text', 'bullets'], ['compare', 'left-body'], ['compare', 'right-body'], ['steps', 'step-1']] as const) expect(slot(layout, id).anchor).toBe('top');
    for (const [layout, id] of [['cover', 'title'], ['chapter', 'title'], ['points', 'heading']] as const) expect(slot(layout, id).anchor).toBe('center');
    for (const layout of ['points', 'image-text'] as const) {
      const rule = layoutSlots(layout, validFields(layout) as unknown as SlideFieldsInput).find(item => item.id === 'rule')!, ruleBottom = rule.rect.y + rule.rect.height;
      expect(slot(layout, 'bullets').rect.y - ruleBottom).toBeLessThanOrEqual(40); expect(slot(layout, 'bullets').rect.y).toBeGreaterThanOrEqual(ruleBottom);
      const heading = slot(layout, 'heading'); expect(heading.rect.y + heading.rect.height).toBeLessThanOrEqual(rule.rect.y);
    }
  });
  it('上揃えの層は位置が枠の上端、文字枠の基準は top。中央の層は従来どおり枠の中心', () => {
    const built = buildSlideLayers('points', validFields('points') as unknown as SlideFieldsInput, resolveSlideTheme({ id: 'forest-gold' }), id => `p-${id}`);
    const bullets = built.layers.find(layer => layer.id === 'p-bullets')!, heading = built.layers.find(layer => layer.id === 'p-heading')!;
    expect(bullets.visual.position.y).toBeCloseTo(264 / 540 - 1, 3);
    expect(bullets.content.kind === 'text' && bullets.content.appearance.box?.anchor).toBe('top');
    expect(heading.content.kind === 'text' && heading.content.appearance.box?.anchor).toBe('center');
    expect(heading.visual.position.y).toBeCloseTo(135 / 540 - 1, 3);
  });
  it('最大文字数いっぱいの入力でも、どの枠も最小文字サイズで収まる', () => {
    const document = slidesFixture();
    for (const layout of SLIDE_LAYOUT_IDS) {
      const fit = pageFit(slidePage(document, `full-${layout}`, layout, fullFields(layout)));
      expect(fit.slots.filter(item => item.status !== 'ok'), layout).toEqual([]);
    }
  });
  it('入力の検証は最大文字数のままで受かる（見直し後の上限で fullFields が通る）', () => {
    for (const layout of SLIDE_LAYOUT_IDS) expect(fieldIssues(layout, fullFields(layout), 'fields'), layout).toEqual([]);
  });
});

describe('B0b: 強調語', () => {
  const withEmphasis = (fields: SlideFieldsInput, layout: SlideLayoutId = 'points') => slidePage(slidesFixture(), 'em', layout, fields);
  it('強調色はテーマの強調色。テーマを変えると追随する', () => {
    const page = withEmphasis({ heading: '握り方', bullets: ['左手から**握る**', '親指は右', '力は 3 割'] });
    const bullets = page.layers.find(layer => layer.id === 'em-bullets')!;
    if (bullets.content.kind !== 'text') throw new Error('文字ではありません');
    expect(bullets.content.appearance.emphasis).toEqual({ color: SLIDE_THEMES['forest-gold'].colors.accent });
    applyThemeToPage(page, resolveSlideTheme({ id: 'white-navy' }));
    expect(bullets.content.appearance.emphasis).toEqual({ color: SLIDE_THEMES['white-navy'].colors.accent });
  });
  it('文字数の検査・収まりの判定は ** を数えない', () => {
    expect(fieldIssues('points', { heading: '見出し', bullets: ['あ'.repeat(28) + '**いう**', 'あ', 'あ'] }, 'fields')).toEqual([]);
    expect(fieldIssues('points', { heading: '見出し', bullets: ['あ'.repeat(29) + '**いう**', 'あ', 'あ'] }, 'fields')).toMatchObject([{ code: 'TOO_LONG' }]);
    expect(graphemeLength('**ab**')).toBe(6);
    const plain = pageFit(withEmphasis({ heading: '見出し', bullets: ['あ'.repeat(24), 'あ', 'あ'] })).slots.find(item => item.slot === 'bullets')!;
    const marked = pageFit(withEmphasis({ heading: '見出し', bullets: ['あ'.repeat(20) + '**' + 'あ'.repeat(4) + '**', 'あ', 'あ'] })).slots.find(item => item.slot === 'bullets')!;
    expect(marked.height).toBe(plain.height);
  });
  it('1 ページの強調が 3 つ以上なら直す対象。2 つまでは通る。対でない ** も直す対象', () => {
    const fields = (bullets: string[]) => ({ heading: '見出し', bullets });
    expect(fieldIssues('points', fields(['**一**', '**二**', '三']), 'fields', 'k')).toEqual([]);
    expect(fieldIssues('points', fields(['**一**', '**二**', '**三**']), 'fields', 'k')).toMatchObject([{ code: 'EMPHASIS', key: 'k' }]);
    expect(fieldIssues('points', { heading: '**見出し**', bullets: ['**一**', '**二**', '三'] }, 'fields')).toMatchObject([{ code: 'EMPHASIS' }]);
    expect(fieldIssues('points', fields(['**一', '二', '三']), 'fields')).toMatchObject([{ code: 'EMPHASIS' }]);
  });
});
