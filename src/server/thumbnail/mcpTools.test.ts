import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { VIDEO_ASSET } from '../../core/thumbnail/fixtures';
import type { AiScreen } from '../../shared/aiFocus';
import { AiFocusRegistry } from '../aiFocus';
import { SequenceStore } from '../sequence/store';
import { ThumbnailAgent } from './agent';
import { registerThumbnailTools, THUMBNAIL_MODE_DENIAL, THUMBNAIL_TOOLS } from './mcpTools';
import { ThumbnailService } from './service';

type Json = { [key: string]: any };
const roots: string[] = [], clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const screen = (projectId: string, mode: AiScreen['mode']): AiScreen => ({ projectId, projectName: `名前-${projectId}`, mode, target: null, playheadSec: null, selection: [], materials: '' });
/** 字幕は音声のストリームにしか付けられない（validate.ts の文字起こしの検査）ので、見本の動画に音声を足す。 */
const AV_ASSET: SequenceAsset = { ...VIDEO_ASSET, streams: [...VIDEO_ASSET.streams, { index: 1, kind: 'audio', codec: 'aac', duration: { num: 3, den: 1 }, sampleRate: 48000, channels: 2 }] };

/** aiTabGuard.test.ts と同じ繋ぎ方: focus を渡せば AI タブの接続（beginGuard あり）、渡さなければ外からの接続（beginGuard なし）。 */
async function connect(focus?: AiFocusRegistry) {
  const root = mkdtempSync(join(tmpdir(), 'thumb-mcp-')); roots.push(root);
  const service = new ThumbnailService(), agent = new ThumbnailAgent({ root: () => root, service });
  for (const projectId of ['a', 'b']) {
    const directory = join(root, projectId); mkdirSync(directory);
    const video: SequenceDocument = { schemaVersion: 2, id: projectId, name: projectId, revision: 0, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30,
      background: '#000000', assets: [AV_ASSET], tracks: [], clips: [], transitions: [], transcripts: [
        { assetId: AV_ASSET.id, streamIndex: 1, words: [{ id: 'w1', text: '飛距離が', start: { num: 1, den: 2 }, end: { num: 3, den: 2 } }, { id: 'w2', text: '伸びる。', start: { num: 3, den: 2 }, end: { num: 5, den: 2 } }] }],
      ducking: { enabled: false, strength: 'mid' } };
    new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'v', document: video });
    service.create(directory, `c-${projectId}`);
  }
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerThumbnailTools(server, agent, { origin: 'http://127.0.0.1:1',
    beginGuard: focus ? (projectId) => focus.checkWriteTarget(projectId) ?? (focus.request()?.mode === 'thumbnail' ? null : THUMBNAIL_MODE_DENIAL) : undefined });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport); clients.push(client);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Json };
  };
  return { client, call, focus };
}

describe('MCP の道具（thumbnail_*）', () => {
  it('6 つの道具がある（THUMBNAIL_TOOLS と一致）', async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...THUMBNAIL_TOOLS].sort());
  });
  it('端末から直接の依頼: 依頼時点が別の案件なら begin を断り、サムネの画面でなければ断る', async () => {
    const focus = new AiFocusRegistry(() => 1000, 15000), { call } = await connect(focus);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('b', 'thumbnail') }); focus.noteSubmit();
    expect((await call('thumbnail_begin', { projectId: 'a', kind: 'new' })).json.error.code).toBe('TARGET_NOT_REQUESTED');
    focus.claim({ pageId: 'page-aaaa', seq: 2, screen: screen('a', 'video') }); focus.noteSubmit();
    expect((await call('thumbnail_begin', { projectId: 'a', kind: 'new' })).json.error.code).toBe('TARGET_NOT_REQUESTED');
    focus.claim({ pageId: 'page-aaaa', seq: 3, screen: screen('a', 'thumbnail') }); focus.noteSubmit();
    expect((await call('thumbnail_begin', { projectId: 'a', kind: 'new' })).json.requestId).toMatch(/^d-/);
  });
  it('A で依頼 → B を開いて端末で答える（依頼時点が B に動く）→ A への確定は通る。begin 以外は依頼時点を見ない', async () => {
    const focus = new AiFocusRegistry(() => 1000, 15000), { call } = await connect(focus);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a', 'thumbnail') }); focus.noteSubmit();
    const { requestId } = (await call('thumbnail_begin', { projectId: 'a', kind: 'new' })).json;
    focus.claim({ pageId: 'page-aaaa', seq: 2, screen: screen('b', 'thumbnail') }); focus.noteSubmit();
    const read = (await call('thumbnail_read', { projectId: 'a', requestId })).json;
    const applied = await call('thumbnail_apply', { projectId: 'a', requestId, operationId: 'op-1', baseRevision: read.document.revision,
      ops: [{ type: 'add-layer', pageId: 'new', layer: { id: 't1', content: { kind: 'text', text: '飛ぶ' } } }] });
    expect(applied.json.status).toBe('saved');
    expect((await call('thumbnail_apply', { projectId: 'b', requestId, operationId: 'op-2', baseRevision: 0, ops: [] })).json.error.code).toBe('NOT_FOUND');
  });
  it('外からの接続（beginGuard なし）は依頼時点を確かめない', async () => {
    const { call } = await connect();
    expect((await call('thumbnail_begin', { projectId: 'a', kind: 'new' })).json.requestId).toMatch(/^d-/);
  });
  it('エラーは code・message・recovery を返す（知らない依頼番号は NOT_FOUND）', async () => {
    const { call } = await connect();
    const result = await call('thumbnail_runs', { projectId: 'a', requestId: 'inst-999' });
    expect(result.isError).toBe(true);
    expect(result.json.error).toEqual({ code: 'NOT_FOUND', message: expect.any(String), recovery: expect.stringContaining('依頼番号') });
  });
});
