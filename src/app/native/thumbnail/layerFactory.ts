import type { SequenceAsset } from '../../../core/sequence/model';
import type { Rational } from '../../../core/sequence/time';
import { defaultThumbnailVisual, type GradientSide, type ThumbnailCanvas, type ThumbnailLayer, type ThumbnailPage, type ThumbnailShape, type ThumbnailShapeKind } from '../../../core/thumbnail/model';
import { thumbnailTextAppearance } from '../../../core/thumbnail/textStyles';
import { movedVisual } from './canvasMath';

/** レイヤー名。改行や連続した空白は 1 つの空白にし、80 字まで（検証の上限）。 */
export function textLayerName(text: string): string { return text.replace(/\s+/g, ' ').trim().slice(0, 80) || 'レイヤー'; }
const shortName = textLayerName;
export function textLayerOf(id: string, text: string, fontSize: number): ThumbnailLayer {
  return { id, name: shortName(text), hidden: false, locked: false, content: { kind: 'text', text, appearance: thumbnailTextAppearance(fontSize) }, visual: defaultThumbnailVisual() };
}
/** 写真（背景）は全面、画像素材は半分の大きさで置く。 */
export function imageLayerOf(id: string, name: string, assetId: string, role: 'photo' | 'element'): ThumbnailLayer {
  return { id, name: shortName(name), hidden: false, locked: false, content: { kind: 'image', assetId, role }, visual: { ...defaultThumbnailVisual(), scale: role === 'photo' ? 1 : .5 } };
}
export function hasPhoto(page: ThumbnailPage): boolean {
  return page.layers.some(layer => layer.content.kind === 'video-frame' || (layer.content.kind === 'image' && layer.content.role === 'photo'));
}
export function gradientLayerOf(id: string, side: GradientSide, amount: number): ThumbnailLayer {
  return { id, name: '文字側の暗さ', hidden: false, locked: false, content: { kind: 'gradient', side, amount, color: '#000000' }, visual: defaultThumbnailVisual() };
}

/** 複製は 20px ずらし、ロックは外す。名前に「のコピー」を付ける。 */
export function duplicateOf(layer: ThumbnailLayer, id: string, canvas: ThumbnailCanvas): ThumbnailLayer {
  return { ...structuredClone(layer), id, name: `${layer.name.slice(0, 74)} のコピー`, locked: false, visual: movedVisual(layer, 20, 20, canvas) };
}

const SHAPES: Record<ThumbnailShapeKind, { name: string; shape: ThumbnailShape }> = {
  rect: { name: '四角', shape: { kind: 'rect', width: 400, height: 240, color: '#ff3b30', strokeWidth: 10, cornerRadius: 0, fill: null } },
  ellipse: { name: '丸', shape: { kind: 'ellipse', width: 300, height: 300, color: '#ff3b30', strokeWidth: 10, cornerRadius: 0, fill: null } },
  arrow: { name: '矢印', shape: { kind: 'arrow', width: 420, height: 90, color: '#ffe600', strokeWidth: 18, cornerRadius: 0, fill: null } },
  line: { name: '線', shape: { kind: 'line', width: 420, height: 24, color: '#ffffff', strokeWidth: 10, cornerRadius: 0, fill: null } },
};
/** 図形はキャンバス中央に、目立つ色で置く（囲み・指し示しの定番）。 */
export function shapeLayerOf(id: string, kind: ThumbnailShapeKind): ThumbnailLayer {
  const preset = SHAPES[kind];
  return { id, name: preset.name, hidden: false, locked: false, content: { kind: 'shape', shape: { ...preset.shape } }, visual: defaultThumbnailVisual() };
}
/** 動画のコマは背景の写真として全面に置く（描画は原本のそのコマ）。 */
export function frameLayerOf(id: string, asset: SequenceAsset, streamIndex: number, sourceTime: Rational): ThumbnailLayer {
  return { id, name: textLayerName(`${asset.name} のコマ`), hidden: false, locked: false,
    content: { kind: 'video-frame', assetId: asset.id, streamIndex, fingerprint: asset.fingerprint, sourceTime }, visual: defaultThumbnailVisual() };
}
