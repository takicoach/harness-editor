import { describe, expect, it } from 'vitest';
import { fixtureAppearance, shapeLayer } from '../../../core/thumbnail/fixtures';
import { fillColor, hasDoubleOutline, resizedFont, withDoubleOutline, withFill, withFontId, withShadow } from './textTools';

describe('道具の値', () => {
  const appearance = fixtureAppearance();
  it('袋文字と影は付け外しでき、外すと項目ごと消える', () => {
    const on = withDoubleOutline(appearance, true);
    expect(hasDoubleOutline(on)).toBe(true);
    expect('outlines' in withDoubleOutline(on, false)).toBe(false);
    expect(withShadow(appearance, true).shadow).toEqual({ x: 6, y: 8, blur: 12, color: '#000000cc' });
    expect('shadow' in withShadow(withShadow(appearance, true), false)).toBe(false);
  });
  it('大きさは 10px ずつ、8〜400 に収める。書体は同梱の書体のスタックにする', () => {
    expect(resizedFont(appearance, 1).fontSize).toBe(130);
    expect(resizedFont({ ...appearance, fontSize: 12 }, -1).fontSize).toBe(8);
    expect(withFontId(appearance, 'dela-gothic-one').fontFamily).toContain('Dela Gothic One');
    expect(withFontId(appearance, 'no-such-font')).toBe(appearance);
  });
  it('図形の塗りは単色で付け外しする', () => {
    const content = shapeLayer('s').content, shape = content.kind === 'shape' ? content.shape : null;
    if (!shape) throw new Error('図形の見本がありません');
    expect(withFill(shape, '#00ff00').fill).toEqual({ kind: 'solid', color: '#00ff00' });
    expect(fillColor(withFill(shape, '#00ff00'))).toBe('#00ff00');
    expect(withFill(shape, null).fill).toBeNull();
  });
});
