import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageUploadPrefix } from '../../shared/imageUploadFrame';
import { parseImageUploadManifest, receiveImageUploads } from './imageUpload';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function staging(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'image-upload-')); dirs.push(dir); return dir; }
/** 本文を size バイトずつに区切って流す（一覧と中身の境目がどこで切れても読めることを確かめる）。 */
async function* chunks(body: Buffer, size: number): AsyncGenerator<Buffer> { for (let at = 0; at < body.length; at += size) yield body.subarray(at, at + size); }
const files = [{ name: '1-表紙.png', bytes: Buffer.from('first-image') }, { name: '2.JPG', bytes: Buffer.from('second') }, { name: '3.png', bytes: Buffer.from('third!!') }];
const body = (list = files, extra = Buffer.alloc(0)) => Buffer.concat([Buffer.from(imageUploadPrefix(list.map((file) => ({ name: file.name, size: file.bytes.length })))), ...list.map((file) => file.bytes), extra]);

describe('複数画像の本文の受信（設計 M3b）', () => {
  it.each([1, 3, 7, 4096])('区切り %i バイトでも、一覧の順に 000.png, 001.jpg … へ書き出す', async (size) => {
    const dir = await staging(), received = await receiveImageUploads(chunks(body(), size), dir);
    expect(received.map((item) => [item.name, item.path.slice(dir.length + 1), item.size])).toEqual([['1-表紙.png', '000.png', 11], ['2.JPG', '001.jpg', 6], ['3.png', '002.png', 7]]);
    for (const [index, item] of received.entries()) expect(await readFile(item.path)).toEqual(files[index]!.bytes);
  });
  it('一覧より短い本文（途中で切断）は 400。書きかけのファイルは呼び出し側が消せる場所にだけ残る', async () => {
    const dir = await staging(), full = body();
    await expect(receiveImageUploads(chunks(full.subarray(0, full.length - 3), 5), dir)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('途中で終わりました') });
    expect((await readdir(dir)).sort()).toEqual(['000.png', '001.jpg', '002.png']);
  });
  it('一覧より長い本文は 400', async () => {
    await expect(receiveImageUploads(chunks(body(files, Buffer.from('x')), 8), await staging())).rejects.toMatchObject({ status: 400, message: expect.stringContaining('多いデータ') });
  });
  it('一覧の長さが不正なら、中身を書き出す前に 400', async () => {
    const dir = await staging(), bad = Buffer.alloc(8); bad.writeUInt32BE(10 * 1024 * 1024, 0);
    await expect(receiveImageUploads(chunks(bad, 8), dir)).rejects.toMatchObject({ status: 400 });
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('一覧の検査（設計 M1・M3b）', () => {
  const manifest = (list: Array<{ name: string; size: number }>) => JSON.stringify({ version: 1, files: list });
  it('画像だけ・1〜200 枚・合計 2GB まで', () => {
    expect(parseImageUploadManifest(manifest([{ name: 'a.png', size: 1 }])).files).toHaveLength(1);
    expect(() => parseImageUploadManifest(manifest(Array.from({ length: 201 }, (_, i) => ({ name: `${i}.png`, size: 1 }))))).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseImageUploadManifest(manifest([{ name: 'a.png', size: 1024 ** 3 }, { name: 'b.png', size: 1024 ** 3 + 1 }]))).toThrow(expect.objectContaining({ status: 413 }));
    expect(() => parseImageUploadManifest(manifest([{ name: 'a.png', size: 1 }, { name: 'talk.mp3', size: 1 }]))).toThrow('どれか1種類');
    expect(() => parseImageUploadManifest(manifest([{ name: '../a.png', size: 1 }]))).toThrow('画像の一覧が不正です');
    expect(() => parseImageUploadManifest(manifest([{ name: 'a.png', size: 0 }]))).toThrow('画像の一覧が不正です');
    expect(() => parseImageUploadManifest('{')).toThrow('画像の一覧が不正です');
  });
});
