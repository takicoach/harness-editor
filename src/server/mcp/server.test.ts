import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorAgentService } from '../editorAgentService';
import { EditorOperationStore } from '../editorOperationStore';
import { HttpError, sendJson } from '../http';
import { createInstructionInbox, type InstructionInbox } from '../instructionInbox';
import { readJsonBody } from '../readBody';
import { handleMcpRequest } from './server';

const directories: string[] = [];
const servers: Server[] = [];
const clients: Array<{ client: Client; transport: StreamableHTTPClientTransport }> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async ({ client, transport }) => {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeService(directory: string, instanceId: string): EditorAgentService {
  const service = new EditorAgentService(
    new EditorOperationStore(join(directory, 'operations.json'), instanceId),
    () => {},
  );
  service.heartbeat({
    sessionId: 'window-a',
    sessionKey: 'k'.repeat(32),
    sequence: 1,
    snapshot: {
      status: 'ready',
      projectId: 'project-a',
      revision: 'rev-a',
      dirty: false,
      saving: false,
      humanBusy: false,
      elements: [{ id: '1', text: 'before', sourceFrameRange: { start: 0, end: 30 } }],
    },
  });
  return service;
}

async function startMcpServer(
  inbox: InstructionInbox,
  getService: () => EditorAgentService,
): Promise<URL> {
  const server = createServer((req, res) => {
    void (async () => {
      const body = (req.method ?? 'GET').toUpperCase() === 'POST' ? await readJsonBody(req) : undefined;
      await handleMcpRequest(req, res, inbox, body, getService());
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, error instanceof HttpError ? error.status : 500,
          { error: error instanceof Error ? error.message : String(error) });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing MCP test port');
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function connect(url: URL, name: string): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  const pair = { client, transport };
  clients.push(pair);
  return pair;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

function textResult(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('content' in result)
    || !Array.isArray((result as { content: unknown }).content)) {
    throw new Error('missing MCP result content');
  }
  const content = (result as { content: unknown[] }).content;
  const block = content.find((candidate) => candidate !== null && typeof candidate === 'object'
    && 'type' in candidate && candidate.type === 'text');
  if (!block || typeof block !== 'object' || !('text' in block) || typeof block.text !== 'string') {
    throw new Error('missing text result');
  }
  return JSON.parse(block.text);
}

describe('MCP transport lifecycle', () => {
  it('SDKによるtool入力schema拒否もhandler実行前に構造化する', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-invalid-input-'));
    directories.push(directory);
    const service = makeService(directory, 'server-a');
    const url = await startMcpServer(createInstructionInbox(), () => service);
    const { client } = await connect(url, 'invalid-input');

    const result = await client.callTool({ name: 'editor_apply', arguments: { sessionId: 'window-a', request: {} } });
    expect(result.isError).toBe(true);
    const block = (result.content as Array<{ type: string; text?: string }>).find((entry) => entry.type === 'text');
    expect(block?.type === 'text' && block.text ? JSON.parse(block.text) : null).toMatchObject({
      code: 'INVALID_EDITOR_INPUT', retryable: false, recovery: { action: 'fix_request' },
      identifiers: { sessionId: 'window-a' },
    });
    expect(service.operations.list()).toEqual([]);
  });

  it('service 世代が変わると旧toolをerrorにし、旧sessionの再利用を404にする', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-generation-'));
    directories.push(directory);
    const oldService = makeService(directory, 'server-old');
    let activeService = oldService;
    const inbox = createInstructionInbox();
    const url = await startMcpServer(inbox, () => activeService);
    const { client } = await connect(url, 'generation-owner');

    const newService = makeService(directory, 'server-new');
    activeService = newService;
    const result = await client.callTool({ name: 'editor_read', arguments: { sessionId: 'window-a' } });
    expect(result.isError).toBe(true);
    expect(textResult(result)).toMatchObject({ code: 'MCP_SESSION_EXPIRED', retryable: false,
      recovery: { action: 'use_current_session' }, identifiers: { sessionId: 'window-a' } });
    await expect(client.listTools()).rejects.toMatchObject({ code: 404 });

    const replacement = await connect(url, 'generation-replacement');
    expect((await replacement.client.listTools()).tools.map((tool) => tool.name)).toContain('editor_apply');
  });

  it('切断したlong-pollだけを外し、別sessionのconsumerへ指示を一度だけ渡す', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-parallel-poll-'));
    directories.push(directory);
    const service = makeService(directory, 'server-a');
    const inbox = createInstructionInbox();
    const url = await startMcpServer(inbox, () => service);
    const first = await connect(url, 'consumer-disconnects');
    const second = await connect(url, 'consumer-stays');

    const abandoned = first.client.callTool({ name: 'get_next_instruction', arguments: { waitMs: 5_000 } });
    const active = second.client.callTool({ name: 'get_next_instruction', arguments: { waitMs: 5_000 } });
    await waitUntil(() => inbox.agentStatus().waiting === 2);

    await first.transport.close();
    await expect(abandoned).rejects.toThrow();
    await waitUntil(() => inbox.agentStatus().waiting === 1);
    const queued = inbox.enqueue({
      projectId: 'project-a',
      projectDir: directory,
      text: 'live consumer only',
      context: { frame: 0, timeSec: 0, selection: null },
    });

    expect(textResult(await active)).toMatchObject({ empty: false, id: queued.id });
    expect(inbox.list('project-a')).toHaveLength(1);
    expect(inbox.list('project-a')[0]?.status).toBe('processing');
  });

  it('未知session idを暗黙に初期化せず404で再initializeを要求する', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-unknown-session-'));
    directories.push(directory);
    const service = makeService(directory, 'server-a');
    const url = await startMcpServer(createInstructionInbox(), () => service);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('initialize'),
      code: 'MCP_SESSION_EXPIRED', retryable: false, recovery: { action: 'use_current_session' } });
  });
});
