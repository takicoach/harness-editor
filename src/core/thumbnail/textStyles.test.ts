import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fontById } from '../fonts';
import { textExtrasIssue } from '../sequence/renderExtras';
import { textLayer, thumbnailFixture } from './fixtures';
import { THUMBNAIL_FONT_ID, THUMBNAIL_TEXT_STYLES, thumbnailTextAppearance } from './textStyles';
import { validateThumbnailDocument } from './validate';

describe('Noto Sans JP 900 と定番スタイル', () => {
  it('900 は別の書体名で同梱し、@font-face は weight 900', () => {
    expect(fontById(THUMBNAIL_FONT_ID)).toMatchObject({ family: 'Noto Sans JP Black', file: 'noto-sans-jp-black.woff2', group: 'bundled' });
    expect(readFileSync(resolve('src/styles/fonts.css'), 'utf8')).toContain("font-family: 'Noto Sans JP Black'; src: url('/fonts/noto-sans-jp-black.woff2') format('woff2'); font-weight: 900;");
  });
  it('定番スタイルは 6 種で、どれも 900・同梱書体・任意項目の範囲内', () => {
    expect(THUMBNAIL_TEXT_STYLES.map(style => style.name)).toEqual(['袋文字 2 重（黄×黒×白）', '白×赤縁', '帯つき', '影だけ', '黒×白縁', 'ネオン']);
    for (const style of THUMBNAIL_TEXT_STYLES) {
      const appearance = style.apply(thumbnailTextAppearance());
      expect(appearance.fontWeight).toBe(900);
      expect(textExtrasIssue(appearance)).toBeNull();
      const document = thumbnailFixture(), layer = textLayer('styled');
      if (layer.content.kind === 'text') layer.content.appearance = appearance;
      document.pages[0]!.layers.push(layer);
      expect(() => validateThumbnailDocument(document)).not.toThrow();
    }
  });
  it('スタイルを替えると前のスタイルの縁・帯・影は残らない', () => {
    const band = THUMBNAIL_TEXT_STYLES.find(style => style.id === 'band')!, shadow = THUMBNAIL_TEXT_STYLES.find(style => style.id === 'shadow')!;
    const appearance = shadow.apply(band.apply(thumbnailTextAppearance()));
    expect(appearance.band).toBeUndefined();
    expect(appearance.outlines).toBeUndefined();
    expect(appearance.shadow).toBeDefined();
  });
});
