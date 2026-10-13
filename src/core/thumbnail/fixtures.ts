/** テスト専用の見本。本番コードから import しない。 */
import { fontById, fontStack } from '../fonts';
import { DEFAULT_TEXT_APPEARANCE, type SequenceAsset, type TextAppearance } from '../sequence/model';
import { rational } from '../sequence/time';
import { defaultThumbnailVisual, type ThumbnailDocument, type ThumbnailLayer } from './model';

export const IMAGE_ASSET: SequenceAsset = { id: 'img-1', kind: 'image', name: 'photo.png', file: `.harness/assets/${'a'.repeat(64)}.png`, fingerprint: 'a'.repeat(64), streams: [] };
export const VIDEO_ASSET: SequenceAsset = { id: 'vid-1', kind: 'media', name: 'clip.mp4', file: `.harness/assets/${'b'.repeat(64)}.mp4`, fingerprint: 'b'.repeat(64),
  streams: [{ index: 0, kind: 'video', codec: 'h264', duration: { num: 3, den: 1 }, frameRate: { num: 30, den: 1 }, width: 1920, height: 1080 }] };
export function fixtureAppearance(): TextAppearance {
  return { ...DEFAULT_TEXT_APPEARANCE, fontFamily: fontStack(fontById('noto-sans-jp')!), fontSize: 120, fontWeight: 700, color: '#ffffff', strokeColor: '#000000',
    strokeWidth: 0, background: 'transparent', box: { width: .9, anchor: 'center' } };
}
const base = (id: string, name: string, content: ThumbnailLayer['content']): ThumbnailLayer => ({ id, name, hidden: false, locked: false, content, visual: defaultThumbnailVisual() });
export const textLayer = (id: string, text = 'サムネ'): ThumbnailLayer => base(id, text, { kind: 'text', text, appearance: fixtureAppearance() });
export const imageLayer = (id: string): ThumbnailLayer => base(id, '写真', { kind: 'image', assetId: IMAGE_ASSET.id, role: 'photo' });
export const shapeLayer = (id: string): ThumbnailLayer => base(id, '四角', { kind: 'shape', shape: { kind: 'rect', width: 300, height: 200, color: '#ff3b30', strokeWidth: 8, cornerRadius: 0, fill: null } });
export const videoFrameLayer = (id: string, frame = 1): ThumbnailLayer =>
  base(id, '動画のコマ', { kind: 'video-frame', assetId: VIDEO_ASSET.id, streamIndex: 0, fingerprint: VIDEO_ASSET.fingerprint, sourceTime: rational(2 * frame + 1, 60) });
export const gradientLayer = (id: string): ThumbnailLayer => base(id, '暗さ', { kind: 'gradient', side: 'left', amount: .6, color: '#000000' });
export function thumbnailFixture(): ThumbnailDocument {
  return { schemaVersion: 1, id: 'thumb', revision: 0, canvas: { width: 1280, height: 720 }, assets: [structuredClone(IMAGE_ASSET), structuredClone(VIDEO_ASSET)],
    pages: [{ id: 'page-a', name: '案A', hueShift: 0, layers: [imageLayer('photo'), gradientLayer('shade'), textLayer('title'), shapeLayer('box'), videoFrameLayer('frame')] }] };
}
