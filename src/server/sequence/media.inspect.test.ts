import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { importSequenceAsset } from './assets';
import { mediaStreamsFromProbe, prepareSequenceAudio, probeSequenceAsset } from './media';
import { animatedWebpHeader, makeMediaSamples, type MediaSamples } from './__fixtures__/mediaSamples';

// spawn を実体のまま包む。1件のテストだけ abortOnSpawn を立て、ffprobe の起動直後（digest 完了後）に
// controller を中止させ、画像の ffprobe 失敗を包む catch にある「signal?.aborted」分岐を実際の中止で通す（M-2）。
let abortOnSpawn: (() => void) | undefined;
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    // media.ts の run() が child.on('error', ...) を張り終えてから中止する（張る前だと未処理の例外になる）。
    if (abortOnSpawn) setImmediate(abortOnSpawn);
    return child;
  } };
});

let samples: MediaSamples;
const owned: string[] = [];
beforeAll(async () => { samples = makeMediaSamples(await mkdtemp(join(tmpdir(), 'media-inspect-samples-'))); }, 30_000);
afterAll(async () => { await rm(samples.dir, { recursive: true, force: true }); });
afterEach(async () => { for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function project(): Promise<string> { const dir = await mkdtemp(join(await realpath(tmpdir()), 'media-inspect-project-')); owned.push(dir); return dir; }
/** 案件フォルダへ置いて、登録時と同じ検査（probeSequenceAsset）にかける。 */
async function probeCopy(source: string) { const dir = await project(), name = basename(source); await copyFile(source, join(dir, name)); return probeSequenceAsset(dir, name, name); }

describe('新規登録: 表紙画像（attached_pic）を映像として登録しない（設計 M4・M4b）', () => {
  it.each(['coverMp3', 'coverM4a'] as const)('%s は音声 1 本だけの素材になり、音声の番号は元のまま', async (key) => {
    const dir = await project(), asset = await importSequenceAsset(dir, samples[key]);
    expect(asset.kind).toBe('media');
    expect(asset.streams).toEqual([expect.objectContaining({ index: 0, kind: 'audio' })]);
    expect(JSON.parse(await readFile(join(dir, `${asset.file}.json`), 'utf8')).asset.streams).toEqual(asset.streams);
    // 純粋な音声素材として、書き出し・再生用の PCM が作れる（2 秒 × 48000）。
    expect((await prepareSequenceAudio(dir, asset, 0, { num: 1, den: 1 })).sampleCount).toBeGreaterThanOrEqual(96_000);
  });
  it('表紙は長さ・fps の検査より前に除き、残る番号は振り直さない（表紙が 0 番の形）', () => {
    const result = mediaStreamsFromProbe({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
      { index: 1, codec_type: 'audio', codec_name: 'aac', time_base: '1/48000', duration_ts: 96000, sample_rate: '48000', channels: 2 },
    ] });
    expect(result.attachedPictureIndexes).toEqual([0]);
    expect(result.streams).toEqual([{ index: 1, kind: 'audio', codec: 'aac', duration: { num: 2, den: 1 }, sampleRate: 48000, channels: 2 }]);
  });
  it.each(['coverMp3', 'coverM4a'] as const)('検査は %s の表紙の番号を返す（既存登録との互換判定に使う。M-1: 多重化器が表紙を落とす回帰を防ぐ）', async (key) => {
    const probed = await probeCopy(samples[key]);
    expect(probed.attachedPictureIndexes).toEqual([1]);
    expect(probed.asset.streams.map((stream) => stream.kind)).toEqual(['audio']);
  });
});

describe('画像の検査結果（設計 M3c・M3d）', () => {
  it('表示寸法: PNG はそのまま、EXIF の向き 6 の JPEG は縦横を入れ替える', async () => {
    expect((await probeCopy(samples.landscapePng)).image).toEqual({ displaySize: { width: 640, height: 360 }, orientation: 1, frames: 1, animated: false });
    expect((await probeCopy(samples.exifRotatedJpg)).image).toEqual({ displaySize: { width: 360, height: 640 }, orientation: 6, frames: 1, animated: false });
  });
  it('動く GIF は animated、1コマの GIF は静止画', async () => {
    expect((await probeCopy(samples.animatedGif)).image).toMatchObject({ frames: 5, animated: true });
    expect((await probeCopy(samples.stillGif)).image).toMatchObject({ frames: 1, animated: false });
  });
  it('壊れていて読めない画像は「画像を読み取れません」で断る', async () => {
    await expect(probeCopy(samples.brokenPng)).rejects.toThrow('画像を読み取れません');
    const dir = await project();
    await writeFile(join(dir, 'moving.webp'), animatedWebpHeader());
    await expect(probeSequenceAsset(dir, 'moving.webp', 'moving.webp')).rejects.toThrow('画像を読み取れません');
  });
  it('本物の動く WebP（3コマ）は image.frames と animated を返す', async () => {
    // __fixtures__/animated.webp は PIL で作った 16x12・3コマの実物（188 バイト）。この機械の ffmpeg には
    // WebP エンコーダが無く実行時に試料を作れないため、動く WebP を判定する経路の試験に同梱している。
    const probed = await probeCopy(join(__dirname, '__fixtures__', 'animated.webp'));
    expect(probed.image).toMatchObject({ frames: 3, animated: true });
  });
  it('画像検査中に中止すると、「画像を読み取れません」ではなく中止のエラーをそのまま返す（M-2・画像の ffprobe 失敗を包む catch）', async () => {
    const dir = await project(), name = basename(samples.landscapePng);
    await copyFile(samples.landscapePng, join(dir, name));
    const controller = new AbortController();
    abortOnSpawn = () => controller.abort();
    try {
      await expect(probeSequenceAsset(dir, name, name, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    } finally { abortOnSpawn = undefined; }
  });
  it('画像の素材情報（台帳に入るもの）は従来どおり streams が空', async () => {
    const probed = await probeCopy(samples.landscapePng);
    expect(probed.asset).toMatchObject({ kind: 'image', streams: [] });
    expect(Object.keys(probed.asset).sort()).toEqual(['file', 'fingerprint', 'id', 'kind', 'name', 'streams']);
  });
});
