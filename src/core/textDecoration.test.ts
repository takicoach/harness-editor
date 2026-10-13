import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_APPEARANCE } from './sequence/model';
import { expandBounds, textBoxBackground, textBoxPadding, textInkInsets, textOutlineLayers, textShadowFilter, textSkewTransform } from './textDecoration';

describe('文字の任意項目（描画値と計測値）', () => {
  it('任意項目が無ければ従来の値で、はみ出しは 0', () => {
    const appearance = { ...DEFAULT_TEXT_APPEARANCE };
    expect(textBoxPadding(appearance)).toEqual({ x: 16, y: 8 });
    expect(textBoxBackground(appearance)).toBe('transparent');
    expect(textOutlineLayers(appearance)).toEqual([]);
    expect(textShadowFilter(appearance)).toBeUndefined();
    expect(textSkewTransform(appearance)).toBeUndefined();
    expect(textInkInsets(appearance, { width: 300, height: 100 })).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
  it('2 重の縁取りは外側から、見える太さの 2 倍の線で重ねる', () => {
    expect(textOutlineLayers({ ...DEFAULT_TEXT_APPEARANCE, outlines: [{ width: 6, color: '#000000' }, { width: 10, color: '#ffffff' }] }))
      .toEqual([{ stroke: 32, color: '#ffffff' }, { stroke: 12, color: '#000000' }]);
  });
  it('帯は余白と色を差し替え、影と傾きは CSS の値になる', () => {
    const appearance = { ...DEFAULT_TEXT_APPEARANCE, band: { color: '#e60012', padX: 30, padY: 10, radius: 12 }, shadow: { x: 4, y: 6, blur: 8, color: '#00000099' }, skewDeg: 8 };
    expect(textBoxPadding(appearance)).toEqual({ x: 30, y: 10 });
    expect(textBoxBackground(appearance)).toBe('#e60012');
    expect(textShadowFilter(appearance)).toBe('drop-shadow(4px 6px 8px #00000099)');
    expect(textSkewTransform(appearance)).toBe('skewX(-8deg)');
  });
  it('縁取り・影・傾きのはみ出しを計測に足す', () => {
    const appearance = { ...DEFAULT_TEXT_APPEARANCE, outlines: [{ width: 20, color: '#000000' }], shadow: { x: 10, y: 0, blur: 6, color: '#000000' }, skewDeg: 10 };
    const insets = textInkInsets(appearance, { width: 300, height: 100 }), skew = Math.tan(10 * Math.PI / 180) * 100 / 2;
    // 縁取り 20 と影（20+6±10）から余白（左右 16・上下 8）を引く。傾きは高さ×tan/2 を左右へ。
    expect(insets.top).toBe(18);
    expect(insets.bottom).toBe(18);
    expect(insets.left).toBeCloseTo(4 + skew, 6);
    expect(insets.right).toBeCloseTo(20 + skew, 6);
    expect(expandBounds({ x: 10, y: 20, width: 100, height: 50 }, { top: 1, right: 2, bottom: 3, left: 4 })).toEqual({ x: 6, y: 19, width: 106, height: 54 });
  });
});
