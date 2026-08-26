// src/server/plugin.convertLinkRoute.test.ts
/**
 * POST /api/project/link-candidate・/api/project/convert-to-link のルートテスト。
 * 破壊的な置換なので、入口の不変条件（POST のみ・プロジェクト実体・実行中ジョブ）と
 * 「候補パスをクライアントから受け取らない」ことをここで固定する。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './plugin';
import { HttpError } from './http';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'sample-project');

let base: string;
let root: string;
let ssd: string;
let prevRoots: string | undefined;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'sme-convert-route-')));
  root = join(base, 'projects');
  ssd = join(base, 'ssd');
  mkdirSync(root, { recursive: true });
  mkdirSync(ssd, { recursive: true });
  cpSync(SAMPLE, join(root, 'proj'), { recursive: true });
  prevRoots = process.env.SME_BROWSE_ROOTS;
  process.env.SME_BROWSE_ROOTS = ssd;
});
afterEach(() => {
  if (prevRoots === undefined) delete process.env.SME_BROWSE_ROOTS;
  else process.env.SME_BROWSE_ROOTS = prevRoots;
  rmSync(base, { recursive: true, force: true });
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

/** 外付け側にプロジェクトのコピーと同一バイトの実体を置く。 */
function placeExternalCopy(): string {
  const target = join(ssd, 'take1.mp4');
  cpSync(join(root, 'proj', 'public', 'main.mp4'), target);
  return target;
}

/** 回収されるはずのバイト数＝置換前のコピー実体のサイズ（フィクスチャ文言に依存させない）。 */
function copyBytes(): number {
  return statSync(join(root, 'proj', 'public', 'main.mp4')).size;
}

describe('リンク化ルート', () => {
  it('POST 以外は 405', async () => {
    expect((await call('GET', '/api/project/link-candidate?id=proj')).status).toBe(405);
    expect((await call('GET', '/api/project/convert-to-link?id=proj')).status).toBe(405);
  });

  it('ルート外の id は 400', async () => {
    expect((await call('POST', '/api/project/convert-to-link?id=../..')).status).toBe(400);
  });

  it('プロジェクトでないディレクトリは 404', async () => {
    mkdirSync(join(root, 'not-a-project'), { recursive: true });
    writeFileSync(join(root, 'not-a-project', 'memo.txt'), 'x');
    expect((await call('POST', '/api/project/convert-to-link?id=not-a-project')).status).toBe(404);
  });

  it('候補が無ければ candidate は matched:false・convert は 409', async () => {
    const candidate = await call('POST', '/api/project/link-candidate?id=proj');
    expect(candidate.status).toBe(200);
    expect(candidate.body['matched']).toBe(false);
    const convert = await call('POST', '/api/project/convert-to-link?id=proj');
    expect(convert.status).toBe(409);
    expect(lstatSync(join(root, 'proj', 'public', 'main.mp4')).isSymbolicLink()).toBe(false);
  });

  it('候補があれば candidate が接続先を返し、convert がリンクへ置き換える', async () => {
    const target = placeExternalCopy();
    const expectedFreed = copyBytes();
    const candidate = await call('POST', '/api/project/link-candidate?id=proj');
    expect(candidate.body).toMatchObject({ matched: true, target });

    const convert = await call('POST', '/api/project/convert-to-link?id=proj');
    expect(convert.status).toBe(200);
    expect(convert.body['target']).toBe(target);
    expect(convert.body['freedBytes']).toBe(expectedFreed);
    expect(expectedFreed).toBeGreaterThan(0);
    // 一覧も返す（クライアントがカードを取り直さずに済む）。
    expect(Array.isArray(convert.body['projects'])).toBe(true);
    expect(lstatSync(join(root, 'proj', 'public', 'main.mp4')).isSymbolicLink()).toBe(true);
  });

  it('クライアントが path を送っても無視する（接続先はサーバの探索結果のみ）', async () => {
    const evil = join(base, 'evil.mp4');
    writeFileSync(evil, 'not-the-video');
    const r = await call(
      'POST',
      `/api/project/convert-to-link?id=proj&path=${encodeURIComponent(evil)}`,
    );
    // 起点配下に同一実体が無いので 409。送りつけた path は使われない。
    expect(r.status).toBe(409);
    expect(lstatSync(join(root, 'proj', 'public', 'main.mp4')).isSymbolicLink()).toBe(false);
  });
});
