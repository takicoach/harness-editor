/**
 * /api/telop-add の HTTP レベル統合テスト（重要指摘2: 実ルートの前例が無かったので追加）。
 *
 * requireParam・body.dir の型ガード・assertBrowsablePath（起点封じ込め）を、
 * plugin.nativeDataInstallers.test.ts と同じ実サーバ（vite dev server）流儀で通す。
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ViteDevServer } from 'vite';
import { smeServer } from './plugin';

let root: string, browseRoot: string, server: ViteDevServer, base: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'telop-add-route-'));
  browseRoot = await mkdtemp(join(tmpdir(), 'telop-add-source-'));
  await mkdir(join(root, 'project', 'src', 'テロップテンプレート'), { recursive: true });

  // 取り込み可能なパック（manifest.ts + styles/ + Telop.tsx）。
  const pack = join(browseRoot, 'my-pack');
  await mkdir(join(pack, 'styles'), { recursive: true });
  await writeFile(join(pack, 'manifest.ts'), `export const TELOP_PACK=[{id:501,name:'テスト用'}];`);
  await writeFile(join(pack, 'styles', 'style1.tsx'), 'export default null;');
  await writeFile(join(pack, 'Telop.tsx'), `export function Telop(){return null;}`);

  vi.stubEnv('HARNESS_PROJECT_ROOT', root);
  vi.stubEnv('HARNESS_LEARNING_HOME', join(root, 'learning'));
  vi.stubEnv('SME_BROWSE_ROOTS', browseRoot);
  server = await createServer({ configFile: false, plugins: [smeServer()], logLevel: 'silent', server: { host: '127.0.0.1', port: 0, open: false } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('HTTP address missing');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server?.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  if (browseRoot) await rm(browseRoot, { recursive: true, force: true });
});

it('GET は 405', async () => {
  const response = await fetch(`${base}/api/telop-add?id=project`);
  expect(response.status).toBe(405);
});

it('dir が無いと 400', async () => {
  const response = await fetch(`${base}/api/telop-add?id=project`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  expect(response.status).toBe(400);
});

it('dir が文字列でないと 400', async () => {
  const response = await fetch(`${base}/api/telop-add?id=project`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: 123 }),
  });
  expect(response.status).toBe(400);
});

it('許可されていない場所（起点の外）は 4xx（assertBrowsablePath の既存エラー）', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'telop-add-outside-'));
  try {
    const response = await fetch(`${base}/api/telop-add?id=project`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: outside }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

// I-1: 下見は書き込みを一切しない段。UI はこの結果で確認画面を出す。
it('下見ルートは番号と衝突を返し、案件へ何も書かない', async () => {
  const before = (await readdir(join(root, 'project'))).sort();
  const response = await fetch(`${base}/api/telop-add/inspect?id=project`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: join(browseRoot, 'my-pack') }),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({ packId: 'my-pack', kind: 'pack', ids: [501], names: ['テスト用'], conflicts: [] });
  expect(body.asset).toBeUndefined();
  expect((await readdir(join(root, 'project'))).sort()).toEqual(before);
});

it('下見ルートも GET は 405・dir 欠落は 400', async () => {
  expect((await fetch(`${base}/api/telop-add/inspect?id=project`)).status).toBe(405);
  const response = await fetch(`${base}/api/telop-add/inspect?id=project`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  expect(response.status).toBe(400);
});

it('正常系: 200 と {packId, version, kind, added, conflicts} を返す', async () => {
  const response = await fetch(`${base}/api/telop-add?id=project`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: join(browseRoot, 'my-pack') }),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({ packId: 'my-pack', version: expect.any(String), kind: 'pack', added: [501], conflicts: [] });
  expect(body.asset).toBeDefined();
});
