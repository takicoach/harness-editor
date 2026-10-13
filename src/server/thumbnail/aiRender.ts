import { randomUUID } from 'node:crypto';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { rational, type Rational } from '../../core/sequence/time';
import type { ThumbnailDocument } from '../../core/thumbnail/model';
import { pageToSequence } from '../../core/thumbnail/pageToSequence';
import { verifiedSequenceAssetPath } from '../sequence/assets';
import { captureThumbnailFrames, type ThumbnailFramesCapture } from './capture';
import { thumbnailRenderInputs, type ThumbnailRenderInputs } from './renderInputs';

export class ThumbnailAiSourceMissing extends Error {
  constructor(readonly assetId: string) { super('元の動画（または画像）が見つからないか、中身が変わっています'); this.name = 'ThumbnailAiSourceMissing'; }
}
export function fitLongSide(size: { width: number; height: number }, longSide: number): { width: number; height: number } {
  const scale = longSide / Math.max(size.width, size.height), even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(size.width * scale), height: even(size.height * scale) };
}
/** コマ 1 つにつき 1 フレーム。画面いっぱいに合わせる配置（DEFAULT_MAIN_LAYOUT）で、元の秒から止めて描く。 */
export function framesToSequence(asset: SequenceAsset, streamIndex: number, times: readonly Rational[], size: { width: number; height: number }): SequenceDocument {
  return { schemaVersion: 2, id: `thumbnail-ai-frames.${asset.id}`, name: 'コマ', revision: 0, fps: rational(30), resolution: { ...size }, sequenceEndFrame: times.length,
    background: '#000000', assets: [structuredClone(asset)], tracks: [{ id: 'frames', name: 'コマ', kind: 'visual', enabled: true }],
    clips: times.map((time, index) => ({ id: `frame-${index}`, trackId: 'frames', name: `コマ ${index + 1}`, startFrame: index, durationFrames: 1,
      clock: { offset: rational(0), rate: rational(1), duration: rational(1) }, visual: { layout: { ...DEFAULT_MAIN_LAYOUT }, opacity: 1, keyframes: [] },
      content: { kind: 'video' as const, assetId: asset.id, streamIndex, sourceIn: { ...time }, rate: rational(1), endBehavior: 'hold' as const } })),
    transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
export interface ThumbnailAiRender {
  page(input: { directory: string; projectId: string; origin: string; document: ThumbnailDocument; pageId: string; longSide: number; signal: AbortSignal }): Promise<{ bytes: Buffer; width: number; height: number }>;
  frames(input: { directory: string; projectId: string; origin: string; asset: SequenceAsset; streamIndex: number; times: readonly Rational[]; longSide: number; signal: AbortSignal }): Promise<{ images: Buffer[]; width: number; height: number }>;
}
export function createThumbnailAiRender(deps: { inputs?: ThumbnailRenderInputs; capture?: ThumbnailFramesCapture;
  verify?: (directory: string, asset: SequenceAsset, signal?: AbortSignal) => Promise<string> } = {}): ThumbnailAiRender {
  const inputs = deps.inputs ?? thumbnailRenderInputs, capture = deps.capture ?? captureThumbnailFrames, verify = deps.verify ?? verifiedSequenceAssetPath;
  const checked = async (directory: string, assets: readonly SequenceAsset[], signal: AbortSignal) => {
    for (const asset of assets) { try { await verify(directory, asset, signal); } catch { throw new ThumbnailAiSourceMissing(asset.id); } }
  };
  const shoot = async (directory: string, projectId: string, origin: string, sequence: SequenceDocument, count: number, scale: number, format: 'png' | 'jpeg', signal: AbortSignal) => {
    const jobId = `ai-${randomUUID()}`, release = inputs.register(directory, jobId, sequence);
    try { return await capture({ origin, projectId, jobId, resolution: sequence.resolution, signal }, count, format === 'png' ? { format, scale } : { format, quality: 85, scale }); }
    finally { release(); }
  };
  return {
    async page({ directory, projectId, origin, document, pageId, longSide, signal }) {
      const sequence = pageToSequence(document, pageId), used = new Set(sequence.clips.flatMap(clip => 'assetId' in clip.content ? [clip.content.assetId] : []));
      await checked(directory, document.assets.filter(asset => used.has(asset.id)), signal);
      const size = fitLongSide(document.canvas, longSide), [bytes] = await shoot(directory, projectId, origin, sequence, 1, size.width / document.canvas.width, 'png', signal);
      return { bytes: bytes!, ...size };
    },
    async frames({ directory, projectId, origin, asset, streamIndex, times, longSide, signal }) {
      const stream = asset.streams.find(item => item.index === streamIndex && item.kind === 'video');
      if (!stream?.width || !stream.height) throw new ThumbnailAiSourceMissing(asset.id);
      await checked(directory, [asset], signal);
      const turned = stream.rotation === 90 || stream.rotation === 270 || stream.rotation === -90;
      const size = fitLongSide(turned ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height }, longSide);
      return { images: await shoot(directory, projectId, origin, framesToSequence(asset, streamIndex, times, size), times.length, 1, 'jpeg', signal), ...size };
    },
  };
}
export const thumbnailAiRender = createThumbnailAiRender();
