import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ViteDevServer } from 'vite';
import { smeServer } from './plugin';

let root: string, server: ViteDevServer, base: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-capture-http-'));
  await mkdir(join(root, 'project/src/テロップテンプレート'), { recursive: true });
  await mkdir(join(root, 'project/src/InsertImage'), { recursive: true });
  await writeFile(join(root, 'project/src/テロップテンプレート/Telop.tsx'), "import {Audio} from '@remotion/media'; export const Telop = () => <Audio />;");
  await writeFile(join(root, 'project/src/InsertImage/InsertImage.tsx'), 'export const InsertImage = () => <broken syntax;');
  vi.stubEnv('HARNESS_PROJECT_ROOT', root);
  vi.stubEnv('HARNESS_LEARNING_HOME', join(root, 'learning'));
  server = await createServer({ configFile: false, plugins: [smeServer()], logLevel: 'silent', server: { host: '127.0.0.1', port: 0, open: false } });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('test HTTP address missing');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });

it.each([{ kind: 'telop', label: '字幕', detail: '@remotion/media' }, { kind: 'image', label: '画像', detail: 'InsertImage.tsx' }])('returns actual HTTP JSON with capture context for $kind compile failures', async ({ kind, label, detail }) => {
  const response = await fetch(`${base}/api/capture-component?id=project&kind=${kind}`);
  expect(response.status).toBe(500);
  expect(response.headers.get('content-type')).toMatch(/application\/json/);
  const body = await response.json();
  expect(body.error).toContain(`撮影用の${label}部品を準備できませんでした`);
  expect(body.error).toContain(detail);
  expect(body.error).not.toMatch(/移行/);
  console.log('capture HTTP failure contract', { status: response.status, kind, body });
});
