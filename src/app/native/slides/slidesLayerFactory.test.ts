import { describe, expect, it } from 'vitest';
import { resolveSlideTheme, SLIDE_THEMES } from '../../../core/slides/themes';
import { slidesShapeLayer, slidesTextLayer } from './slidesLayerFactory';

const theme = resolveSlideTheme({ id: 'white-navy' });
describe('スライドで足す文字と図形', () => {
  it('見出し・本文・箇条書きはテーマの色と書体で、キャンバスの中央に置く', () => {
    const heading = slidesTextLayer('l-1', 'heading', theme), bullets = slidesTextLayer('l-2', 'bullets', theme);
    expect(heading).toMatchObject({ id: 'l-1', name: '見出し', visual: { position: { x: 0, y: 0 }, scale: 1 }, content: { kind: 'text', text: '見出し',
      appearance: { color: SLIDE_THEMES['white-navy'].colors.text, fontSize: 72, fontWeight: 900, align: 'left', box: { width: .6, anchor: 'center' } } } });
    expect(bullets.content.kind === 'text' && bullets.content.text).toBe('・ポイント 1\n・ポイント 2\n・ポイント 3');
    expect(bullets.content.kind === 'text' && bullets.content.appearance.fontFamily).toContain('BIZ UDPGothic');
  });
  it('図形はテーマの強調色', () => {
    expect(slidesShapeLayer('s-1', 'arrow', theme)).toMatchObject({ content: { kind: 'shape', shape: { kind: 'arrow', color: SLIDE_THEMES['white-navy'].colors.accent } } });
  });
});
