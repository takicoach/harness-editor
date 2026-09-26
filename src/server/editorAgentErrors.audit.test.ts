import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';
import { handleEditorAgentApi } from './editorAgentApi';
import { createInstructionInbox } from './instructionInbox';
import { handleMcpRequest } from './mcp/server';
import { HttpError, sendJson } from './http';
import { readJsonBody } from './readBody';

let directory: string;
let server: Server;
let base: string;
let service: EditorAgentService;
let client: Client;
let transport: StreamableHTTPClientTransport;
const snapshot = { status: 'ready', projectId: 'a', revision: 'r1', dirty: false, saving: false, humanBusy: false,
  elements: [{ id: 'caption', text: 'before', sourceFrameRange: { start: 0, end: 90 } }] };
const request = { schemaVersion: 1, projectId: 'a', operationId: 'audit-operation', baseRevision: 'r1',
  changes: [{ type: 'set_telop_text', elementId: 'caption', before: 'before', after: 'after', sourceFrameRange: { start: 0, end: 90 } }] };

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'editor-error-audit-'));
  service = new EditorAgentService(new EditorOperationStore(join(directory, 'runs.json'), 'instance-a'), () => {});
  service.heartbeat({ sessionId: 'window', sessionKey: 's'.repeat(32), sequence: 1, snapshot });
  const inbox = createInstructionInbox();
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
        await handleMcpRequest(req, res, inbox, body, service);
      } else await handleEditorAgentApi(req, res, url, service);
    })().catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, error instanceof HttpError ? error.status : 500,
        { error: error instanceof Error ? error.message : String(error) });
      else if (!res.writableEnded) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  base = `http://127.0.0.1:${address.port}`;
  client = new Client({ name: 'independent-error-audit', version: '1' });
  transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
  await client.connect(transport);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await transport?.terminateSession().catch(() => {});
  await client?.close().catch(() => {});
  if (server) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function tool(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const block = (response.content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text');
  if (!block?.text) throw new Error('missing response text');
  return { response, body: JSON.parse(block.text) as Record<string, any> };
}
const post = (route: string, body: unknown) => fetch(base + '/api/editor/' + route,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('公開エラー契約の独立HTTP/MCP監査', () => {
  it('初回offset=0は最新履歴を返し、返却cursorは追記後も同じ古い範囲を指す', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const receipt = service.operations.enqueue({ ...request, operationId: `page-${index}` });
      ids.push(receipt.runId);
      service.cancel(receipt.runId);
    }
    const initial = await tool('editor_runs', { projectId: 'a', offset: 0, limit: 10 });
    expect(initial.response.isError).not.toBe(true);
    expect(initial.body.operations.map((operation: { runId: string }) => operation.runId)).toEqual(ids.slice(15).reverse());
    expect(initial.body.nextOffset).toBe(15);
    const http = await fetch(base + '/api/editor/operations?projectId=a&offset=0&limit=10');
    expect(await http.json()).toEqual(initial.body);
    const appended = service.operations.enqueue({ ...request, operationId: 'page-new' });
    service.cancel(appended.runId);
    const second = await tool('editor_runs', { projectId: 'a', offset: initial.body.nextOffset, limit: 10 });
    expect(second.body.operations.map((operation: { runId: string }) => operation.runId)).toEqual(ids.slice(5, 15).reverse());
    const last = await tool('editor_runs', { projectId: 'a', offset: second.body.nextOffset, limit: 10 });
    expect(last.body.operations.map((operation: { runId: string }) => operation.runId)).toEqual(ids.slice(0, 5).reverse());
    expect(last.body.nextOffset).toBeNull();
    expect(last.body.total).toBe(26);
  });
  it.each(['', '{invalid'])('HTTPの空・不正JSONは入力修正へ案内する (%j)', async (body) => {
    const response = await fetch(base + '/api/editor/operations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_EDITOR_INPUT', retryable: false,
      recovery: { action: 'fix_request' } });
    expect(service.operations.list()).toEqual([]);
  });
  it('SDKがhandler前に拒否する不正引数も共通codeを返し、サービスを実行しない', async () => {
    const enqueue = vi.spyOn(service, 'enqueue');
    const { response, body } = await tool('editor_apply', { sessionId: 'window', request: {} });
    expect(response.isError).toBe(true);
    expect(body).toMatchObject({ code: 'INVALID_EDITOR_INPUT', retryable: false,
      recovery: { action: 'fix_request' } });
    expect(enqueue).not.toHaveBeenCalled();
    expect(service.operations.list()).toEqual([]);
  });

  it('版衝突は両境界で同じcodeと再取得案内を返し、再送で適用しない', async () => {
    const stale = { sessionId: 'window', request: { ...request, baseRevision: 'stale' } };
    const http = await post('operations', stale);
    const body = await http.json();
    const mcp = await tool('editor_apply', stale);
    expect(http.status).toBe(409);
    expect(mcp.response.isError).toBe(true);
    for (const item of [body, mcp.body]) {
      expect(item).toMatchObject({ code: 'REVISION_CONFLICT', retryable: false,
        recovery: { action: 'read_current_state' }, identifiers: { projectId: 'a', operationId: request.operationId } });
    }
    expect(service.operations.list()).toEqual([]);
  });

  it('同じ操作IDの本文変更は案を直すエラーで、新しい実行を増やさない', async () => {
    const original = service.enqueue('window', request);
    const { response, body } = await tool('editor_apply', { sessionId: 'window', request: {
      ...request, changes: [{ ...request.changes[0], after: 'different' }],
    } });
    expect(response.isError).toBe(true);
    expect(body.code).toBe('OPERATION_CONFLICT');
    expect(body.retryable).toBe(false);
    expect(body.recovery.action).not.toBe('retry_same_request');
    expect(service.operations.list()).toHaveLength(1);
    expect(service.operations.get(original.runId).request.changes[0]!.after).toBe('after');
  });

  it('予期しない内部例外はパス・鍵文字列を返さず、500と再送不可を維持', async () => {
    const privateText = 'disk read /Users/x/keys.env token=DO_NOT_EXPOSE';
    vi.spyOn(service, 'read').mockImplementation(() => { throw new Error(privateText); });
    const http = await fetch(base + '/api/editor/snapshot?sessionId=window');
    const body = await http.json();
    const mcp = await tool('editor_read', { sessionId: 'window' });
    expect(http.status).toBe(500);
    expect(mcp.response.isError).toBe(true);
    for (const item of [body, mcp.body]) {
      expect(typeof item.code).toBe('string');
      expect(item.retryable).toBe(false);
      expect(item.recovery.action).toBe('contact_operator');
      expect(JSON.stringify(item)).not.toMatch(/Users|keys\.env|DO_NOT_EXPOSE/);
    }
  });

  it.each(['STORE_BUSY', 'SAVE_RESULT_UNKNOWN', 'RESULT_UNKNOWN', 'CHECKPOINT_CONFLICT'])('failed receiptの%sから実行不能な再送・再開確認を勧めない', async (code) => {
    const run = service.enqueue('window', request);
    const claim = service.operations.get(run.runId).claim!;
    service.acknowledge('window', 's'.repeat(32), run.runId, claim.token,
      { phase: 'failed', revision: null, code, applied: false, saved: false });
    const { body } = await tool('editor_runs', { runId: run.runId });
    expect(body.phase).toBe('failed');
    expect(body.errorDetail.retryable).toBe(false);
    expect(body.errorDetail.recovery.action).not.toBe('retry_same_request');
    expect(body.errorDetail.recovery.action).not.toBe('reconcile_result');
    expect(() => service.prepareReconciliation('window', run.runId)).toThrow(/^REVIEW_NOT_REQUIRED:/);
    expect(service.enqueue('window', request).runId).toBe(run.runId);
    expect(service.operations.list()).toHaveLength(1);
  });

  it('再起動後の結果不明は読取成功でも実行成功にせず、確認して再開へ案内', async () => {
    const original = service.enqueue('window', request);
    const restarted = new EditorOperationStore(join(directory, 'runs.json'), 'instance-b');
    restarted.recoverInterrupted();
    service = new EditorAgentService(restarted, () => {});
    await transport.terminateSession();
    await client.close();
    client = new Client({ name: 'independent-error-audit-reconnected', version: '1' });
    transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'));
    await client.connect(transport);
    const http = await fetch(base + '/api/editor/operation?runId=' + original.runId);
    const body = await http.json();
    const mcp = await tool('editor_runs', { runId: original.runId });
    expect(http.status).toBe(200);
    expect(mcp.response.isError).not.toBe(true);
    for (const item of [body, mcp.body]) {
      expect(item.phase).toBe('unknown');
      expect(item.confirmed.saved).toBe(false);
      expect(item.humanReview).toBe('pending');
      expect(item.errorDetail).toMatchObject({ retryable: false, recovery: { action: 'reconcile_result' } });
    }
    expect(service.operations.list()).toHaveLength(1);
  });
});
