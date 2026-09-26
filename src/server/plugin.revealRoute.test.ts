// src/server/plugin.revealRoute.test.ts
/**
 * POST /api/project/reveal（保存先フォルダを Finder 等で開く）のルートテスト。
 * パスは**サーバ側で id から導出**する（クライアントから生パスを受け取らない）ため、
 * 封じ込め検査とフォルダ実在の扱いをここで固定する。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './plugin';
import { HttpError } from './http';
import { openFolder } from './openMaterialFolder';

vi.mock('./openMaterialFolder', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./openMaterialFolder')>();
  return { ...mod, openFolder: vi.fn() };
});

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sme-reveal-'));
  cpSync(SAMPLE, join(root, 'proj'), { recursive: true });
  vi.mocked(openFolder).mockClear();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function call(method: string, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`http://localhost${path}`);
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    end(text?: string) {
      body = text === undefined || text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
    },
  } as unknown as ServerResponse;
  const req = {
    method,
    headers: {},
    url: path,
    async *[Symbol.asyncIterator]() {
      /* 本文なし */
    },
  } as unknown as IncomingMessage;
  try {
    await handleApi(req, res, url, root);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
  return { status, body };
}

describe('POST /api/project/reveal', () => {
  it('POST 以外は 405', async () => {
    const r = await call('GET', '/api/project/reveal?id=proj');
    expect(r.status).toBe(405);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('.. を含む id は 400（ルート外を開かせない）', async () => {
    const r = await call('POST', '/api/project/reveal?id=../..');
    expect(r.status).toBe(400);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('存在しないプロジェクトは 404', async () => {
    const r = await call('POST', '/api/project/reveal?id=missing');
    expect(r.status).toBe(404);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('ルート配下でもプロジェクト以外の階層は 400（open にファイルを渡さない）', async () => {
    // open はディレクトリなら Finder で開くが、ファイルなら「起動」になる。
    // 一覧に出るプロジェクトのフォルダ以外は絶対に渡さない。
    const r = await call('POST', '/api/project/reveal?id=proj/public');
    expect(r.status).toBe(400);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('ルート直下でもハーネス形式の案件でなければ 400', async () => {
    mkdirSync(join(root, 'workdir'), { recursive: true });
    writeFileSync(join(root, 'workdir', 'memo.txt'), 'x');
    const r = await call('POST', '/api/project/reveal?id=workdir');
    expect(r.status).toBe(400);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('ルート直下の .app バンドルは 400（open に渡すと「起動」になる）', async () => {
    // .app は macOS では中身がディレクトリなので isDirectory 検査を素通りする。
    // 一覧に出るプロジェクトだけを開く不変条件で弾き切れることを固定する。
    mkdirSync(join(root, 'Evil.app', 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(root, 'Evil.app', 'Contents', 'MacOS', 'run'), '#!/bin/sh\n');
    const r = await call('POST', '/api/project/reveal?id=Evil.app');
    expect(r.status).toBe(400);
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('正常時は 200 で、id から解決した絶対パスを開く', async () => {
    const r = await call('POST', '/api/project/reveal?id=proj');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    const dir = vi.mocked(openFolder).mock.calls[0]?.[0];
    expect(dir?.endsWith(`${'/'}proj`)).toBe(true);
  });
});
