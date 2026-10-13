import type { CSSProperties } from 'react';
import { pureLayerBox, type LayerBox } from '../../../core/thumbnail/geometry';
import type { ThumbnailCanvas, ThumbnailContent, ThumbnailDocument, ThumbnailLayer, ThumbnailPage, ThumbnailVisual } from '../../../core/thumbnail/model';
import type { RenderedSceneGeometry } from '../../../preview/native/renderGeometry';

export type { LayerBox };
/** ドラッグ・つまみの操作中だけ見せる値。離した時点で 1 回のコマンドになる。 */
export interface LayerOverride { visual?: ThumbnailVisual; content?: ThumbnailContent }

export function applyOverrides(document: ThumbnailDocument, pageId: string, overrides: ReadonlyMap<string, LayerOverride>): ThumbnailDocument {
  if (!overrides.size) return document;
  return { ...document, pages: document.pages.map(page => page.id !== pageId ? page : { ...page, layers: page.layers.map(layer => {
    const override = overrides.get(layer.id);
    return override ? { ...layer, ...(override.visual ? { visual: override.visual } : {}), ...(override.content ? { content: override.content } : {}) } : layer;
  }) }) };
}
/** 図形・帯は文書だけで決まる。文字・画像・コマは描画の計測（縁取り・影・傾きを含む）を使う。コマは描けないとき文書から。 */
export function layerBoxes(document: ThumbnailDocument, pageId: string, geometry: RenderedSceneGeometry | null): Map<string, LayerBox> {
  const page = document.pages.find(item => item.id === pageId), boxes = new Map<string, LayerBox>();
  if (!page) return boxes;
  const measured = new Map([...(geometry?.videos ?? []), ...(geometry?.images ?? []), ...(geometry?.elements ?? [])].map(item => [item.clipId, item.bounds]));
  for (const layer of page.layers) {
    const pure = pureLayerBox(document, layer);
    if (pure && layer.content.kind !== 'video-frame') { boxes.set(layer.id, pure); continue; }
    const bounds = measured.get(layer.id);
    if (bounds) boxes.set(layer.id, { cx: bounds.x + bounds.width / 2, cy: bounds.y + bounds.height / 2, width: bounds.width, height: bounds.height, rotation: bounds.rotation });
    else if (pure) boxes.set(layer.id, pure);
  }
  return boxes;
}
export function boxStyle(box: LayerBox, scale: number): CSSProperties {
  return { left: (box.cx - box.width / 2) * scale, top: (box.cy - box.height / 2) * scale, width: box.width * scale, height: box.height * scale, transform: `rotate(${box.rotation}deg)` };
}

/** 右下に置く小窓（スマホでの見え方）が占める広さ。表示領域の右端・下端からの距離（小窓の大きさ＋外側の余白＋すき間）。 */
export interface StageReserve { width: number; height: number }
export interface StageFit { scale: number; padRight: number; padBottom: number }
/** 全体表示の倍率と、表示領域の右・下の余白。小窓があるときは、下を空ける並べ方と右を空ける並べ方のうちキャンバスが大きくなる方を選ぶ。
 *  キャンバスは余白の内側に中央寄せで置くので、空けた側には入らない（小窓と重ならない）。 */
export function fitStage(viewport: { width: number; height: number }, canvas: { width: number; height: number }, reserve: StageReserve | null, pad = 24): StageFit {
  const scaleFor = (right: number, bottom: number) => Math.max(.05, Math.min((viewport.width - pad - right) / canvas.width, (viewport.height - pad - bottom) / canvas.height));
  if (!reserve) return { scale: scaleFor(pad, pad), padRight: pad, padBottom: pad };
  const bottom = Math.max(pad, reserve.height), right = Math.max(pad, reserve.width), below = scaleFor(pad, bottom), beside = scaleFor(right, pad);
  return below >= beside ? { scale: below, padRight: pad, padBottom: bottom } : { scale: beside, padRight: right, padBottom: pad };
}

export interface Point { x: number; y: number }
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export function toCanvasPoint(event: { clientX: number; clientY: number }, rect: { left: number; top: number }, scale: number): Point {
  return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
}
export function boxCorners(box: LayerBox): Point[] {
  const angle = box.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle), halfWidth = box.width / 2, halfHeight = box.height / 2;
  return ([[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]] as const)
    .map(([x, y]) => ({ x: Math.round((box.cx + x * cos - y * sin) * 1e6) / 1e6, y: Math.round((box.cy + x * sin + y * cos) * 1e6) / 1e6 }));
}
export function midpoint(a: Point, b: Point): Point { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
export function boxExtent(box: LayerBox): { left: number; top: number; right: number; bottom: number } {
  const corners = boxCorners(box), xs = corners.map(point => point.x), ys = corners.map(point => point.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
export function pointInBox(point: Point, box: LayerBox): boolean {
  const angle = -box.rotation * Math.PI / 180, dx = point.x - box.cx, dy = point.y - box.cy;
  const x = dx * Math.cos(angle) - dy * Math.sin(angle), y = dx * Math.sin(angle) + dy * Math.cos(angle);
  return Math.abs(x) <= box.width / 2 && Math.abs(y) <= box.height / 2;
}
/** 前面（配列の後ろ）から当たりを見る。非表示は選べない。帯の暗さはキャンバス全面なので選ばない（右の「サムネ全体」で触る）。 */
export function hitTest(page: ThumbnailPage, boxes: ReadonlyMap<string, LayerBox>, point: Point): string | null {
  for (let index = page.layers.length - 1; index >= 0; index--) {
    const layer = page.layers[index]!, box = boxes.get(layer.id);
    if (layer.hidden || layer.content.kind === 'gradient' || !box) continue;
    if (pointInBox(point, box)) return layer.id;
  }
  return null;
}
/** 検証と同じ範囲（写真・コマは ±1.5、文字・図形は ±3）。 */
export function positionLimit(layer: ThumbnailLayer): number {
  const kind = layer.content.kind;
  return kind === 'image' || kind === 'video-frame' || kind === 'gradient' ? 1.5 : 3;
}
export function movedVisual(layer: ThumbnailLayer, dx: number, dy: number, canvas: ThumbnailCanvas): ThumbnailVisual {
  const limit = positionLimit(layer), round = (value: number) => Math.round(value * 10000) / 10000;
  return { ...layer.visual, position: { x: round(clamp(layer.visual.position.x + dx / (canvas.width / 2), -limit, limit)),
    y: round(clamp(layer.visual.position.y + dy / (canvas.height / 2), -limit, limit)) } };
}
export function scaleRatio(center: Point, start: Point, current: Point): number {
  const from = Math.hypot(start.x - center.x, start.y - center.y), to = Math.hypot(current.x - center.x, current.y - center.y);
  return from < 1 ? 1 : Math.max(.02, to / from);
}
/** 四隅のハンドル。文字は「文字の大きさ」と文字枠を同じ倍率で変える（目安の測り方と合わせる）。ほかは scale。 */
export function scaledLayer(layer: ThumbnailLayer, ratio: number): LayerOverride {
  if (layer.content.kind === 'text') {
    const appearance = layer.content.appearance, fontSize = clamp(Math.round(appearance.fontSize * ratio), 8, 1000), factor = fontSize / appearance.fontSize;
    const box = appearance.box ? { ...appearance.box, width: clamp(Math.round(appearance.box.width * factor * 1000) / 1000, .05, 1) } : undefined;
    return { content: { ...layer.content, appearance: { ...appearance, fontSize, ...(box ? { box } : {}) } } };
  }
  return { visual: { ...layer.visual, scale: clamp(Math.round(layer.visual.scale * ratio * 1000) / 1000, .05, 8) } };
}
/** 文字の左右のハンドル。ずらした量（文字の向きに沿った成分）の 2 倍だけ、文字枠を両側へ広げる。 */
export function widthFromHandle(layer: ThumbnailLayer, box: LayerBox, start: Point, current: Point, side: 'left' | 'right', canvas: ThumbnailCanvas): LayerOverride {
  if (layer.content.kind !== 'text') return {};
  const appearance = layer.content.appearance, angle = box.rotation * Math.PI / 180, scale = layer.visual.scale;
  const along = ((current.x - start.x) * Math.cos(angle) + (current.y - start.y) * Math.sin(angle)) * (side === 'right' ? 1 : -1);
  const shown = (appearance.box?.width ?? .85) * canvas.width * scale + 2 * along;
  const width = clamp(Math.round(shown / (canvas.width * scale) * 1000) / 1000, .05, 1);
  return { content: { ...layer.content, appearance: { ...appearance, box: { width, anchor: appearance.box?.anchor ?? 'center' } } } };
}

/** 中心から見た「つかんだ点」と「今の点」の角度の差だけ回す。Shift で 15° 刻み。-180..180 に収める。 */
export function rotationFromPointer(center: Point, start: Point, current: Point, startRotation: number, snap: boolean): number {
  const delta = (Math.atan2(current.y - center.y, current.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x)) * 180 / Math.PI;
  let angle = ((startRotation + delta + 180) % 360 + 360) % 360 - 180;
  if (snap) angle = Math.round(angle / 15) * 15;
  if (angle > 180) angle -= 360;
  return Math.round(angle * 10) / 10 || 0;
}

export interface SnapResult { dx: number; dy: number; guidesX: number[]; guidesY: number[] }
export function unionBox(boxes: readonly LayerBox[]): LayerBox {
  const extents = boxes.map(boxExtent);
  const left = Math.min(...extents.map(item => item.left)), top = Math.min(...extents.map(item => item.top));
  const right = Math.max(...extents.map(item => item.right)), bottom = Math.max(...extents.map(item => item.bottom));
  return { cx: (left + right) / 2, cy: (top + bottom) / 2, width: right - left, height: bottom - top, rotation: 0 };
}
/** 動かしている箱の左・中央・右（上・中央・下）を、キャンバスの端と中央、ほかの要素の端と中央へ、最も近い 1 本ずつ吸い付ける。 */
export function snapMove(moving: LayerBox, others: readonly LayerBox[], canvas: ThumbnailCanvas, threshold: number): SnapResult {
  const self = boxExtent(moving), targetsX = [0, canvas.width / 2, canvas.width], targetsY = [0, canvas.height / 2, canvas.height];
  for (const other of others) {
    const extent = boxExtent(other);
    targetsX.push(extent.left, (extent.left + extent.right) / 2, extent.right);
    targetsY.push(extent.top, (extent.top + extent.bottom) / 2, extent.bottom);
  }
  const nearest = (values: number[], targets: number[]) => {
    let delta = 0, line: number | null = null;
    for (const value of values) for (const target of targets) {
      const difference = target - value;
      if (Math.abs(difference) <= threshold && (line === null || Math.abs(difference) < Math.abs(delta))) { delta = difference; line = target; }
    }
    return { delta: Math.round(delta * 1000) / 1000, lines: line === null ? [] : [line] };
  };
  const x = nearest([self.left, (self.left + self.right) / 2, self.right], targetsX), y = nearest([self.top, (self.top + self.bottom) / 2, self.bottom], targetsY);
  return { dx: x.delta, dy: y.delta, guidesX: x.lines, guidesY: y.lines };
}
/** その場編集の入力欄の枠。編集中の文字は描画から外すので計測に頼らず、文字枠の幅と行数から決める（中央基準）。 */
export function textEditBox(layer: ThumbnailLayer, canvas: ThumbnailCanvas, text: string): LayerBox | null {
  if (layer.content.kind !== 'text') return null;
  const appearance = layer.content.appearance, scale = layer.visual.scale, lines = Math.max(1, text.split('\n').length);
  const height = appearance.fontSize * appearance.lineHeight * lines * scale, rad = layer.visual.rotation * Math.PI / 180;
  // 上揃え（anchor 'top'）は層の位置が文字枠の上端。中央基準へ、枠の高さの半分だけ（回転に沿って）下げる。サムネは top を使わない。
  const shift = appearance.box?.anchor === 'top' ? height / 2 : 0;
  return { cx: canvas.width / 2 * (1 + layer.visual.position.x) - Math.sin(rad) * shift, cy: canvas.height / 2 * (1 + layer.visual.position.y) + Math.cos(rad) * shift,
    width: (appearance.box?.width ?? .85) * canvas.width * scale, height, rotation: layer.visual.rotation };
}

export type CanvasAlign = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
/** 外接箱（回転込み）をキャンバスの端・中央にそろえる。 */
export function alignedVisual(layer: ThumbnailLayer, box: LayerBox, canvas: ThumbnailCanvas, where: CanvasAlign): ThumbnailVisual {
  const extent = boxExtent(box);
  const dx = where === 'left' ? -extent.left : where === 'center' ? canvas.width / 2 - box.cx : where === 'right' ? canvas.width - extent.right : 0;
  const dy = where === 'top' ? -extent.top : where === 'middle' ? canvas.height / 2 - box.cy : where === 'bottom' ? canvas.height - extent.bottom : 0;
  return movedVisual(layer, dx, dy, canvas);
}
