import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEditorAgentApi } from './editorAgentApi';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';
import { HttpError, sendJson } from './http';

let server: Server; let directory: string; let base: string; let service: EditorAgentService;
const identity = { sessionId: 'window', sessionKey: 'a'.repeat(32) };
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'editor-agent-api-'));
  service = new EditorAgentService(new EditorOperationStore(join(directory, 'operations.json'), 'a'), () => {});
  server = createServer((req, res) => {
    void handleEditorAgentApi(req, res, new URL(req.url!, 'http://localhost'), service)
      .catch((e: unknown) => sendJson(res, e instanceof HttpError ? e.status : 500,
        { error: e instanceof Error ? e.message : String(e) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test port missing');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  rmSync(directory, { recursive: true, force: true });
});
const post = (route: string, body: unknown) => fetch(base + '/api/editor/' + route,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function connect() {
  return post('heartbeat', { ...identity, sequence: 1, snapshot: { status: 'ready', projectId: 'a', revision: 'r1',
    dirty: false, saving: false, humanBusy: false, elements: [{ id: '1', text: 'before', sourceFrameRange: { start: 0, end: 30 } }] } });
}
describe('編集エージェントHTTP境界', () => {
  it('不正なpaginationは400にし、改変や競合と区別する', async () => {
    expect((await connect()).status).toBe(200);
    for (const query of ['limit=0', 'limit=101', 'offset=-1', 'limit=not-a-number']) {
      const response = await fetch(`${base}/api/editor/snapshot?sessionId=window&${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(/^INVALID_PAGE:/), code: 'INVALID_PAGE', retryable: false,
        recovery: { action: 'fix_request' }, identifiers: { sessionId: 'window' },
      });
    }
    expect(service.operations.list()).toEqual([]);
  });
  it('外部originと不正入力を拒否し、公開した受付結果へclaimを含めない', async () => {
    const outside = await fetch(base+'/api/editor/sessions', { headers: { Origin: 'https://example.invalid' } });
    expect(outside.status).toBe(403);
    expect((await post('heartbeat', { ...identity, sequence: 1, snapshot: { status: 'home', projectId: null, dirty: true } })).status).toBe(400);
    expect((await connect()).status).toBe(200);
    const accepted = await post('operations', { sessionId: 'window', request: { schemaVersion: 1, operationId: 'op', projectId: 'a', baseRevision: 'r1',
      changes: [{ type: 'set_telop_text', elementId: '1', before: 'before', after: 'after', sourceFrameRange: { start: 0, end: 30 } }] } });
    expect(accepted.status).toBe(202);
    const receipt = await accepted.json(); expect(receipt).not.toHaveProperty('claim');
    const lookup = await fetch(`${base}/api/editor/operation?projectId=a&operationId=op`);
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({ runId: receipt.runId, request: { operationId: 'op' } });
    expect((await fetch(`${base}/api/editor/operation?projectId=a&operationId=missing`)).status).toBe(404);
    expect((await post('delivery', { sessionId: 'window', sessionKey: 'b'.repeat(32), runId: receipt.runId })).status).toBe(409);
    const delivery = await (await post('delivery', { ...identity, runId: receipt.runId })).json();
    const invalidAck = await post('ack', { ...identity, runId: receipt.runId, token: delivery.claim.token,
      result: { phase: 'saved', revision: null, applied: true, saved: true, code: null } });
    expect(invalidAck.status).toBe(400);
    expect(service.operations.get(receipt.runId).phase).toBe('running');
  });

  it('版競合は同じ要求の再送を促さず、判明済みIDと状態再取得を返す', async () => {
    expect((await connect()).status).toBe(200);
    const response = await post('validate', { sessionId: 'window', request: { schemaVersion: 1,
      operationId: 'op-conflict', projectId: 'a', baseRevision: 'old-revision',
      changes: [{ type: 'set_telop_text', elementId: '1', before: 'before', after: 'after',
        sourceFrameRange: { start: 0, end: 30 } }] } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'REVISION_CONFLICT', retryable: false,
      recovery: { action: 'read_current_state' },
      identifiers: { projectId: 'a', sessionId: 'window', operationId: 'op-conflict' },
    });
  });

  it('未知のbackend例外は500にし、内部pathやsecretを公開しない', async () => {
    vi.spyOn(service, 'projects').mockImplementation(() => {
      throw new Error('/Users/x/editor.json token=super-secret');
    });
    const response = await fetch(`${base}/api/editor/projects`);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'INTERNAL_EDITOR_ERROR', retryable: false,
      recovery: { action: 'contact_operator' } });
    expect(JSON.stringify(body)).not.toMatch(/Users|super-secret/);
  });

  it('atomic lock取得前のSTORE_BUSYだけは同一要求を安全に再送できる', async () => {
    expect((await connect()).status).toBe(200);
    const accepted = await post('operations', { sessionId: 'window', request: { schemaVersion: 1,
      operationId: 'op-busy', projectId: 'a', baseRevision: 'r1',
      changes: [{ type: 'set_telop_text', elementId: '1', before: 'before', after: 'after',
        sourceFrameRange: { start: 0, end: 30 } }] } });
    const receipt = await accepted.json();
    mkdirSync(`${service.operations.file}.lock`);
    try {
      const response = await post('cancel', { runId: receipt.runId });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'STORE_BUSY', retryable: true,
        recovery: { action: 'retry_same_request' }, identifiers: { runId: receipt.runId } });
    } finally { rmSync(`${service.operations.file}.lock`, { recursive: true }); }
    expect(service.operations.get(receipt.runId).phase).toBe('running');
  });

  it.each(['', '{invalid'])('JSON body不正を入力修正へ案内し、サービスを実行しない (%j)', async (rawBody) => {
    const response = await fetch(base + '/api/editor/heartbeat', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: rawBody });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_EDITOR_INPUT', retryable: false,
      recovery: { action: 'fix_request' } });
    expect(service.sessions.list()).toEqual([]);
  });
});
