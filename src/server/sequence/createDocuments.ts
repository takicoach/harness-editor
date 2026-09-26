import { randomUUID } from 'node:crypto';
import { HttpError } from '../http';
import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { DEFAULT_MAIN_AUDIO } from '../../core/mainAudio';
import { ceilTime, multiplyTime, rational, timeNumber } from '../../core/sequence/time';
import type { SequenceAsset, SequenceClip, SequenceDocument } from '../../core/sequence/model';
import type { ImageDisplaySize } from './imageProbe';

/** 音声・画像の作品の fps（設計 M2・M3）。 */
export const CREATE_FPS = rational(30);
/** 画像1枚の長さ（秒）。コマ数は round(fps×5)（設計 M3）。 */
export const IMAGE_SECONDS = 5;
/** 寸法情報が無い画像・音声の作品の画面の大きさ（設計 M2・M3c）。 */
export const DEFAULT_RESOLUTION = { width: 1920, height: 1080 } as const;
/** 画像作品の画面の大きさの基準と上限（設計 M3c）。 */
export const IMAGE_SHORT_SIDE = 1080;
export const IMAGE_MAX_LONG_SIDE = 3840;
export const IMAGE_MAX_PIXELS = 3840 * 2160;

type NewId = () => string;
const clockOf = (frames: number) => ({ offset: rational(0), rate: rational(1), duration: rational(frames) });
const emptyParts = () => ({ transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' as const } });

/**
 * 最初の画像の表示上の縦横比で、短辺を 1080 にする。長辺は最大 3840、総画素数は最大 3840×2160。
 * 縦横比を保って縮めてから、両辺を偶数に丸める（設計 M3・M3c）。寸法情報が無ければ 1920x1080。
 */
export function imageProjectResolution(display?: ImageDisplaySize): { width: number; height: number } {
  if (!display || !(display.width > 0) || !(display.height > 0)) return { ...DEFAULT_RESOLUTION };
  const { width, height } = display;
  const scale = Math.min(IMAGE_SHORT_SIDE / Math.min(width, height), IMAGE_MAX_LONG_SIDE / Math.max(width, height), Math.sqrt(IMAGE_MAX_PIXELS / (width * height)));
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

/** 動画1件の作品（従来の create.ts の作り方をそのまま移したもの）。 */
export function buildVideoDocument(name: string, asset: SequenceAsset, newId: NewId = randomUUID): SequenceDocument {
  const video = asset.streams.find(stream => stream.kind === 'video'), audio = asset.streams.find(stream => stream.kind === 'audio');
  if (!video?.frameRate || !video.width || !video.height) throw new HttpError(422, '映像のある動画ファイルを選んでください');
  const fps = video.frameRate, frames = ceilTime(multiplyTime(video.duration, fps)), clock = clockOf(frames);
  if (frames < 1) throw new HttpError(422, '動画の長さを確認できません');
  const link = audio ? newId() : undefined, rotated = Math.abs(video.rotation ?? 0) % 180 === 90;
  const document: SequenceDocument = { schemaVersion: 2, id: newId(), name, revision: 0, fps,
    resolution: { width: rotated ? video.height : video.width, height: rotated ? video.width : video.height }, sequenceEndFrame: frames, background: '#000000', assets: [asset],
    tracks: [{ id: 'v-main', name: '映像1', kind: 'visual', enabled: true }],
    clips: [{ id: newId(), name: asset.name, trackId: 'v-main', startFrame: 0, durationFrames: frames, clock, linkGroupId: link,
      visual: { layout: structuredClone(DEFAULT_MAIN_LAYOUT), opacity: 1, keyframes: [] },
      content: { kind: 'video', assetId: asset.id, streamIndex: video.index, sourceIn: rational(0), rate: rational(1), endBehavior: 'hold' } }],
    ...emptyParts() };
  if (audio) {
    document.tracks.push({ id: 'a-main', name: '原音1', kind: 'audio', enabled: true });
    document.clips.push({ id: newId(), name: `${asset.name} 原音`, trackId: 'a-main', startFrame: 0, durationFrames: frames, clock, linkGroupId: link,
      content: { kind: 'audio', assetId: asset.id, streamIndex: audio.index, sourceIn: rational(0), rate: rational(1), role: 'speech', loop: false, endBehavior: 'silence', settings: structuredClone(DEFAULT_MAIN_AUDIO) } });
  }
  return document;
}

/**
 * 音声1件の作品（設計 M2）: fps 30/1・1920x1080・背景 #000000・長さ ceil(音声の長さ×30)。
 * トラックは「a-main 原音1」だけ。音声は speech（動画の原音と同じ: ループなし・endBehavior 'silence'）。映像トラックは作らない。
 */
export function buildAudioDocument(name: string, asset: SequenceAsset, newId: NewId = randomUUID): SequenceDocument {
  const audio = asset.streams.find(stream => stream.kind === 'audio');
  if (!audio) throw new HttpError(422, '音声のあるファイルを選んでください');
  const frames = ceilTime(multiplyTime(audio.duration, CREATE_FPS));
  if (frames < 1) throw new HttpError(422, '音声の長さを確認できません');
  return { schemaVersion: 2, id: newId(), name, revision: 0, fps: CREATE_FPS, resolution: { ...DEFAULT_RESOLUTION }, sequenceEndFrame: frames,
    background: '#000000', assets: [asset], tracks: [{ id: 'a-main', name: '原音1', kind: 'audio', enabled: true }],
    clips: [{ id: newId(), name: asset.name, trackId: 'a-main', startFrame: 0, durationFrames: frames, clock: clockOf(frames),
      content: { kind: 'audio', assetId: asset.id, streamIndex: audio.index, sourceIn: rational(0), rate: rational(1), role: 'speech', loop: false, endBehavior: 'silence', settings: structuredClone(DEFAULT_MAIN_AUDIO) } }],
    ...emptyParts() };
}

export interface ImagePlacement { asset: SequenceAsset; name: string }
/**
 * 画像の作品（設計 M3・M3b）: 並んだ順に1枚 round(fps×5) コマで映像トラック1本に隙間なく並べる。見せ方は plain（収める表示）。
 * 同じ内容（同じ素材 ID）の画像は素材を1件にまとめ、クリップは選んだ枚数だけ作る。
 */
export function buildImageDocument(name: string, placements: readonly ImagePlacement[], display: ImageDisplaySize | undefined, newId: NewId = randomUUID): SequenceDocument {
  if (!placements.length) throw new HttpError(400, '画像を選んでください');
  const per = Math.round(timeNumber(CREATE_FPS) * IMAGE_SECONDS), assets: SequenceAsset[] = [];
  for (const { asset } of placements) if (!assets.some(item => item.id === asset.id)) assets.push(asset);
  const clips: SequenceClip[] = placements.map((placement, index) => ({ id: newId(), name: placement.name, trackId: 'v-main', startFrame: index * per, durationFrames: per,
    clock: clockOf(per), visual: { layout: structuredClone(DEFAULT_MAIN_LAYOUT), opacity: 1, keyframes: [] },
    content: { kind: 'image', assetId: placement.asset.id, style: 'plain' } }));
  return { schemaVersion: 2, id: newId(), name, revision: 0, fps: CREATE_FPS, resolution: imageProjectResolution(display), sequenceEndFrame: per * placements.length,
    background: '#000000', assets, tracks: [{ id: 'v-main', name: '映像1', kind: 'visual', enabled: true }], clips, ...emptyParts() };
}
