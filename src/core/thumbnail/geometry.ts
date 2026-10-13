import type { MediaStream } from '../sequence/model';
import { timeNumber } from '../sequence/time';
import type { ThumbnailCanvas, ThumbnailDocument, ThumbnailLayer, ThumbnailShape } from './model';

export interface LayerBox { cx: number; cy: number; width: number; height: number; rotation: number }

export function layerCenter(position: { x: number; y: number }, canvas: ThumbnailCanvas): { x: number; y: number } {
  return { x: canvas.width / 2 * (1 + position.x), y: canvas.height / 2 * (1 + position.y) };
}
/** 図形の箱をキャンバス中央に置いた正規化 2 点。矢印と線は箱の中央を左から右へ。 */
export function shapeBoxData(shape: ThumbnailShape, canvas: ThumbnailCanvas): { x1: number; y1: number; x2: number; y2: number } {
  const halfWidth = shape.width / canvas.width / 2, halfHeight = shape.height / canvas.height / 2;
  if (shape.kind === 'arrow' || shape.kind === 'line') return { x1: .5 - halfWidth, y1: .5, x2: .5 + halfWidth, y2: .5 };
  return { x1: .5 - halfWidth, y1: .5 - halfHeight, x2: .5 + halfWidth, y2: .5 + halfHeight };
}
/** キャンバスに収めた（contain）映像の表示寸法。回転メタデータと画素の縦横比を含める。 */
export function videoFrameSize(stream: MediaStream, canvas: ThumbnailCanvas): { width: number; height: number } {
  const ratio = stream.sampleAspectRatio ? timeNumber(stream.sampleAspectRatio) : 1, width = (stream.width ?? 1) * ratio, height = stream.height ?? 1;
  const turned = Math.abs(stream.rotation ?? 0) % 180 === 90, shownWidth = turned ? height : width, shownHeight = turned ? width : height;
  const fit = Math.min(canvas.width / shownWidth, canvas.height / shownHeight);
  return { width: shownWidth * fit, height: shownHeight * fit };
}
/** 文書だけで決まる外接箱（図形・帯・コマ）。文字と画像は描画の計測（RenderedSceneGeometry）を使う。 */
export function pureLayerBox(document: ThumbnailDocument, layer: ThumbnailLayer): LayerBox | null {
  const { canvas } = document, center = layerCenter(layer.visual.position, canvas), { scale, rotation } = layer.visual, content = layer.content;
  if (content.kind === 'shape') return { cx: center.x, cy: center.y, width: content.shape.width * scale, height: content.shape.height * scale, rotation };
  if (content.kind === 'gradient') return { cx: canvas.width / 2, cy: canvas.height / 2, width: canvas.width, height: canvas.height, rotation: 0 };
  if (content.kind === 'video-frame') {
    const stream = document.assets.find(asset => asset.id === content.assetId)?.streams.find(item => item.index === content.streamIndex);
    if (!stream) return null;
    const size = videoFrameSize(stream, canvas);
    return { cx: center.x, cy: center.y, width: size.width * scale, height: size.height * scale, rotation };
  }
  return null;
}
