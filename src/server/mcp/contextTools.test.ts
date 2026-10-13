import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AiScreen } from '../../shared/aiFocus';
import type { EditorSessionSummary } from '../../shared/editorSessions';
import { AiFocusRegistry } from '../aiFocus';
import { registerContextTools } from './contextTools';

const clients: Client[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); });
const screen = (projectId: string, mode: AiScreen['mode']): AiScreen => ({ projectId, projectName: `名前-${projectId}`, mode,
  target: mode === 'video' ? { kind: 'video', editorSessionId: `w-${projectId}` } : mode === 'slides' ? { kind: 'slides', documentId: 'd', sessionId: 's', revision: 2 }
    : { kind: 'thumbnail', documentId: 't', sessionId: 's', revision: 0, pageId: 'p1' }, playheadSec: mode === 'video' ? 3 : null, selection: [], materials: '素材 1 件' });
const session: EditorSessionSummary = { sessionId: 'w-a', status: 'ready', projectId: 'a', revision: 'r1', dirty: false, saving: false, humanBusy: false, elementCount: 2, expiresAt: 9, mode: 'video' };
async function connect(focus: AiFocusRegistry) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerContextTools(server, { focus, sessions: () => [session] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport); clients.push(client);
  return async () => JSON.parse(((await client.callTool({ name: 'editor_context', arguments: {} })) as { content: Array<{ text: string }> }).content[0]!.text);
}

describe('editor_context', () => {
  it.each(['video', 'slides', 'thumbnail'] as const)('モード %s: 今の画面・書き込み先・使える道具を返す', async (mode) => {
    const focus = new AiFocusRegistry(() => 1000, 15000), read = await connect(focus);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a', mode) });
    focus.noteSubmit();
    const result = await read();
    expect(result.screen).toMatchObject({ projectId: 'a', mode, label: expect.stringContaining('名前-a') });
    expect(result.screen.target.kind).toBe(mode);
    expect(result.tools).toContain(mode === 'slides' ? 'slides_apply_pages' : mode === 'thumbnail' ? 'thumbnail_apply' : 'editor_apply');
    expect(result.tools).toContain('editor_context');
    expect(result.switchedSinceRequest).toBe(false);
    if (mode === 'video') expect(result.screen.editorSession).toMatchObject({ sessionId: 'w-a', revision: 'r1' });
    // 動画をメインに取り込む道具も使える道具として載る（editor_guide('video') が案内する道具と一致させる）。
    if (mode === 'video') expect(result.tools).toEqual(expect.arrayContaining(['editor_import_media', 'editor_import_runs', 'editor_import_cancel']));
  });
  it('主画面が無ければ screen は null で、推測しないよう next で伝える', async () => {
    const result = await (await connect(new AiFocusRegistry(() => 1000, 15000)))();
    expect(result).toMatchObject({ screen: null, request: null, switchedSinceRequest: false, tools: ['editor_context', 'editor_guide', 'report_instruction_status'] });
    expect(result.next).toContain('推測で案件を決めない');
  });
  it('画面が複数あっても、AI タブを開いた画面（主画面）だけを返す', async () => {
    const focus = new AiFocusRegistry(() => 1000, 15000), read = await connect(focus);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a', 'video') });
    focus.beat({ pageId: 'page-bbbb', seq: 1, screen: screen('b', 'slides') });
    expect((await read()).screen.projectId).toBe('a');
  });
  it('依頼の後に別の案件へ移ったら switchedSinceRequest。同じ案件の中のモードの移動は modeChangedSinceRequest だけ', async () => {
    const focus = new AiFocusRegistry(() => 1000, 15000), read = await connect(focus);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a', 'video') });
    focus.noteSubmit();
    focus.beat({ pageId: 'page-aaaa', seq: 2, screen: screen('a', 'thumbnail') });
    expect(await read()).toMatchObject({ switchedSinceRequest: false, modeChangedSinceRequest: true, request: { projectId: 'a', mode: 'video' } });
    focus.beat({ pageId: 'page-aaaa', seq: 3, screen: screen('b', 'slides') });
    const switched = await read();
    expect(switched).toMatchObject({ switchedSinceRequest: true, modeChangedSinceRequest: false });
    expect(switched.next).toContain('どちらを直すか利用者に確かめて');
  });
  it('呼ばれた時の主画面を「AI が最後に確認」に残す', async () => {
    const focus = new AiFocusRegistry(() => 1000, 15000), read = await connect(focus);
    focus.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a', 'slides') });
    await read();
    expect(focus.view().lastRead).toMatchObject({ projectId: 'a', mode: 'slides' });
  });
});
