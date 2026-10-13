import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLIDES_OUTLINE_SCHEMA } from '../../core/slides/contract';
import { scriptText } from '../../core/slides/fixtures';
import { SlidesAgent } from './agent';
import { handleSlidesApi } from './api';
import { createSlidesProject } from './projects';
import { SlidesService } from './service';

let server: Server, origin = '', root = '';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'slides-agent-api-')); createSlidesProject(root, '講義');
  const service = new SlidesService(), agent = new SlidesAgent(() => root, service);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleSlidesApi(req, res, url, root, { service, agent }).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); rmSync(root, { recursive: true, force: true }); });
async function call(route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api/slides${route}${route.includes('?') ? '&' : '?'}id=${encodeURIComponent('講義')}`,
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
type State = { sessionId: string; document: { id: string; revision: number } };

describe('/api/slides の貼り付けの経路（受け入れ 1）', () => {
  it('検証・適用・結果照会は MCP と同じ受け口を通る。不正な構成案は文書を変えない。古い版は 409 と次にすることを返す', async () => {
    let state = (await call('/session', {})).json as unknown as State;
    state = (await call('/command', { sessionId: state.sessionId, expectedRevision: 0, executionId: 'script', command: { type: 'set-script', text: scriptText(6) } })).json as unknown as State;
    const base = { documentId: state.document.id, sessionId: state.sessionId, expectedRevision: state.document.revision };
    const bad = { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: [{ key: 's1', layout: 'cover', title: '題', sourceParagraphIds: ['p1'] }] };
    expect((await call('/validate', { ...base, kind: 'outline', payload: bad })).json).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'MISSING' })]) });
    expect((await call('/apply', { ...base, kind: 'outline', operationId: 'paste-1', payload: bad })).json).toMatchObject({ status: 'rejected', route: 'paste' });
    expect(((await call('/session/status', { sessionId: state.sessionId })).json as unknown as State).document.revision).toBe(base.expectedRevision);
    const good = { ...bad, pages: [{ key: 's1', layout: 'points', title: '題', sourceParagraphIds: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'] }] };
    expect((await call('/apply', { ...base, kind: 'outline', operationId: 'paste-2', payload: good })).json).toMatchObject({ status: 'applied', route: 'paste' });
    expect((await call('/runs?operationId=paste-2')).json).toMatchObject({ operation: { operationId: 'paste-2', status: 'applied' } });
    const late = await call('/apply', { ...base, kind: 'outline', operationId: 'paste-3', payload: good });
    expect([late.status, late.json.code, typeof late.json.recovery]).toEqual([409, 'REVISION_CONFLICT', 'string']);
    expect((await call('/apply', { ...base, kind: 'other', operationId: 'paste-4', payload: good })).status).toBe(400);
  });
  it('入れ子が深すぎる回答は、指紋の計算や検証より前に 400 で断る（落ちて 422／500 にならない）', async () => {
    const state = (await call('/session', {})).json as unknown as State;
    for (const [route, depth] of [['/apply', 100], ['/apply', 200_000], ['/validate', 100]] as const) {
      const nested = '['.repeat(depth) + ']'.repeat(depth);
      const body = `{"documentId":${JSON.stringify(state.document.id)},"sessionId":${JSON.stringify(state.sessionId)},"expectedRevision":${state.document.revision},`
        + `"kind":"outline","operationId":"deep-${depth}","payload":${nested}}`;
      const response = await fetch(`${origin}/api/slides${route}?id=${encodeURIComponent('講義')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      const json = await response.json() as Record<string, unknown>;
      expect([route, depth, response.status, json.code]).toEqual([route, depth, 400, 'INVALID_INPUT']);
    }
  });
});
