import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readBodyText, readJsonBody } from './readBody';
import { HttpError } from './http';

const req = (chunks: string[]): IncomingMessage =>
  Readable.from(chunks.map((c) => Buffer.from(c))) as unknown as IncomingMessage;

describe('readBodyText', () => {
  it('チャンクを結合して返す', async () => {
    expect(await readBodyText(req(['ab', 'cd']), 100)).toBe('abcd');
  });

  it('上限超過で 413（受信途中で中断）', async () => {
    await expect(readBodyText(req(['abcde', 'fghij']), 8)).rejects.toMatchObject({ status: 413 });
  });

  it('上限ちょうどは通す', async () => {
    expect(await readBodyText(req(['abcd', 'efgh']), 8)).toBe('abcdefgh');
  });
});

describe('readJsonBody', () => {
  it('JSON をパースして返す', async () => {
    expect(await readJsonBody(req(['{"a":1}']))).toEqual({ a: 1 });
  });
  it('空ボディは 400', async () => {
    await expect(readJsonBody(req([]))).rejects.toThrow(HttpError);
  });
  it('非 JSON は 400', async () => {
    await expect(readJsonBody(req(['not json']))).rejects.toThrow(HttpError);
  });
  it('maxBytes 超過は 413', async () => {
    await expect(readJsonBody(req(['{"x":"' + 'a'.repeat(50) + '"}']), 16)).rejects.toMatchObject({ status: 413 });
  });
});
