import { afterAll, beforeAll, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { THUMBNAIL_REQUEST_WORKFLOW } from '../../shared/agentPrompts';
import { createInstructionInbox } from '../instructionInbox';
import { readJsonBody } from '../readBody';
import { THUMBNAIL_TOOLS } from '../thumbnail/mcpTools';
import { handleMcpRequest } from './server';

let server: Server, base: string;
beforeAll(async () => {
  const inbox = createInstructionInbox();
  server = createServer((req, res) => {
    void (async () => { const body = (req.method ?? 'GET').toUpperCase() === 'POST' ? await readJsonBody(req) : undefined; await handleMcpRequest(req, res, inbox, body); })();
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

async function withClient<T>(path: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'test', version: '0.0.0' }), transport = new StreamableHTTPClientTransport(new URL(base + path));
  await client.connect(transport);
  try { return await run(client); } finally { await transport.terminateSession().catch(() => {}); await client.close(); }
}
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as { [key: string]: any } };
};

it('/mcp に、編集画面が無くてもサムネの道具 6 つが出る', async () => {
  const names = await withClient('/mcp', async client => (await client.listTools()).tools.map(tool => tool.name));
  expect(names).toEqual(expect.arrayContaining([...THUMBNAIL_TOOLS]));
});

it('editor_guide(thumbnail) はサムネの手順を返す', async () => {
  const result = await withClient('/mcp', client => call(client, 'editor_guide', { mode: 'thumbnail' }));
  expect(result.json).toMatchObject({ mode: 'thumbnail', guide: expect.stringContaining(THUMBNAIL_REQUEST_WORKFLOW) });
});

it('thumbnail_begin の依頼時点の確認は AI タブの接続（?client=ai-tab）だけに付き、外からの接続には付かない', async () => {
  // 依頼時点が無い AI タブの接続は断る。外からの接続は確認を飛ばして案件の確認（存在しない案件は NOT_FOUND）へ進む。
  const aiTab = await withClient('/mcp?client=ai-tab', client => call(client, 'thumbnail_begin', { projectId: 'no-such-project-thumbnail-mcp', kind: 'new' }));
  expect(aiTab).toMatchObject({ isError: true, json: { error: { code: 'TARGET_NOT_REQUESTED' } } });
  const outside = await withClient('/mcp', client => call(client, 'thumbnail_begin', { projectId: 'no-such-project-thumbnail-mcp', kind: 'new' }));
  expect(outside).toMatchObject({ isError: true, json: { error: { code: 'NOT_FOUND' } } });
});
