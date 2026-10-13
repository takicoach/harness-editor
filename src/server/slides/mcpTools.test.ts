import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SLIDES_OUTLINE_SCHEMA } from '../../core/slides/contract';
import { pageBody, scriptText } from '../../core/slides/fixtures';
import { SlidesAgent } from './agent';
import { registerSlidesTools } from './mcpTools';
import { createSlidesProject } from './projects';
import { SlidesService } from './service';
import { SlidesStore } from './store';
import type { AiWriteGuard } from '../aiFocus';

type Json = { [key: string]: any };
const roots: string[] = [], clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function connect(paragraphs = 0, guard?: AiWriteGuard) {
  const root = mkdtempSync(join(tmpdir(), 'slides-mcp-')); roots.push(root);
  createSlidesProject(root, '講義');
  const service = new SlidesService(), agent = new SlidesAgent(() => root, service), server = new McpServer({ name: 'test', version: '0.0.0' }), directory = join(root, '講義');
  registerSlidesTools(server, agent, guard);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport); clients.push(client);
  if (paragraphs) {
    const opened = service.open(directory);
    service.execute(directory, { sessionId: opened.sessionId, expectedRevision: 0, executionId: 'script', command: { type: 'set-script', text: scriptText(paragraphs) } });
  }
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Json };
  };
  const fresh = async () => {
    const read = (await call('slides_read', { projectId: '講義' })).json;
    return { projectId: '講義', documentId: read.documentId as string, sessionId: read.sessionId as string, expectedRevision: read.revision as number };
  };
  return { client, call, fresh, service, directory };
}

describe('MCP の道具（slides_*）', () => {
  it('6 つの道具がある', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name).sort())
      .toEqual(['slides_apply_outline', 'slides_apply_pages', 'slides_cancel', 'slides_read', 'slides_runs', 'slides_validate']);
  });
  it('slides_read は一覧と、文書 ID・セッション・版・段落（続きは offset）・レイアウトの入力型を返す', async () => {
    const { call } = await connect(150);
    expect((await call('slides_read', {})).json.projects.map((project: Json) => project.id)).toEqual(['講義']);
    const read = (await call('slides_read', { projectId: '講義', limit: 100 })).json;
    expect(read).toMatchObject({ projectId: '講義', revision: 1, schemas: { outline: SLIDES_OUTLINE_SCHEMA, maxRepairsPerPage: 2 }, script: { total: 150, nextOffset: 100 } });
    expect(read.layouts.map((layout: Json) => layout.id)).toEqual(['cover', 'chapter', 'points', 'image-text', 'compare', 'steps']);
    expect((await call('slides_read', { projectId: '講義', offset: 100 })).json.script.paragraphs[0].id).toBe('p101');
    expect(await call('slides_read', { projectId: 'nothing' })).toMatchObject({ isError: true, json: { error: { code: 'NOT_FOUND' } } });
  });
  it('不正な構成案は MCP でも拒否し、文書を変えない（受け入れ 1）', async () => {
    const { call, fresh, service, directory } = await connect(3);
    const t = await fresh(), before = service.inspect(directory, t.sessionId).document;
    const payload = { schema: 'harness-slides-outline/0', pages: [{ key: 's1', layout: 'cover', title: '題', sourceParagraphIds: ['p1', 'p2', 'p3'] }], glossary: [] };
    expect((await call('slides_validate', { ...t, kind: 'outline', payload })).json).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: 'SCHEMA_VERSION', path: 'schema' })] });
    expect((await call('slides_apply_outline', { ...t, operationId: 'o1', payload })).json).toMatchObject({ status: 'rejected', route: 'mcp' });
    expect(service.inspect(directory, t.sessionId).document).toEqual(before);
  });
  it('構成案 → 人の確定 → 本文 → 結果照会 → 取消。誤りは位置・理由・次にすることを返す', async () => {
    const { call, fresh, service, directory } = await connect(6);
    const outline = { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: [{ key: 's1', layout: 'cover', title: '表紙', sourceParagraphIds: ['p1', 'p2', 'p3'] },
      { key: 's2', layout: 'points', title: '要点', sourceParagraphIds: ['p4', 'p5', 'p6'] }] };
    const applied = (await call('slides_apply_outline', { ...await fresh(), operationId: 'o1', model: 'codex', payload: outline })).json;
    expect(applied).toMatchObject({ status: 'applied' });
    expect(await call('slides_apply_pages', { ...await fresh(), operationId: 'p0', runId: applied.runId, payload: [pageBody('s1', 'cover')] }))
      .toMatchObject({ isError: true, json: { error: { code: 'RUN_STATE', recovery: expect.stringContaining('この構成で作る') } } });
    const t = await fresh();
    service.agentApply(directory, { sessionId: t.sessionId, expectedRevision: t.expectedRevision, executionId: 'confirm', command: { type: 'confirm-outline' } });
    expect((await call('slides_apply_pages', { ...await fresh(), operationId: 'p1', runId: applied.runId, payload: [pageBody('s1', 'cover')] })).json)
      .toMatchObject({ status: 'applied', pages: [{ key: 's1', result: 'applied' }] });
    expect((await call('slides_runs', { projectId: '講義', operationId: 'p1' })).json).toMatchObject({ operation: { operationId: 'p1', status: 'applied' } });
    expect((await call('slides_runs', { projectId: '講義' })).json.generation.pages.map((page: Json) => page.status)).toEqual(['generated', 'pending']);
    expect((await call('slides_cancel', { ...await fresh(), operationId: 'c1', runId: applied.runId })).json).toMatchObject({ status: 'applied', tool: 'cancel' });
    const load = new SlidesStore(directory).load();
    expect(load.kind === 'ok' && load.saved.document.generation!.status).toBe('cancelled');
    expect(await call('slides_apply_pages', { ...t, operationId: 'p9', runId: applied.runId, payload: [pageBody('s2', 'points')] }))
      .toMatchObject({ isError: true, json: { error: { code: 'REVISION_CONFLICT' } } });
  });
});

describe('AI タブの対象確認（スライド）', () => {
  it('対象確認が断ると、構成案を受け取らず文書を変えない', async () => {
    const guard: AiWriteGuard = () => ({ code: 'TARGET_NOT_REQUESTED', message: '依頼した時点の案件は「別」です', recovery: 'editor_context で確かめてください' });
    const { call, fresh, service, directory } = await connect(3, guard);
    const target = await fresh();
    const result = await call('slides_apply_outline', { ...target, operationId: 'op-guard-1', payload: { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: [] } });
    expect(result).toMatchObject({ isError: true, json: { error: { code: 'TARGET_NOT_REQUESTED', recovery: 'editor_context で確かめてください' } } });
    expect(service.open(directory).document.revision).toBe(target.expectedRevision);
  });
  it('対象確認が通せば、今までどおり処理する（読む道具は確かめない）', async () => {
    const { call, fresh } = await connect(3, () => null);
    expect((await call('slides_read', { projectId: '講義' })).isError).toBe(false);
    const target = await fresh();
    const result = await call('slides_apply_outline', { ...target, operationId: 'op-guard-2', payload: { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: [] } });
    expect(result.json.error?.code).not.toBe('TARGET_NOT_REQUESTED');
  });
});
