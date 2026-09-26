import { expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { handleApi } from './plugin';

const root = join(import.meta.dirname, '__fixtures__');
async function call(path: string) {
  const captured = { status: 0, body: '', headers: {} as Record<string, string> };
  const req = { method: 'GET', headers: {}, url: path } as IncomingMessage;
  const res = {
    writeHead(status: number, headers: Record<string, string>) { captured.status = status; captured.headers = headers; return this; },
    end(body: string) { captured.body = body; },
  } as unknown as ServerResponse;
  try { await handleApi(req, res, new URL(path, 'http://localhost'), root); }
  catch (error) { captured.status = (error as { status?: number }).status ?? 500; captured.body = (error as Error).message; }
  return captured;
}

it('serves the native component from the real project through the audited frame API', async () => {
  const result = await call('/api/native-telop-component?id=sample-project');
  expect(result.status).toBe(200);
  expect(result.headers['Content-Type']).toMatch(/javascript/);
  expect(result.body).toContain('@harness/frame-runtime');
  expect(result.body).toContain('#FFE57A');
  expect(result.body).not.toMatch(/from\s*["']remotion["']/);
});

it.each(['telop-component', 'insert-image-component', 'insert-video-component'])('retires /api/%s with the normal unknown-API 404', async endpoint => {
  const result = await call(`/api/${endpoint}?id=sample-project`);
  expect(result.status).toBe(404);
  expect(result.body).toContain(`API が見つかりません: /api/${endpoint}`);
});

it.each(['telop', 'image'])('serves capture %s with the shared frame API and runtime-bound staticFile', async kind => {
  const result = await call(`/api/capture-component?id=sample-project&kind=${kind}`);
  expect(result.status).toBe(200);
  expect(result.body).toContain('@harness/frame-runtime');
  expect(result.body).not.toMatch(/from\s*["']remotion["']/);
  expect(result.body).not.toContain('/api/asset?');
});

it('rejects arbitrary capture component kinds', async () => {
  expect((await call('/api/capture-component?id=sample-project&kind=../../secret')).status).toBe(400);
});

it('keeps native and React browser imports without a real Remotion mapping', async () => {
  const html = await readFile(join(import.meta.dirname, '../../index.html'), 'utf8');
  const map = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)![1]!).imports;
  expect(map['@harness/frame-runtime']).toBe('/src/captureRuntime/index.ts');
  expect(map.react).toBe('/src/preview/runtime/react.ts');
  expect(map.remotion).toBeUndefined();
});
