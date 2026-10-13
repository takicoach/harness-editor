import { isIdentityColorGrade } from '../colorGrade';
import type { ClipVisual, SequenceClip, SequenceDocument, SequenceTrack, ShapeFill, VisualLook } from '../sequence/model';
import { rational } from '../sequence/time';
import { shapeBoxData } from './geometry';
import { findPage, type GradientSide, type ThumbnailContent, type ThumbnailDocument, type ThumbnailLayer } from './model';

export interface PageToSequenceOptions { unavailableAssetIds?: ReadonlySet<string>; hiddenLayerIds?: ReadonlySet<string> }
const GRADIENT_ANGLE: Record<GradientSide, number> = { left: 0, right: 180, top: 90, bottom: 270 };
const alphaHex = (amount: number) => Math.round(Math.max(0, Math.min(1, amount)) * 255).toString(16).padStart(2, '0');

export function gradientFill(content: Extract<ThumbnailContent, { kind: 'gradient' }>): ShapeFill {
  return { kind: 'linear', angle: GRADIENT_ANGLE[content.side],
    stops: [{ offset: 0, color: `${content.color}${alphaHex(content.amount)}` }, { offset: .65, color: `${content.color}00` }] };
}
function layerContent(document: ThumbnailDocument, layer: ThumbnailLayer): SequenceClip['content'] {
  const content = layer.content;
  switch (content.kind) {
    case 'text': return { kind: 'telop', data: { text: content.text, animation: 'none' }, appearance: structuredClone(content.appearance), textMode: 'free' };
    case 'image': return { kind: 'image', assetId: content.assetId, style: 'plain' };
    case 'shape': {
      const shape = content.shape;
      return { kind: 'shape', data: { kind: shape.kind, ...shapeBoxData(shape, document.canvas), color: shape.color, thickness: 'medium' },
        strokeWidth: shape.strokeWidth, cornerRadius: shape.cornerRadius, ...(shape.fill ? { fill: structuredClone(shape.fill) } : {}) };
    }
    case 'video-frame': return { kind: 'video', assetId: content.assetId, streamIndex: content.streamIndex,
      sourceIn: rational(content.sourceTime.num, content.sourceTime.den), rate: rational(1), endBehavior: 'hold' };
    case 'gradient': return { kind: 'shape', data: { kind: 'rect', x1: 0, y1: 0, x2: 1, y2: 1, color: '#000000', thickness: 'thin' }, strokeWidth: 0, fill: gradientFill(content) };
  }
}
function layerVisual(layer: ThumbnailLayer): ClipVisual {
  const source = layer.visual, kind = layer.content.kind, full = kind === 'gradient';
  const visual: ClipVisual = { layout: { position: full ? { x: 0, y: 0 } : { ...source.position }, scale: full ? 1 : source.scale, background: '#000000',
    rotation: full ? 0 : source.rotation, flipH: false, flipV: false }, opacity: source.opacity, keyframes: [], enter: { kind: 'none', frames: 0 }, exit: { kind: 'none', frames: 0 } };
  const look: VisualLook = {};
  if (kind === 'image') {
    if (source.color && !isIdentityColorGrade(source.color)) look.grade = { ...source.color };
    if (source.blur) look.blur = source.blur;
    if (source.edge && source.edge.width > 0) look.edge = { ...source.edge };
    if (source.shadow) look.shadow = { ...source.shadow };
    if (source.flipX) look.flipX = true;
  } else if (kind === 'video-frame') {
    if (source.color && !isIdentityColorGrade(source.color)) visual.colorGrade = { ...source.color };
    if (source.blur) look.blur = source.blur;
  }
  if (Object.keys(look).length) visual.look = look;
  return visual;
}
/** 案を 1 コマの SequenceDocument にする（プレビュー＝書き出し）。重なり順はレイヤーの順。 */
export function pageToSequence(document: ThumbnailDocument, pageId: string, options: PageToSequenceOptions = {}): SequenceDocument {
  const page = findPage(document, pageId), tracks: SequenceTrack[] = [], clips: SequenceClip[] = [];
  for (const layer of page.layers) {
    const content = layer.content, assetId = content.kind === 'image' || content.kind === 'video-frame' ? content.assetId : undefined, trackId = `track-${layer.id}`;
    const unavailable = assetId !== undefined && !!options.unavailableAssetIds?.has(assetId);
    tracks.push({ id: trackId, kind: 'visual', name: layer.name, enabled: !layer.hidden && !options.hiddenLayerIds?.has(layer.id) && !unavailable });
    clips.push({ id: layer.id, trackId, name: layer.name, startFrame: 0, durationFrames: 1, clock: { offset: rational(0), rate: rational(1), duration: rational(1) },
      content: layerContent(document, layer), visual: layerVisual(layer) });
  }
  return { schemaVersion: 2, id: `thumbnail.${page.id}`, name: page.name, revision: document.revision, fps: rational(30), resolution: { ...document.canvas },
    sequenceEndFrame: 1, background: '#000000', assets: structuredClone(document.assets), tracks, clips, transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
