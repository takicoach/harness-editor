/**
 * 撮影ページ route（GET /capture・/capture/runtime.js・/capture/entry.js）のルートテスト。
 *
 * プレビュー本体（index.html）に触れずに撮影用の面を配信することが眼目なので、
 * 「importmap の 'remotion' が captureRuntime バンドル route を指す」ことをここで固定する。
 */
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleCaptureRoute, isCaptureRoute } from './plugin';

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function call(method: string, path: string): Promise<Captured> {
  const url = new URL(`http://localhost${path}`);
  const captured: Captured = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      captured.headers = headers ?? {};
      return this;
    },
    end(text?: string) {
      captured.body = text ?? '';
    },
  } as unknown as ServerResponse;
  const req = { method, headers: {}, url: path } as unknown as IncomingMessage;
  await handleCaptureRoute(req, res, url);
  return captured;
}

describe('isCaptureRoute', () => {
  it('撮影ページの3 route だけを引き受ける', () => {
    expect(isCaptureRoute('/capture')).toBe(true);
    expect(isCaptureRoute('/capture/runtime.js')).toBe(true);
    expect(isCaptureRoute('/capture/entry.js')).toBe(true);
    expect(isCaptureRoute('/captured')).toBe(false);
    expect(isCaptureRoute('/capture/other.js')).toBe(false);
    expect(isCaptureRoute('/')).toBe(false);
    expect(isCaptureRoute('/api/asset')).toBe(false);
  });
});

describe('GET /capture', () => {
  it('HTML を返し、importmap の remotion が captureRuntime バンドルを指す', async () => {
    const r = await call('GET', '/capture');
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toMatch(/text\/html/);
    const imports = JSON.parse(
      /<script type="importmap">([\s\S]*?)<\/script>/.exec(r.body)?.[1] ?? '{}',
    ) as { imports: Record<string, string> };
    expect(imports.imports['remotion']).toBe('/capture/runtime.js');
    expect(imports.imports['@harness/frame-runtime']).toBe('/capture/runtime.js');
    expect(imports.imports['react']).toBeDefined();
    expect(r.body).toContain('src="/capture/entry.js"');
  });

  it('背景を塗らない（omitBackground 撮影の前提）', async () => {
    const r = await call('GET', '/capture');
    expect(r.body).toContain('background: transparent');
    expect(r.body).not.toMatch(/background:\s*(#|rgb|white|black)/i);
  });

  it('GET 以外は 405', async () => {
    await expect(call('POST', '/capture')).rejects.toMatchObject({ status: 405 });
  });
});

describe('GET /capture/runtime.js', () => {
  it('captureRuntime バンドルを JavaScript として返す', async () => {
    const r = await call('GET', '/capture/runtime.js');
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toMatch(/javascript/);
    expect(r.body).toContain('useCurrentFrame');
    expect(r.body).not.toMatch(/from\s*["']remotion["']/);
  });
});

describe('GET /capture/entry.js', () => {
  it('撮影ページのエントリを JavaScript として返す', async () => {
    const r = await call('GET', '/capture/entry.js');
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toMatch(/javascript/);
    expect(r.body).toContain('__capture');
  });
});
