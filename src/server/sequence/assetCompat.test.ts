import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaStream, SequenceAsset } from '../../core/sequence/model';
import { importSequenceAsset, importSequenceAssetDetailed, onlyAttachedPicturesDiffer } from './assets';
import { reconnectSequenceReference, registerSequenceReference, registerSequenceReferenceDetailed } from './references';
import { makeMediaSamples, type MediaSamples } from './__fixtures__/mediaSamples';

let samples: MediaSamples;
const owned: string[] = [];
beforeAll(async () => { samples = makeMediaSamples(await mkdtemp(join(tmpdir(), 'asset-compat-samples-'))); }, 30_000);
afterAll(async () => { await rm(samples.dir, { recursive: true, force: true }); });
afterEach(async () => { for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true }); });
/** 参照の接続先は実パスで記録されるので、一時フォルダも実パス（macOS の /var → /private/var）で作る。 */
async function project(): Promise<string> { const dir = await mkdtemp(join(await realpath(tmpdir()), 'asset-compat-project-')); owned.push(dir); return dir; }

/** 表紙を除く前のコードが作っていた「表紙の映像ストリーム」を手で書く（設計 M4b の旧登録の試料）。 */
function legacyCoverStream(index: number, duration: MediaStream['duration']): MediaStream {
  return { index, kind: 'video', codec: 'mjpeg', duration, width: 64, height: 48, frameRate: { num: 90000, den: 1 }, rotation: 0,
    color: { primaries: 'unknown', transfer: 'unknown', matrix: 'bt470bg', range: 'full' } };
}
/** 同じ内容をコピーで登録済み（表紙の映像ストリームを含む旧形式の JSON）の案件を作る。 */
async function legacyCopy(): Promise<{ dir: string; legacy: SequenceAsset; json: string }> {
  const current = await importSequenceAsset(await project(), samples.coverMp3, 'cover.mp3');
  const dir = await project(), legacy: SequenceAsset = { ...current, streams: [...current.streams, legacyCoverStream(1, current.streams[0]!.duration)] };
  await mkdir(join(dir, '.harness/assets'), { recursive: true });
  await copyFile(samples.coverMp3, join(dir, legacy.file));
  const json = JSON.stringify({ format: 'harness-asset', version: 1, asset: legacy }) + '\n';
  await writeFile(join(dir, `${legacy.file}.json`), json);
  return { dir, legacy, json };
}
/** 同じ内容を参照で登録済み（表紙の映像ストリームを含む旧形式の台帳とリンク）の案件を作る。 */
async function legacyReference(): Promise<{ dir: string; legacy: SequenceAsset; record: string }> {
  const current = await registerSequenceReference(await project(), samples.coverMp3, 'cover.mp3');
  const dir = await project(), source = join(dir, '..', `${randomUUID()}-cover.mp3`);
  owned.push(source);
  await copyFile(samples.coverMp3, source);
  const legacy: SequenceAsset = { ...current, streams: [...current.streams, legacyCoverStream(1, current.streams[0]!.duration)] };
  await mkdir(join(dir, '.harness/references'), { recursive: true });
  await symlink(source, join(dir, legacy.file));
  const record = JSON.stringify({ format: 'harness-reference', version: 1, asset: legacy, target: source, generation: randomUUID(), sizeBytes: (await readFile(source)).length }) + '\n';
  await writeFile(join(dir, `${legacy.file}.json`), record);
  return { dir, legacy, record };
}

describe('既存の登録との互換（設計 M4b の4経路）', () => {
  it('新規: 表紙を除いた音声だけで登録し、画像の付帯情報は無い', async () => {
    const registered = await importSequenceAssetDetailed(await project(), samples.coverMp3, 'cover.mp3');
    expect(registered.asset.streams.map((stream) => stream.kind)).toEqual(['audio']);
    expect(registered.image).toBeUndefined();
  });
  it('コピーの再取り込み: 差が表紙だけなら旧登録をそのまま返し、台帳を書き換えない', async () => {
    const { dir, legacy, json } = await legacyCopy();
    expect((await importSequenceAssetDetailed(dir, samples.coverMp3, 'cover.mp3')).asset).toEqual(legacy);
    expect(await readFile(join(dir, `${legacy.file}.json`), 'utf8')).toBe(json);
  });
  it('コピーの再取り込み: 表紙以外の差（別の番号の映像・音声の違い）は従来どおり拒否する', async () => {
    const { dir, legacy } = await legacyCopy();
    const wrongIndex = { ...legacy, streams: [legacy.streams[0]!, legacyCoverStream(2, legacy.streams[0]!.duration)] };
    await writeFile(join(dir, `${legacy.file}.json`), JSON.stringify({ format: 'harness-asset', version: 1, asset: wrongIndex }) + '\n');
    await expect(importSequenceAsset(dir, samples.coverMp3)).rejects.toThrow('素材の登録情報が変更されています');
    const changedAudio = { ...legacy, streams: [{ ...legacy.streams[0]!, channels: 2 }, legacy.streams[1]!] };
    await writeFile(join(dir, `${legacy.file}.json`), JSON.stringify({ format: 'harness-asset', version: 1, asset: changedAudio }) + '\n');
    await expect(importSequenceAsset(dir, samples.coverMp3)).rejects.toThrow('素材の登録情報が変更されています');
  });
  it('判定の純関数: 表紙の番号にある映像だけが余分なときだけ真', () => {
    const audio: MediaStream = { index: 0, kind: 'audio', codec: 'mp3', duration: { num: 2, den: 1 }, sampleRate: 44100, channels: 1 };
    expect(onlyAttachedPicturesDiffer([audio, legacyCoverStream(1, audio.duration)], [audio], [1])).toBe(true);
    expect(onlyAttachedPicturesDiffer([audio, legacyCoverStream(1, audio.duration)], [audio], [])).toBe(false);
    expect(onlyAttachedPicturesDiffer([audio], [audio], [1])).toBe(false);
  });
  it('参照の再登録: 保存済みの情報（表紙の映像を含む）を返し、台帳を書き換えない', async () => {
    const { dir, legacy, record } = await legacyReference();
    expect((await registerSequenceReferenceDetailed(dir, samples.coverMp3, 'cover.mp3')).asset).toEqual(legacy);
    expect(await readFile(join(dir, `${legacy.file}.json`), 'utf8')).toBe(record);
  });
  it('再接続（relink）: 保存済みの streams のまま、接続先だけ変わる', async () => {
    const { dir, legacy } = await legacyReference();
    const moved = join(dir, '..', `${randomUUID()}-moved.mp3`);
    owned.push(moved);
    await copyFile(samples.coverMp3, moved);
    expect(await reconnectSequenceReference(dir, legacy, moved)).toEqual(legacy);
    expect(await readlink(join(dir, legacy.file))).toBe(moved);
    expect(JSON.parse(await readFile(join(dir, `${legacy.file}.json`), 'utf8')).asset).toEqual(legacy);
  });
});
