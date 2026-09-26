import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSequenceProject } from './create';
import { SequenceStore } from './store';
import { precheckCreateProject } from '../projectCreationChecks';
import { makeMediaSamples, type MediaSamples } from './__fixtures__/mediaSamples';

let samples: MediaSamples, root: string;
beforeAll(async () => { samples = makeMediaSamples(await mkdtemp(join(tmpdir(), 'create-media-samples-'))); }, 30_000);
afterAll(async () => { await rm(samples.dir, { recursive: true, force: true }); });
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function freshRoot(): Promise<string> { root = await mkdtemp(join(await realpath(tmpdir()), 'create-media-root-')); return root; }
const load = (id: string) => new SequenceStore(join(root, id)).load()!.document;

describe('音声1件から作る（設計 M2）', () => {
  it('wav: fps 30・1920x1080・黒背景・a-main 原音1 だけ・speech・長さは ceil(秒×30)', async () => {
    await freshRoot();
    const { id } = await createSequenceProject(root, { name: 'ポッドキャスト', videoName: 'talk.wav', sourcePath: samples.wav });
    const doc = load(id);
    expect(doc).toMatchObject({ fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, background: '#000000', sequenceEndFrame: 60 });
    expect(doc.tracks.map((track) => [track.id, track.name, track.kind])).toEqual([['a-main', '原音1', 'audio']]);
    expect(doc.clips).toEqual([expect.objectContaining({ trackId: 'a-main', startFrame: 0, durationFrames: 60,
      content: expect.objectContaining({ kind: 'audio', role: 'speech', loop: false, endBehavior: 'silence' }) })]);
    expect(await readFile(join(root, id, doc.assets[0]!.file))).toEqual(await readFile(samples.wav));
  });
  it('表紙付き mp3 は純粋な音声の作品になる（fps 90000 の壊れた作品にならない）', async () => {
    await freshRoot();
    const { id } = await createSequenceProject(root, { name: 'cover', videoName: 'cover.mp3', sourcePath: samples.coverMp3 });
    const doc = load(id);
    expect(doc.fps).toEqual({ num: 30, den: 1 });
    expect(doc.assets[0]!.streams.map((stream) => stream.kind)).toEqual(['audio']);
    expect(doc.clips.map((clip) => clip.content.kind)).toEqual(['audio']);
  });
});

describe('画像1枚から作る（設計 M3・M3c・M3d・M3e）', () => {
  it('コピー: 1枚 150 コマ・plain・最初の画像の比率で短辺 1080', async () => {
    await freshRoot();
    const { id } = await createSequenceProject(root, { name: 'one', videoName: 'landscape.png', sourcePath: samples.landscapePng });
    const doc = load(id);
    expect(doc).toMatchObject({ fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 150 });
    expect(doc.clips).toEqual([expect.objectContaining({ trackId: 'v-main', durationFrames: 150, content: { kind: 'image', assetId: doc.assets[0]!.id, style: 'plain' } })]);
  });
  it('参照を優先（今の動画と同じ選択肢）: 指紋が一致すればコピーせずリンクで作る', async () => {
    await freshRoot();
    const fingerprint = createHash('sha256').update(await readFile(samples.portraitPng)).digest('hex');
    const { id } = await createSequenceProject(root, { name: 'linked', videoName: samples.portraitPng, sourcePath: samples.portraitPng, reference: true, expectedFingerprint: fingerprint });
    const doc = load(id);
    expect(doc.resolution).toEqual({ width: 1080, height: 1920 });
    expect((await lstat(join(root, id, doc.assets[0]!.file))).isSymbolicLink()).toBe(true);
  });
  it('EXIF の向き 6 の JPEG は表示上の縦長で判定する（640x360 で符号化 → 1080x1920）', async () => {
    await freshRoot();
    const { id } = await createSequenceProject(root, { name: 'rotated', videoName: 'exif-rotated.jpg', sourcePath: samples.exifRotatedJpg });
    expect(load(id).resolution).toEqual({ width: 1080, height: 1920 });
  });
  it('動く GIF は断り、1コマの GIF は受け付ける。作りかけのフォルダは残さない', async () => {
    await freshRoot();
    await expect(createSequenceProject(root, { name: 'moving', videoName: 'animated.gif', sourcePath: samples.animatedGif }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('動く画像にはまだ対応していません') });
    expect(await readdir(root)).toEqual([]);
    const { id } = await createSequenceProject(root, { name: 'still', videoName: 'still.gif', sourcePath: samples.stillGif });
    expect(load(id).clips).toHaveLength(1);
  });
  it('壊れていて読めない画像は 422 で断る（1920x1080 に落とさない）', async () => {
    await freshRoot();
    await expect(createSequenceProject(root, { name: 'broken', videoName: 'broken.png', sourcePath: samples.brokenPng }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('画像として読み取れません') });
    expect(await readdir(root)).toEqual([]);
  });
});

describe('事前確認の拡張子と文言（設計 M5・M6）', () => {
  it('音声・画像を受け付け、それ以外は対応の拡張子を示して 400', async () => {
    await freshRoot();
    for (const name of ['talk.mp3', 'talk.wav', 'a.png', 'b.JPG', 'take.mp4']) expect(() => precheckCreateProject(root, 'ok', name)).not.toThrow();
    expect(() => precheckCreateProject(root, 'ok', 'notes.txt')).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining('動画・音声・画像のファイルを選んでください') }));
  });
});
