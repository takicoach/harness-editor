/**
 * GET /api/config の版の情報（edition / appVersion / osVersion）。
 * 公開版には有料の目印のファイルが無いので edition は常に free。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleApi } from './plugin';

let root: string;
const saved = { version: process.env['HARNESS_APP_VERSION'] };

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'sme-config-')); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (saved.version === undefined) delete process.env['HARNESS_APP_VERSION'];
  else process.env['HARNESS_APP_VERSION'] = saved.version;
});

async function getConfig(): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  const res = {
    writeHead() { return this; },
    end(text?: string) { body = text ? (JSON.parse(text) as Record<string, unknown>) : {}; },
  } as unknown as ServerResponse;
  const req = { method: 'GET', headers: {}, url: '/api/config', async *[Symbol.asyncIterator]() { /* 本文なし */ } } as unknown as IncomingMessage;
  await handleApi(req, res, new URL('http://localhost/api/config'), root);
  return body;
}

describe('GET /api/config の版の情報', () => {
  it('公開版では edition が free', async () => {
    expect((await getConfig())['edition']).toBe('free');
  });
  it('配布アプリの版をランタイム用 package.json より優先する', async () => {
    process.env['HARNESS_APP_VERSION'] = '0.8.42';
    expect((await getConfig())['appVersion']).toBe('0.8.42');
  });
  it('環境変数が無ければ package.json の版、OS の版も返す', async () => {
    delete process.env['HARNESS_APP_VERSION'];
    const body = await getConfig();
    expect(body['appVersion']).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof body['osVersion']).toBe('string');
  });
});
