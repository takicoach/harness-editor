import { describe, expect, it } from 'vitest';
import { fontById } from '../fonts';
import { emptySlideDocument, findSlidePage, SLIDE_COLOR_ROLES, SLIDE_THEME_IDS, SLIDES_CANVAS } from './model';
import { resolveSlideTheme, SLIDE_THEMES, slideFontWeight } from './themes';

describe('SlideDocument', () => {
  it('空の文書は 1920×1080・ページなし・生成なし', () => {
    const document = emptySlideDocument('slides-a');
    expect(document).toEqual({ schemaVersion: 1, id: 'slides-a', revision: 0, canvas: { width: 1920, height: 1080 }, theme: { id: 'forest-gold' },
      script: { paragraphs: [] }, pages: [], assets: [], generation: null });
    expect(document.canvas).not.toBe(SLIDES_CANVAS);
    expect(() => findSlidePage(document, 'nope')).toThrow('対象のページが見つかりません');
  });
});

describe('テーマ 2 種', () => {
  it('どちらも 5 色（地・面・文字・強調・補助）と同梱の書体を持つ', () => {
    for (const id of SLIDE_THEME_IDS) {
      const spec = SLIDE_THEMES[id];
      expect(Object.keys(spec.colors).sort()).toEqual([...SLIDE_COLOR_ROLES].sort());
      for (const color of Object.values(spec.colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/);
      expect(fontById(spec.fonts.heading)?.group).toBe('bundled');
      expect(fontById(spec.fonts.body)?.group).toBe('bundled');
    }
    expect([SLIDE_THEMES['forest-gold'].name, SLIDE_THEMES['forest-gold'].tone, SLIDE_THEMES['white-navy'].name, SLIDE_THEMES['white-navy'].tone])
      .toEqual(['深緑×金', 'dark', '白×紺', 'light']);
  });
  it('上書きした色と書体が効く。同梱でない書体は断る', () => {
    const resolved = resolveSlideTheme({ id: 'white-navy', overrides: { colors: { accent: '#ff0000' }, fonts: { body: 'zen-kaku-gothic-new' } } });
    expect(resolved.colors).toMatchObject({ accent: '#ff0000', text: SLIDE_THEMES['white-navy'].colors.text });
    expect(resolved.fontIds).toEqual({ heading: 'noto-sans-jp-black', body: 'zen-kaku-gothic-new' });
    expect(resolved.fontStacks.body).toContain('Zen Kaku Gothic New');
    expect(resolved.weights).toEqual({ heading: 900, body: 400 });
    expect(slideFontWeight('heading', 'dela-gothic-one')).toBe(700);
    expect(() => resolveSlideTheme({ id: 'white-navy', overrides: { fonts: { heading: 'system-gothic' } } })).toThrow('スライドで使える書体は同梱の書体だけです');
  });
});
