import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EditorAgentContext } from './editorAgentContext';
import { handleEditorAgentApi } from './editorAgentApi';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';
import { HttpError, sendJson } from './http';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('案件pageごとに接続とAI状態を返し、本文・所有情報をboard APIへ出さない', async () => {
  const root = mkdtempSync(join(tmpdir(), 'editor-board-')); directories.push(root);
  for (const id of ['a', 'b']) cpSync(new URL('./__fixtures__/sample-project', import.meta.url), join(root, id), { recursive: true });
  const store = new EditorOperationStore(join(root, '.operations.json'), 'server');
  const service = new EditorAgentService(store, (id) => { if (!['a', 'b'].includes(id)) throw new Error('PROJECT_NOT_FOUND'); },
    Date.now, 15_000, undefined, new EditorAgentContext(root));
  const heartbeat = { sessionId: 'private-session', sessionKey: 'private-session-key-private-session-key', sequence: 1,
    snapshot: { status: 'ready' as const, projectId: 'a', revision: 'private-revision', dirty: false, saving: false,
      humanBusy: false, elements: [{ id: '1', text: '保存本文before', sourceFrameRange: { start: 0, end: 30 } }] } };
  service.heartbeat(heartbeat);
  service.enqueue(heartbeat.sessionId, { schemaVersion: 1, operationId: 'op', projectId: 'a', baseRevision: 'private-revision',
    changes: [{ type: 'set_telop_text', elementId: '1', before: '保存本文before', after: '保存本文after',
      sourceFrameRange: { start: 0, end: 30 } }] });

  const first = service.board(0, 1);
  expect(first).toMatchObject({ total: 2, nextOffset: 1,
    items: [{ projectId: 'a', editor: { connected: true, ready: true }, operation: { phase: 'running' }, humanReview: null }] });
  expect(() => service.board(0, 101)).toThrow(/INVALID_PAGE/);
  expect(JSON.stringify(first)).not.toMatch(/保存本文|private-session|private-revision|claim|token|sessionId|before|after/);

  const delivery = service.delivery(heartbeat.sessionId, heartbeat.sessionKey, service.list('a')[0]!.runId);
  service.acknowledge(heartbeat.sessionId, heartbeat.sessionKey, delivery.runId, delivery.claim!.token,
    { phase: 'applied', revision: 'saved-revision', code: null, applied: true, saved: false });
  service.acknowledge(heartbeat.sessionId, heartbeat.sessionKey, delivery.runId, delivery.claim!.token,
    { phase: 'saved', revision: 'saved-revision', code: null, applied: true, saved: true });
  expect(service.board(0, 1).items[0]?.humanReview).toBe('pending');

  service.heartbeat({ ...heartbeat, sessionId: 'failed-window', sessionKey: 'failed-window-key-failed-window-key',
    snapshot: { status: 'error', projectId: 'b' }, sequence: 1 });
  expect(service.board(1, 1).items[0]?.editor).toEqual({ connected: true, ready: false, dirty: false, failed: true });

  const server = createServer((req, res) => {
    void handleEditorAgentApi(req, res, new URL(req.url ?? '/', 'http://localhost'), service)
      .catch((error: unknown) => sendJson(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('port missing');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/editor/board?offset=1&limit=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 2, nextOffset: null,
      items: [{ projectId: 'b', editor: { connected: true, ready: false, failed: true }, operation: null, humanReview: null }] });
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
