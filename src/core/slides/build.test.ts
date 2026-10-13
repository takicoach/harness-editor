import { describe, expect, it } from 'vitest';
import { buildSlideLayers, convertFields, extractFields, placeholderFields, slotImages, splitFields } from './build';
import { slidesFixture, validFields } from './fixtures';
import { bulletItems, bulletText, layoutSlots, SLIDE_LAYOUTS, slideLayoutCatalog } from './layouts';
import { SLIDE_LAYOUT_IDS } from './model';
import { resolveSlideTheme, SLIDE_THEMES } from './themes';

const theme = resolveSlideTheme({ id: 'forest-gold' }), ids = (prefix: string) => (slot: string) => `${prefix}-${slot}`;

describe('レイアウト 6 種', () => {
  it('入力の型・最大文字数・画像枠を持ち、一覧で AI に渡せる', () => {
    expect(SLIDE_LAYOUT_IDS.map(id => SLIDE_LAYOUTS[id].name)).toEqual(['表紙', '章見出し', '要点', '画像＋説明', '左右比較', '手順']);
    expect(SLIDE_LAYOUTS.points.fields).toContainEqual({ kind: 'list', name: 'bullets', label: '箇条書き', min: 3, max: 5, maxChars: 30 });
    expect(SLIDE_LAYOUTS['image-text'].imageSlots).toEqual(['image']);
    expect(slideLayoutCatalog().map(entry => entry.id)).toEqual([...SLIDE_LAYOUT_IDS]);
    expect(JSON.parse(JSON.stringify(slideLayoutCatalog()))).toEqual(slideLayoutCatalog());
  });
  it('どのレイアウトも、背景（ロック）・文字の枠をキャンバスの中に置く。文字枠は最小文字サイズを下回らない', () => {
    for (const layout of SLIDE_LAYOUT_IDS) {
      const slots = layoutSlots(layout, validFields(layout));
      expect(slots[0]).toMatchObject({ kind: 'shape', id: 'background', rect: { x: 0, y: 0, width: 1920, height: 1080 } });
      for (const slot of slots) {
        expect(slot.rect.x).toBeGreaterThanOrEqual(0); expect(slot.rect.x + slot.rect.width).toBeLessThanOrEqual(1920);
        expect(slot.rect.y).toBeGreaterThanOrEqual(0); expect(slot.rect.y + slot.rect.height).toBeLessThanOrEqual(1080);
        if (slot.kind === 'text') expect(slot.fontSize).toBeGreaterThanOrEqual(slot.minFontSize);
      }
    }
  });
  it('箇条書きは 1 つの文字レイヤー（行頭に ・）。行頭の記号を外して取り出せる', () => {
    expect(bulletText(['一', '二'])).toBe('・一\n・二');
    expect(bulletItems('・一\n• 二\n- 三\n\n四')).toEqual(['一', '二', '三', '四']);
  });
});

describe('組み立て', () => {
  it('文字はテーマの色と書体、枠の中心に置き、結び付き（枠・色・書体）を持つ', () => {
    const built = buildSlideLayers('points', validFields('points'), theme, ids('p'));
    expect(built.layers.map(layer => layer.id)).toEqual(['p-background', 'p-heading', 'p-rule', 'p-bullets']);
    expect(built.layers[0]).toMatchObject({ locked: true, content: { kind: 'shape', shape: { fill: { kind: 'solid', color: SLIDE_THEMES['forest-gold'].colors.background } } } });
    const heading = built.layers[1]!;
    if (heading.content.kind !== 'text') throw new Error('見出しが文字ではありません');
    expect(heading.content.appearance).toMatchObject({ color: '#f5f1e3', fontWeight: 900, fontSize: 80, align: 'left', box: { width: .875, anchor: 'center' } });
    expect(heading.content.appearance.fontFamily).toContain('Noto Sans JP Black');
    expect(heading.visual).toEqual({ position: { x: 0, y: -.75 }, scale: 1, rotation: 0, opacity: 1 });
    expect(built.bindings['p-heading']).toEqual({ slot: 'heading', color: 'text', font: 'heading' });
    expect(built.bindings['p-background']).toEqual({ slot: 'background', stroke: 'background', fill: 'background' });
  });
  it('省略できる項目が無ければ枠ごと作らない', () => {
    const built = buildSlideLayers('cover', { title: '題だけ' }, theme, ids('c'));
    expect(built.layers.map(layer => layer.id)).toEqual(['c-background', 'c-accent', 'c-title']);
  });
  it('画像枠は、画像があれば画像（枠に収まる大きさ）、無ければ面の色の四角', () => {
    const empty = buildSlideLayers('image-text', validFields('image-text'), theme, ids('i'));
    expect(empty.layers.at(-1)).toMatchObject({ id: 'i-image', content: { kind: 'shape' } });
    expect(empty.bindings['i-image']).toEqual({ slot: 'image', stroke: 'surface', fill: 'surface' });
    const filled = buildSlideLayers('image-text', validFields('image-text'), theme, ids('i'), { image: 'img-1' });
    expect(filled.layers.at(-1)).toMatchObject({ id: 'i-image', content: { kind: 'image', assetId: 'img-1', role: 'element' }, visual: { scale: .4375 } });
    expect(slotImages({ layers: filled.layers, bindings: filled.bindings })).toEqual({ image: 'img-1' });
  });
  it('手順は件数に合わせて列を割り、番号は自動で入る', () => {
    const built = buildSlideLayers('steps', { heading: '練習', steps: ['構える', '振る', '止める', '確かめる'] }, theme, ids('s'));
    const numbers = built.layers.filter(layer => /^s-number-\d$/.test(layer.id)).map(layer => layer.content.kind === 'text' ? layer.content.text : '');
    expect(numbers).toEqual(['1', '2', '3', '4']);
    expect(built.layers.filter(layer => /^s-circle-\d$/.test(layer.id))).toHaveLength(4);
  });
  it('文字から入力を取り出し、同じレイアウトで組み直すと同じになる', () => {
    for (const layout of SLIDE_LAYOUT_IDS) {
      const built = buildSlideLayers(layout, validFields(layout), theme, ids('x'));
      expect(buildSlideLayers(layout, extractFields(built), theme, ids('x'))).toEqual(built);
    }
  });
  it('レイアウトを変えても文字は残る（要点 → 左右比較 → 要点）', () => {
    const compare = convertFields({ heading: '握り方', bullets: ['左手', '右手', '親指', '力'] }, 'compare');
    expect(compare).toEqual({ heading: '握り方', left: { title: '左手', body: '右手' }, right: { title: '親指', body: '力' } });
    expect(convertFields(compare, 'points')).toEqual({ heading: '握り方', bullets: ['左手：右手', '親指：力'] });
    expect(convertFields({ title: '題', subtitle: '副題' }, 'chapter')).toEqual({ number: '', title: '題' });
  });
  it('分けられるのは箇条書き・手順が 2 つ以上のページだけ', () => {
    expect(splitFields('points', { heading: '要点', bullets: ['a', 'b', 'c', 'd', 'e'] }))
      .toEqual([{ heading: '要点', bullets: ['a', 'b', 'c'] }, { heading: '要点（続き）', bullets: ['d', 'e'] }]);
    expect(splitFields('compare', validFields('compare'))).toBeNull();
    expect(splitFields('steps', { heading: '手順', steps: ['一'] })).toBeNull();
    expect(Object.keys(placeholderFields('compare')).sort()).toEqual(['heading', 'left', 'right']);
  });
  it('見本の文書が組める', () => {
    const document = slidesFixture();
    expect(document.pages.map(page => page.layout)).toEqual(['cover', 'points']);
    expect(document.pages[1]!.layers.length).toBeGreaterThan(2);
  });
});
