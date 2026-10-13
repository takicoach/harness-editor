import { afterAll, beforeAll, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createInstructionInbox } from '../instructionInbox';
import { readJsonBody } from '../readBody';
import { EDITOR_BRIEF, SLIDES_REQUEST_WORKFLOW } from '../../shared/agentPrompts';
import { handleMcpRequest } from './server';

let server: Server, url: URL;
beforeAll(async () => {
  const inbox = createInstructionInbox();
  server = createServer((req, res) => {
    void (async () => { const body = (req.method ?? 'GET').toUpperCase() === 'POST' ? await readJsonBody(req) : undefined; await handleMcpRequest(req, res, inbox, body); })();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
afterAll(() => { server.closeAllConnections(); server.close(); });

it('/mcp に、編集画面が無くてもスライドの道具 6 つが出る（既存の受け箱の道具も残る）', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' }), transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['editor_context', 'get_next_instruction', 'report_instruction_status', 'slides_read', 'slides_validate', 'slides_apply_outline', 'slides_apply_pages', 'slides_runs', 'slides_cancel']));
  } finally { await transport.terminateSession().catch(() => {}); await client.close(); }
});

it('初期化時の説明（instructions）は EDITOR_BRIEF。editor_guide でモード別の手順を読める', async () => {
  const client = new Client({ name: 'test', version: '0.0.0' }), transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  try {
    expect(client.getInstructions()).toBe(EDITOR_BRIEF);
    const result = await client.callTool({ name: 'editor_guide', arguments: { mode: 'slides' } }) as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ mode: 'slides', guide: expect.stringContaining(SLIDES_REQUEST_WORKFLOW) });
  } finally { await transport.terminateSession().catch(() => {}); await client.close(); }
});
