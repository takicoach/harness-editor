// src/server/captureEngineApi.test.ts
/**
 * GET /api/capture-engine/status（M2d T2）。
 * resolveChromiumBin() の存在検査結果をそのまま返す（起動はしない）。
 * ルート側の GET 以外 405 も併せて固定する。
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCaptureEngineStatus } from './captureEngineApi';
import { handleApi } from './plugin';
import { HttpError } from './http';
import type { ResolveChromiumResult } from './resolveChromium';

describe('handleCaptureEngineStatus', () => {
  it('resolveChromium が ok を返せば { ok: true, source } を返す（bin は返さない・M-2）', () => {
    const ok: ResolveChromiumResult = { ok: true, bin: '/fake/chrome-headless-shell', source: 'tools' };
    const result = handleCaptureEngineStatus({ resolveChromium: () => ok });
    expect(result).toEqual({ ok: true, source: 'tools' });
  });

  it('resolveChromium が不在を返せば { ok: false, kind, message } をそのまま返す', () => {
    const missing: ResolveChromiumResult = {
      ok: false,
      kind: 'chromium-missing',
      message: '撮影エンジン（chrome-headless-shell）が見つかりません',
    };
    const result = handleCaptureEngineStatus({ resolveChromium: () => missing });
    expect(result).toEqual(missing);
  });
});

async function call(method: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const root = mkdtempSync(join(tmpdir(), 'sme-capture-engine-'));
    try {
      const url = new URL('http://localhost/api/capture-engine/status');
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
        url: '/api/capture-engine/status',
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
}

describe('GET /api/capture-engine/status（ルート）', () => {
  it('GET 以外は 405', async () => {
    const r = await call('POST');
    expect(r.status).toBe(405);
  });
});

describe('handleCaptureEngineStatus — 返却の絞り込み（M2d T2 修正 M-2）', () => {
  it('ok でも実行ファイルパス（bin）は返さない（source だけ返す）', () => {
    const ok: ResolveChromiumResult = { ok: true, bin: '/fake/chrome-headless-shell', source: 'tools' };
    const result = handleCaptureEngineStatus({ resolveChromium: () => ok });
    expect(result).toEqual({ ok: true, source: 'tools' });
    expect('bin' in result).toBe(false);
  });

  it('不在は { ok:false, kind, message } のみ', () => {
    const missing: ResolveChromiumResult = {
      ok: false,
      kind: 'chromium-missing',
      message: '撮影エンジン（chrome-headless-shell）が見つかりません',
    };
    expect(handleCaptureEngineStatus({ resolveChromium: () => missing })).toEqual({
      ok: false,
      kind: 'chromium-missing',
      message: '撮影エンジン（chrome-headless-shell）が見つかりません',
    });
  });
});

describe('GET /api/capture-engine/status — 値を pin する（M2d T2 修正 I-5）', () => {
  it('HARNESS_CHROMIUM が存在しないパスなら ok:false / kind:"env-path-missing"（環境非依存）', async () => {
    const prev = process.env.HARNESS_CHROMIUM;
    process.env.HARNESS_CHROMIUM = join(tmpdir(), 'sme-no-such-chrome-headless-shell');
    try {
      const r = await call('GET');
      expect(r.status).toBe(200);
      expect(r.body['ok']).toBe(false);
      expect(r.body['kind']).toBe('env-path-missing');
      expect(r.body['bin']).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.HARNESS_CHROMIUM;
      else process.env.HARNESS_CHROMIUM = prev;
    }
  });
});
