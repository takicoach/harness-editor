import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { HttpError } from './http';
import type { IncomingMessage } from 'node:http';
import {
  moveIntoPlace,
  streamBodyToTempFile,
  resolveMaxUploadBytes,
  assertContentLengthWithin,
  DEFAULT_MAX_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES_CEILING,
} from './streamUpload';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sme-stream-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('streamBodyToTempFile', () => {
  it('分割チャンクを欠けなく一時ファイルへ書き込む', async () => {
    const body = Readable.from([Buffer.from('abc'), Buffer.from('def'), Buffer.from('g')]);
    const tmpDir = join(root, 'tmp');
    const path = await streamBodyToTempFile(body, tmpDir);
    expect(readFileSync(path, 'utf8')).toBe('abcdefg');
  });

  it('空ボディは 400 で一時ファイルを残さない', async () => {
    const tmpDir = join(root, 'tmp');
    await expect(streamBodyToTempFile(Readable.from([]), tmpDir)).rejects.toThrow(HttpError);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('受信エラー時は 400 で一時ファイルを削除する', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('切断'));
      },
    });
    const tmpDir = join(root, 'tmp');
    await expect(streamBodyToTempFile(body, tmpDir)).rejects.toThrow(/受信に失敗/);
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('maxBytes を超えたら 413 で中断し一時ファイルを残さない', async () => {
    const body = Readable.from([Buffer.from('abcde'), Buffer.from('fghij')]); // 10バイト
    const tmpDir = join(root, 'tmp');
    await expect(streamBodyToTempFile(body, tmpDir, 8)).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(tmpDir)).toEqual([]);
  });

  it('上限ちょうどは通す（境界）', async () => {
    const body = Readable.from([Buffer.from('abcd'), Buffer.from('efgh')]); // 8バイト
    const tmpDir = join(root, 'tmp');
    const path = await streamBodyToTempFile(body, tmpDir, 8);
    expect(readFileSync(path, 'utf8')).toBe('abcdefgh');
  });
});

describe('resolveMaxUploadBytes', () => {
  const orig = process.env.SME_MAX_UPLOAD_BYTES;
  afterEach(() => {
    if (orig === undefined) delete process.env.SME_MAX_UPLOAD_BYTES;
    else process.env.SME_MAX_UPLOAD_BYTES = orig;
  });

  it('未設定なら既定（32GiB）', () => {
    delete process.env.SME_MAX_UPLOAD_BYTES;
    expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });
  it('正の整数の環境変数を採用する', () => {
    process.env.SME_MAX_UPLOAD_BYTES = '1048576';
    expect(resolveMaxUploadBytes()).toBe(1048576);
  });
  it('不正値（0・負・非数）は既定にフォールバック', () => {
    for (const v of ['0', '-5', 'abc', '']) {
      process.env.SME_MAX_UPLOAD_BYTES = v;
      expect(resolveMaxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    }
  });
  it('極大値は上限（1TiB）へクランプする', () => {
    process.env.SME_MAX_UPLOAD_BYTES = '1000000000000000000000'; // 1e21
    expect(resolveMaxUploadBytes()).toBe(MAX_UPLOAD_BYTES_CEILING);
  });
});

describe('assertContentLengthWithin', () => {
  const reqWith = (cl: string | undefined): IncomingMessage =>
    ({ headers: cl === undefined ? {} : { 'content-length': cl } }) as IncomingMessage;

  it('Content-Length が上限超なら 413', () => {
    expect(() => assertContentLengthWithin(reqWith('100'), 50)).toThrow(HttpError);
  });
  it('上限以内・ヘッダ無し・不正値は素通し（実バイトは streaming で enforce）', () => {
    expect(() => assertContentLengthWithin(reqWith('40'), 50)).not.toThrow();
    expect(() => assertContentLengthWithin(reqWith(undefined), 50)).not.toThrow();
    expect(() => assertContentLengthWithin(reqWith('bogus'), 50)).not.toThrow();
  });
});

describe('moveIntoPlace', () => {
  it('rename でファイルを移動する', () => {
    const src = join(root, 'a.tmp');
    writeFileSync(src, 'data');
    const dest = join(root, 'b.mp4');
    moveIntoPlace(src, dest);
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dest, 'utf8')).toBe('data');
  });
});
