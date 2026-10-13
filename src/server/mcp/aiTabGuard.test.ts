import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AiScreen } from '../../shared/aiFocus';
import { AiFocusRegistry } from '../aiFocus';
import { EditorAgentService } from '../editorAgentService';
import { EditorOperationStore } from '../editorOperationStore';
import { createInstructionInbox } from '../instructionInbox';
import { readJsonBody } from '../readBody';
import { aiTabMcpLastSeen, isAiTabRequest, resetAiTabMcp } from './aiTabClient';
import { handleMcpRequest } from './server';
import { slidesAgent } from '../slides/agent';

const screen = (projectId: string, mode: AiScreen['mode'] = 'video'): AiScreen => ({ projectId, projectName: `名前-${projectId}`, mode, target: null, playheadSec: null, selection: [], materials: '' });
const snapshot = { status: 'ready', projectId: 'a', revision: 'r1', dirty: false, saving: false, humanBusy: false,
  elements: [{ id: 'caption', text: 'before', sourceFrameRange: { start: 0, end: 90 } }] };
const request = (projectId: string) => ({ schemaVersion: 1, projectId, operationId: `op-${projectId}-${Math.random().toString(36).slice(2)}`, baseRevision: 'r1',
  changes: [{ type: 'set_telop_text', elementId: 'caption', before: 'before', after: 'after', sourceFrameRange: { start: 0, end: 90 } }] });
let directory: string, server: Server, base: string, service: EditorAgentService, focus: AiFocusRegistry;
const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ai-tab-guard-'));
  service = new EditorAgentService(new EditorOperationStore(join(directory, 'runs.json'), 'instance-a'), () => {});
  service.heartbeat({ sessionId: 'window', sessionKey: 's'.repeat(32), sequence: 1, snapshot });
  focus = new AiFocusRegistry(() => 1000, 15000);
  resetAiTabMcp();
  const inbox = createInstructionInbox();
  server = createServer((req, res) => {
    void (async () => { const body = req.method === 'POST' ? await readJsonBody(req) : undefined; await handleMcpRequest(req, res, inbox, body, service, focus); })();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const { client, transport } of clients.splice(0)) { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}); }
  await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  rmSync(directory, { recursive: true, force: true });
});
async function apply(path: string, projectId: string) {
  const client = new Client({ name: 'guard-test', version: '1' }), transport = new StreamableHTTPClientTransport(new URL(base + path));
  await client.connect(transport); clients.push({ client, transport });
  const result = await client.callTool({ name: 'editor_apply', arguments: { sessionId: 'window', request: request(projectId) } }) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

describe('AI タブの接続の見分け', () => {
  it('?client=ai-tab の要求だけを AI タブの接続とみなし、最終通信時刻を残す', async () => {
    expect(isAiTabRequest('/mcp?client=ai-tab')).toBe(true);
    expect(isAiTabRequest('/mcp')).toBe(false);
    expect(isAiTabRequest(undefined)).toBe(false);
    expect(aiTabMcpLastSeen()).toBeNull();
    vi.spyOn(service, 'enqueue').mockReturnValue({ runId: 'run-x' } as never);
    await apply('/mcp', 'a');
    expect(aiTabMcpLastSeen()).toBeNull();
    await apply('/mcp?client=ai-tab', 'a');
    expect(aiTabMcpLastSeen()).toEqual(expect.any(Number));
  });
});

describe('editor_apply の対象確認', () => {
  it('外からの接続（/mcp）は今までどおり確かめない', async () => {
    const enqueue = vi.spyOn(service, 'enqueue').mockReturnValue({ runId: 'run-x' } as never);
    expect((await apply('/mcp', 'a')).isError).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it('AI タブの接続: 依頼時点が無ければ断り、サービスを呼ばない', async () => {
    const enqueue = vi.spyOn(service, 'enqueue').mockReturnValue({ runId: 'run-x' } as never);
    const result = await apply('/mcp?client=ai-tab', 'a');
    expect(result).toMatchObject({ isError: true, json: { code: 'TARGET_NOT_REQUESTED', recovery: { action: 'confirm_with_user' } } });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('依頼時点の案件には書ける。依頼の後に別の案件へ移っても、別の案件へは書けない。同じ案件のモードの移動は通す', async () => {
    const enqueue = vi.spyOn(service, 'enqueue').mockReturnValue({ runId: 'run-x' } as never);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    focus.noteSubmit();
    focus.beat({ pageId: 'page-aaaa', seq: 2, screen: screen('a', 'thumbnail') });
    expect((await apply('/mcp?client=ai-tab', 'a')).isError).toBe(false);
    focus.beat({ pageId: 'page-aaaa', seq: 3, screen: screen('b') });
    expect((await apply('/mcp?client=ai-tab', 'a')).isError).toBe(false);
    const other = await apply('/mcp?client=ai-tab', 'b');
    expect(other).toMatchObject({ isError: true, json: { code: 'TARGET_NOT_REQUESTED' } });
    expect(other.json.error).toContain('名前-a');
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe('editor_import_media の対象確認（取り込みも動画への書き込み）', () => {
  async function importMedia(path: string, projectId: string) {
    const client = new Client({ name: 'guard-test', version: '1' }), transport = new StreamableHTTPClientTransport(new URL(base + path));
    await client.connect(transport); clients.push({ client, transport });
    const result = await client.callTool({ name: 'editor_import_media', arguments: { sessionId: 'window', projectId, operationId: `op-${projectId}`, paths: ['/Volumes/m/a.mp4'], placement: 'append-main' } }) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Record<string, any> };
  }
  it('AI タブの接続では依頼時点の案件にだけ取り込める。外からの接続は今までどおり確かめない', async () => {
    const importMediaSpy = vi.spyOn(service, 'importMedia').mockReturnValue({ batchId: 'imp-x' } as never);
    expect(await importMedia('/mcp?client=ai-tab', 'a')).toMatchObject({ isError: true, json: { code: 'TARGET_NOT_REQUESTED' } });
    expect(importMediaSpy).not.toHaveBeenCalled();
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    focus.noteSubmit();
    expect((await importMedia('/mcp?client=ai-tab', 'a')).isError).toBe(false);
    expect(await importMedia('/mcp?client=ai-tab', 'b')).toMatchObject({ isError: true, json: { code: 'TARGET_NOT_REQUESTED' } });
    expect((await importMedia('/mcp', 'b')).isError).toBe(false);
    expect(importMediaSpy).toHaveBeenCalledTimes(2);
  });
});

describe('中止の道具の対象確認（中止も状態を変える書き込み）', () => {
  async function call(path: string, name: string, args: Record<string, unknown>) {
    const client = new Client({ name: 'guard-test', version: '1' }), transport = new StreamableHTTPClientTransport(new URL(base + path));
    await client.connect(transport); clients.push({ client, transport });
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Record<string, any> };
  }
  const slidesArgs = (projectId: string) => ({ projectId, documentId: `doc-${projectId}`, sessionId: 's1', expectedRevision: 0, operationId: `stop-${projectId}`, runId: 'run-1' });
  const requestA = () => { focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') }); focus.noteSubmit(); };

  it('slides_cancel: AI タブは依頼時点の案件だけ中止できる。外からの接続は今までどおり', async () => {
    const cancel = vi.spyOn(slidesAgent, 'cancel').mockReturnValue({ ok: true } as never);
    expect(await call('/mcp?client=ai-tab', 'slides_cancel', slidesArgs('a'))).toMatchObject({ isError: true, json: { error: { code: 'TARGET_NOT_REQUESTED' } } });
    requestA();
    expect((await call('/mcp?client=ai-tab', 'slides_cancel', slidesArgs('a'))).isError).toBe(false);
    expect(await call('/mcp?client=ai-tab', 'slides_cancel', slidesArgs('b'))).toMatchObject({ isError: true, json: { error: { code: 'TARGET_NOT_REQUESTED' } } });
    expect((await call('/mcp', 'slides_cancel', slidesArgs('b'))).isError).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('editor_import_cancel: 別の案件の取り込みの束は中止できない', async () => {
    const cancel = vi.spyOn(service, 'cancelImport').mockReturnValue({ ok: true } as never);
    requestA();
    expect((await call('/mcp?client=ai-tab', 'editor_import_cancel', { projectId: 'a', batchId: 'imp-a' })).isError).toBe(false);
    expect(await call('/mcp?client=ai-tab', 'editor_import_cancel', { projectId: 'b', batchId: 'imp-b' })).toMatchObject({ isError: true, json: { code: 'TARGET_NOT_REQUESTED' } });
    expect((await call('/mcp', 'editor_import_cancel', { projectId: 'b', batchId: 'imp-b' })).isError).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  it('editor_cancel: 編集の実行 ID から案件を引き、別の案件の編集は止められない', async () => {
    vi.spyOn(service, 'get').mockImplementation((runId: string) => ({ runId, request: { projectId: runId === 'run-a' ? 'a' : 'b' } }) as never);
    const cancel = vi.spyOn(service, 'cancel').mockReturnValue({ ok: true } as never);
    requestA();
    expect((await call('/mcp?client=ai-tab', 'editor_cancel', { runId: 'run-a' })).isError).toBe(false);
    expect(await call('/mcp?client=ai-tab', 'editor_cancel', { runId: 'run-b' })).toMatchObject({ isError: true, json: { code: 'TARGET_NOT_REQUESTED' } });
    expect((await call('/mcp', 'editor_cancel', { runId: 'run-b' })).isError).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
