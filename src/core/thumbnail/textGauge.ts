import { findPage, type ThumbnailDocument } from './model';

/** youtube-thumbnail スキルの検品基準（文字の高さがキャンバスの高さの 18% 以上）。千分率で持ち、小数の誤差で境界がぶれないようにする。 */
export const TEXT_GAUGE_PERMILLE = 180;
export type TextGauge = { kind: 'none' } | { kind: 'large' | 'small'; layerId: string; pixels: number; ratio: number };

/** 読みやすさ（コントラストなど）は保証しない目安。書き出しは止めない。 */
export function textSizeGauge(document: ThumbnailDocument, pageId: string): TextGauge {
  const page = findPage(document, pageId), height = document.canvas.height;
  let best: { layerId: string; pixels: number } | null = null;
  for (const layer of page.layers) {
    if (layer.hidden || layer.content.kind !== 'text') continue;
    const { x, y } = layer.visual.position;
    if (Math.abs(x) > 1 || Math.abs(y) > 1) continue;
    const pixels = layer.content.appearance.fontSize * layer.visual.scale;
    if (!best || pixels > best.pixels) best = { layerId: layer.id, pixels };
  }
  if (!best) return { kind: 'none' };
  const large = Math.round(best.pixels * 1000) >= TEXT_GAUGE_PERMILLE * height;
  return { kind: large ? 'large' : 'small', layerId: best.layerId, pixels: best.pixels, ratio: best.pixels / height };
}
export function textGaugeLabel(gauge: TextGauge): '大きい' | '小さめ' | '文字なし' {
  return gauge.kind === 'none' ? '文字なし' : gauge.kind === 'large' ? '大きい' : '小さめ';
}
