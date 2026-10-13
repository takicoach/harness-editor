import { describe, expect, it } from 'vitest';
import { textLayer, thumbnailFixture } from './fixtures';
import type { ThumbnailLayer } from './model';
import { textGaugeLabel, textSizeGauge } from './textGauge';

function gaugeOf(layers: Array<{ fontSize: number; scale?: number; hidden?: boolean; x?: number }>) {
  const document = thumbnailFixture();
  document.pages[0]!.layers = layers.map((item, index): ThumbnailLayer => {
    const layer = textLayer(`t${index}`);
    if (layer.content.kind === 'text') layer.content.appearance.fontSize = item.fontSize;
    return { ...layer, hidden: item.hidden ?? false, visual: { ...layer.visual, scale: item.scale ?? 1, position: { x: item.x ?? 0, y: 0 } } };
  });
  return textSizeGauge(document, 'page-a');
}

describe('文字の大きさの目安（受け入れ 12）', () => {
  it('キャンバスの高さの 18% の境界で切り替わる（720px なら 129.6px）', () => {
    expect(gaugeOf([{ fontSize: 129.6 }])).toMatchObject({ kind: 'large', layerId: 't0', pixels: 129.6 });
    expect(gaugeOf([{ fontSize: 129.5 }]).kind).toBe('small');
    expect(gaugeOf([{ fontSize: 259.2, scale: .5 }]).kind).toBe('large');
  });
  it('いちばん大きい文字で測る', () => {
    expect(gaugeOf([{ fontSize: 60 }, { fontSize: 140 }, { fontSize: 90 }])).toMatchObject({ kind: 'large', layerId: 't1' });
  });
  it('非表示の文字とキャンバス外の文字は数えない', () => {
    expect(gaugeOf([{ fontSize: 300, hidden: true }, { fontSize: 60 }])).toMatchObject({ kind: 'small', layerId: 't1' });
    expect(gaugeOf([{ fontSize: 300, x: 1.2 }]).kind).toBe('none');
  });
  it('文字が無ければ「文字なし」', () => {
    const document = thumbnailFixture(); document.pages[0]!.layers = document.pages[0]!.layers.filter(layer => layer.content.kind !== 'text');
    const gauge = textSizeGauge(document, 'page-a');
    expect(gauge).toEqual({ kind: 'none' });
    expect(textGaugeLabel(gauge)).toBe('文字なし');
    expect(textGaugeLabel(gaugeOf([{ fontSize: 200 }]))).toBe('大きい');
    expect(textGaugeLabel(gaugeOf([{ fontSize: 20 }]))).toBe('小さめ');
  });
});
