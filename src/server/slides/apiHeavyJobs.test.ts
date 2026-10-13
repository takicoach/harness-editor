import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slidesFixture } from '../../core/slides/fixtures';
import { handleSlidesApi } from './api';
import type { SlidesCapture } from './capture';
import { SlidesExports } from './exports';
import { SlidesPreviews } from './previews';
import { createSlidesProject } from './projects';
import { SlidesRenderInputs } from './renderInputs';
import { SlidesService } from './service';
import { SlidesStore } from './store';
import { SlidesVideoImports } from './videoImport';

let server: Server, origin = '', root = '', allowed = false, captures = 0;
const capture: SlidesCapture = async (_target, count, _shot, onPage) => { captures++; for (let i = 0; i < count; i++) await onPage(i, Buffer.from('png')); };
const service = new SlidesService(), inputs = new SlidesRenderInputs();
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'slides-heavy-')); const { id } = createSlidesProject(root, '講義');
  new SlidesStore(join(root, id)).save({ expectedSavedRevision: 0, executionId: 'seed', document: { ...slidesFixture(), revision: 1 } });
  const overrides = { service, inputs, previews: new SlidesPreviews(capture, inputs), exports: new SlidesExports(capture, async () => Buffer.from('%PDF'), inputs),
    videoImports: new SlidesVideoImports(capture, inputs), heavyJobAllowed: () => allowed };
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleSlidesApi(req, res, url, root, overrides).then(handled => { if (!handled) { res.statusCode = 404; res.end('{}'); } });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); rmSync(root, { recursive: true, force: true }); });
async function call(route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api/slides${route}?id=${encodeURIComponent('講義')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

describe('スライドの Chromium を重い処理の枠（heavyJobGate）に入れる', () => {
  it('枠が空いていなければ、書き出し・動画への取り込みは 429 で断り、縮小画像は Chromium を起動せず理由を返す', async () => {
    const state = (await call('/session', {})).json as { sessionId: string; document: { revision: number } };
    allowed = false;
    const exported = await call('/export', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'busy-export', format: 'png' });
    expect([exported.status, exported.json.error]).toEqual([429, expect.stringContaining('ほかの重い処理')]);
    const imported = await call('/video-import', { sessionId: state.sessionId, videoProjectId: 'video-case', pageIds: ['page-1'] });
    expect([imported.status, imported.json.error]).toEqual([429, expect.stringContaining('ほかの重い処理')]);
    const previews = await call('/preview', { sessionId: state.sessionId, pageIds: ['page-1'] });
    expect(previews.json.pages).toEqual([expect.objectContaining({ pageId: 'page-1', ready: false, failed: true, error: expect.stringContaining('ほかの重い処理') })]);
    expect(captures).toBe(0);
    // 枠が空けば受け付ける。同じ実行 ID の照会は枠に関係なく返す。
    allowed = true;
    expect((await call('/export', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'free-export', format: 'png' })).status).toBe(200);
    allowed = false;
    expect((await call('/export', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'free-export', format: 'png' })).status).toBe(200);
  });
});
