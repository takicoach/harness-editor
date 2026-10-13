import { DEFAULT_TEXT_APPEARANCE } from '../../../core/sequence/model';
import type { ResolvedSlideTheme } from '../../../core/slides/themes';
import { defaultThumbnailVisual, type ThumbnailLayer, type ThumbnailShapeKind } from '../../../core/thumbnail/model';
import { shapeLayerOf } from '../thumbnail/layerFactory';

export type SlidesTextKind = 'heading' | 'body' | 'bullets';
const PRESETS: Record<SlidesTextKind, { name: string; text: string; size: number; role: 'heading' | 'body'; lineHeight: number }> = {
  heading: { name: '見出し', text: '見出し', size: 72, role: 'heading', lineHeight: 1.25 },
  body: { name: '本文', text: '本文', size: 44, role: 'body', lineHeight: 1.6 },
  bullets: { name: '箇条書き', text: '・ポイント 1\n・ポイント 2\n・ポイント 3', size: 44, role: 'body', lineHeight: 1.6 },
};
/** 手で足す文字（テーマの色と書体・キャンバス中央・幅 60%）。枠には結び付けない（レイアウトを変えても前面に残る）。 */
export function slidesTextLayer(id: string, kind: SlidesTextKind, theme: ResolvedSlideTheme): ThumbnailLayer {
  const preset = PRESETS[kind];
  return { id, name: preset.name, hidden: false, locked: false, visual: defaultThumbnailVisual(), content: { kind: 'text', text: preset.text, appearance: {
    ...DEFAULT_TEXT_APPEARANCE, fontFamily: theme.fontStacks[preset.role], fontSize: preset.size, fontWeight: theme.weights[preset.role], color: theme.colors.text,
    strokeColor: '#000000', strokeWidth: 0, background: 'transparent', align: 'left', lineHeight: preset.lineHeight, letterSpacing: 0, box: { width: .6, anchor: 'center' } } } };
}
/** 図形（四角・丸・矢印・線）はテーマの強調色で足す。 */
export function slidesShapeLayer(id: string, kind: ThumbnailShapeKind, theme: ResolvedSlideTheme): ThumbnailLayer {
  const layer = shapeLayerOf(id, kind);
  return layer.content.kind === 'shape' ? { ...layer, content: { ...layer.content, shape: { ...layer.content.shape, color: theme.colors.accent } } } : layer;
}
