import { describe, expect, it } from 'vitest';
import type { SequenceAsset } from '../../core/sequence/model';
import { validateSequenceDocument } from '../../core/sequence/validate';
import { buildAudioDocument, buildImageDocument, buildVideoDocument, imageProjectResolution } from './createDocuments';

const ids = () => { let n = 0; return () => `id-${++n}`; };
const audioAsset: SequenceAsset = { id: 'media-audio', kind: 'media', name: 'talk.mp3', file: '.harness/assets/a.mp3', fingerprint: 'a'.repeat(64),
  streams: [{ index: 1, kind: 'audio', codec: 'mp3', duration: { num: 2001, den: 1000 }, sampleRate: 44100, channels: 1 }] };
const image = (id: string): SequenceAsset => ({ id, kind: 'image', name: `${id}.png`, file: `.harness/assets/${id}.png`, fingerprint: 'b'.repeat(64), streams: [] });

describe('画像作品の画面の大きさ（設計 M3・M3c）', () => {
  it.each([
    ['横長 16:9', { width: 640, height: 360 }, { width: 1920, height: 1080 }],
    ['縦長 9:16', { width: 360, height: 640 }, { width: 1080, height: 1920 }],
    ['正方形', { width: 500, height: 500 }, { width: 1080, height: 1080 }],
    ['奇数になる比率は偶数へ丸める', { width: 1001, height: 1000 }, { width: 1082, height: 1080 }],
    ['長辺 3840 を超える横長は長辺で縮める', { width: 20000, height: 1000 }, { width: 3840, height: 192 }],
    ['長辺 3840 を超える縦長も同じ', { width: 1000, height: 20000 }, { width: 192, height: 3840 }],
    ['寸法情報が無い', undefined, { width: 1920, height: 1080 }],
  ] as const)('%s', (_label, display, expected) => {
    const result = imageProjectResolution(display);
    expect(result).toEqual(expected);
    expect(result.width % 2 + result.height % 2).toBe(0);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(3840);
    expect(result.width * result.height).toBeLessThanOrEqual(3840 * 2160);
  });
});

describe('音声の作品（設計 M2）', () => {
  it('fps 30/1・1920x1080・黒背景・長さは ceil(音声の長さ×30)・トラックは a-main 原音1 だけ', () => {
    const doc = buildAudioDocument('podcast', audioAsset, ids());
    validateSequenceDocument(doc);
    expect(doc).toMatchObject({ fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, background: '#000000', sequenceEndFrame: 61 });
    expect(doc.tracks).toEqual([{ id: 'a-main', name: '原音1', kind: 'audio', enabled: true }]);
    expect(doc.clips).toHaveLength(1);
    expect(doc.clips[0]).toMatchObject({ trackId: 'a-main', startFrame: 0, durationFrames: 61,
      content: { kind: 'audio', assetId: 'media-audio', streamIndex: 1, role: 'speech', loop: false, endBehavior: 'silence' } });
  });
  it('音声の無い素材は 422', () => {
    expect(() => buildAudioDocument('x', { ...audioAsset, streams: [] })).toThrow('音声のあるファイル');
  });
});

describe('画像の作品（設計 M3・M3b）', () => {
  it('1枚150コマで隙間なく並べ、同じ内容の素材は1件・クリップは枚数分', () => {
    const doc = buildImageDocument('album', [{ asset: image('image-a'), name: '1.png' }, { asset: image('image-b'), name: '2.png' }, { asset: image('image-a'), name: '3.png' }],
      { width: 360, height: 640 }, ids());
    validateSequenceDocument(doc);
    expect(doc).toMatchObject({ fps: { num: 30, den: 1 }, resolution: { width: 1080, height: 1920 }, sequenceEndFrame: 450, background: '#000000' });
    expect(doc.assets.map((asset) => asset.id)).toEqual(['image-a', 'image-b']);
    expect(doc.tracks).toEqual([{ id: 'v-main', name: '映像1', kind: 'visual', enabled: true }]);
    expect(doc.clips.map((clip) => [clip.name, clip.startFrame, clip.durationFrames, clip.content.kind === 'image' && clip.content.assetId, clip.content.kind === 'image' && clip.content.style]))
      .toEqual([['1.png', 0, 150, 'image-a', 'plain'], ['2.png', 150, 150, 'image-b', 'plain'], ['3.png', 300, 150, 'image-a', 'plain']]);
  });
});

describe('動画の作品（従来どおり）', () => {
  it('映像の fps・寸法・原音のリンクを保つ', () => {
    const video: SequenceAsset = { id: 'media-video', kind: 'media', name: 'take.mp4', file: '.harness/assets/v.mp4', fingerprint: 'c'.repeat(64), streams: [
      { index: 0, kind: 'video', codec: 'h264', duration: { num: 1001, den: 1000 }, frameRate: { num: 30000, den: 1001 }, width: 320, height: 180, rotation: 0 },
      { index: 1, kind: 'audio', codec: 'aac', duration: { num: 1001, den: 1000 }, sampleRate: 48000, channels: 2 }] };
    const doc = buildVideoDocument('take', video, ids());
    validateSequenceDocument(doc);
    expect(doc).toMatchObject({ fps: { num: 30000, den: 1001 }, sequenceEndFrame: 30, resolution: { width: 320, height: 180 } });
    expect(doc.clips.map((clip) => clip.content.kind)).toEqual(['video', 'audio']);
    expect(new Set(doc.clips.map((clip) => clip.linkGroupId)).size).toBe(1);
  });
});
