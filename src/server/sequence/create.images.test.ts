import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSequenceImageProject } from './create';
import { importSequenceAssetDetailed } from './assets';
import { SequenceStore } from './store';
import { MIXED_MEDIA_MESSAGE } from '../../shared/createMedia';
import { makeMediaSamples, type MediaSamples } from './__fixtures__/mediaSamples';

vi.mock('./assets', async (load) => {
  const actual = await load<typeof import('./assets')>();
  return { ...actual, importSequenceAssetDetailed: vi.fn(actual.importSequenceAssetDetailed) };
});

let samples: MediaSamples, root: string;
beforeAll(async () => { samples = makeMediaSamples(await mkdtemp(join(tmpdir(), 'create-images-samples-'))); }, 30_000);
afterAll(async () => { await rm(samples.dir, { recursive: true, force: true }); });
afterEach(async () => { vi.mocked(importSequenceAssetDetailed).mockClear(); if (root) await rm(root, { recursive: true, force: true }); });
async function freshRoot(): Promise<string> { root = await mkdtemp(join(await realpath(tmpdir()), 'create-images-root-')); return root; }
const image = (name: string, sourcePath: string) => ({ name, sourcePath });

describe('複数の画像を1回で確定する（設計 M3・M3b）', () => {
  it('選んだ順に 5 秒ずつ並べ、同じ内容は素材1件・クリップは枚数分。解像度は最初の画像で決める', async () => {
    await freshRoot();
    const { id } = await createSequenceImageProject(root, { name: 'アルバム', images: [
      image('1-縦.png', samples.portraitPng), image('2-赤.png', samples.red), image('3-縦の再掲.png', samples.portraitPng)] });
    const doc = new SequenceStore(join(root, id)).load()!.document;
    expect(doc).toMatchObject({ fps: { num: 30, den: 1 }, resolution: { width: 1080, height: 1920 }, sequenceEndFrame: 450 });
    expect(doc.assets).toHaveLength(2);
    expect(doc.clips.map((clip) => [clip.name, clip.startFrame, clip.durationFrames])).toEqual([['1-縦.png', 0, 150], ['2-赤.png', 150, 150], ['3-縦の再掲.png', 300, 150]]);
    expect(doc.clips[0]!.content).toEqual(doc.clips[2]!.content);
    // 画像はいつもコピー（設計 M3e）。管理フォルダに素材2件とその台帳だけ。
    expect((await readdir(join(root, id, '.harness/assets'))).filter((name) => !name.endsWith('.json'))).toHaveLength(2);
    expect(await readFile(join(root, id, doc.assets[0]!.file))).toEqual(await readFile(samples.portraitPng));
  });

  it('途中の1枚が読めなければ全体を断り、この要求が作ったフォルダを残さない', async () => {
    await freshRoot();
    await expect(createSequenceImageProject(root, { name: 'broken', images: [image('a.png', samples.red), image('b.png', samples.brokenPng), image('c.png', samples.blue)] }))
      .rejects.toMatchObject({ status: 422, message: expect.stringContaining('「b.png」を画像として読み取れません') });
    expect(await readdir(root)).toEqual([]);
  });

  it('動く GIF が混ざっていれば、その名前を示して断る', async () => {
    await freshRoot();
    await expect(createSequenceImageProject(root, { name: 'moving', images: [image('a.png', samples.red), image('動く.gif', samples.animatedGif)] }))
      .rejects.toMatchObject({ status: 422, message: '「動く.gif」は動く画像です。動く画像にはまだ対応していません' });
    expect(await readdir(root)).toEqual([]);
  });

  it('途中で中止したら確定せず、自分のフォルダだけを片付ける（既存の案件は触らない）', async () => {
    await freshRoot();
    const existing = await createSequenceImageProject(root, { name: 'existing', images: [image('a.png', samples.red), image('b.png', samples.green)] });
    const before = await readFile(join(root, existing.id, '.harness/project.v2.json'));
    const controller = new AbortController(), actual = vi.mocked(importSequenceAssetDetailed).getMockImplementation()!;
    vi.mocked(importSequenceAssetDetailed).mockImplementationOnce(async (...args) => { const result = await actual(...args); controller.abort(); return result; });
    await expect(createSequenceImageProject(root, { name: 'cancelled', images: [image('a.png', samples.red), image('b.png', samples.green)] }, controller.signal)).rejects.toThrow();
    expect(await readdir(root)).toEqual(['existing']);
    expect(await readFile(join(root, existing.id, '.harness/project.v2.json'))).toEqual(before);
  });
});

describe('上限と種類（設計 M1・M3b）', () => {
  it('201 枚は取り込む前に 400', async () => {
    await freshRoot();
    const images = Array.from({ length: 201 }, (_, index) => image(`${index}.png`, samples.red));
    await expect(createSequenceImageProject(root, { name: 'many', images })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('200枚まで') });
    expect(importSequenceAssetDetailed).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
  it('合計 2GB を超えたら取り込む前に 413（中身を持たない疎なファイルで大きさだけ作る）', async () => {
    await freshRoot();
    const big = [join(root, '..', `${Date.now()}-big-a.png`), join(root, '..', `${Date.now()}-big-b.png`)];
    for (const path of big) { await writeFile(path, ''); await truncate(path, 1100 * 1024 * 1024); }
    try {
      await expect(createSequenceImageProject(root, { name: 'huge', images: big.map((path, index) => image(`${index}.png`, path)) }))
        .rejects.toMatchObject({ status: 413, message: expect.stringContaining('合計2GB') });
      expect(importSequenceAssetDetailed).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    } finally { for (const path of big) await rm(path, { force: true }); }
  });
  it('画像以外・混在は 400（取り込まない）', async () => {
    await freshRoot();
    await expect(createSequenceImageProject(root, { name: 'mixed', images: [image('a.png', samples.red), image('talk.mp3', samples.mp3)] }))
      .rejects.toMatchObject({ status: 400, message: MIXED_MEDIA_MESSAGE });
    await expect(createSequenceImageProject(root, { name: 'audio', images: [image('a.mp3', samples.mp3), image('b.mp3', samples.mp3)] }))
      .rejects.toMatchObject({ status: 400, message: expect.stringContaining('作れるのは画像だけ') });
    expect(importSequenceAssetDetailed).not.toHaveBeenCalled();
  });
});
