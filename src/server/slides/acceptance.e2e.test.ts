import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startEditorServer } from '../../../scripts/native-render-capture';
import { SLIDES_OUTLINE_SCHEMA } from '../../core/slides/contract';
import { pageFit } from '../../core/slides/fit';
import { pageBody, scriptText } from '../../core/slides/fixtures';
import { SLIDE_LAYOUT_IDS, type SlideDocument, type SlideLayoutId } from '../../core/slides/model';
import { SLIDE_THEMES } from '../../core/slides/themes';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { SequenceStore } from '../sequence/store';
import type { SlidesExportStatus } from './exports';
import { createSlidesProject } from './projects';

const available = resolveNativeChromiumBin().ok && resolveFfmpegBin().ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('スライドの受け入れの通しに Chromium と FFmpeg が必要です');
type Json = { [key: string]: any };
type State = { sessionId: string; document: SlideDocument; savedRevision: number };
const layoutOf = (key: string): SlideLayoutId => SLIDE_LAYOUT_IDS[(Number(key.slice(1)) - 1) % 6]!;
const KEYS = Array.from({ length: 15 }, (_, i) => `s${i + 1}`);
let root = '', server: Awaited<ReturnType<typeof startEditorServer>> | undefined, client: Client | undefined, transport: StreamableHTTPClientTransport | undefined;
beforeAll(async () => {
  if (!available) return;
  root = mkdtempSync(join(tmpdir(), 'slides-accept-')); createSlidesProject(root, '講義');
  const video = join(root, 'video-case'); mkdirSync(video);
  new SequenceStore(video).save({ expectedSavedRevision: null, executionId: 'v', document: { schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 },
    resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } } });
  server = await startEditorServer(process.cwd(), root);
  client = new Client({ name: 'acceptance', version: '0.0.0' }); transport = new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`));
  await client.connect(transport);
}, 120_000);
afterAll(async () => { await transport?.terminateSession().catch(() => {}); await client?.close(); await server?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });
async function http<T>(route: string, body?: unknown, expected = 200): Promise<T> {
  const response = await fetch(`${server!.origin}/api/slides${route}${route.includes('?') ? '&' : '?'}id=${encodeURIComponent('講義')}`,
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (response.status !== expected) throw new Error(`${route}: ${response.status} ${JSON.stringify(json)}`);
  return json as T;
}
async function tool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: Json }> {
  const result = await client!.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, json: JSON.parse(result.content[0]!.text) as Json };
}
async function target() {
  const read = (await tool('slides_read', { projectId: '講義' })).json;
  return { projectId: '講義', documentId: read.documentId as string, sessionId: read.sessionId as string, expectedRevision: read.revision as number };
}
/** 人の操作（画面と同じ /command → /save）。 */
async function human(command: unknown): Promise<State> {
  let state = await http<State>('/session', {});
  state = await http<State>('/command', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), command });
  return http<State>('/save', { sessionId: state.sessionId, expectedRevision: state.document.revision, expectedSavedRevision: state.savedRevision, executionId: crypto.randomUUID() });
}
const slot = (document: SlideDocument, key: string, name: string) => {
  const page = document.pages.find(item => item.outlineKey === key)!;
  return { page, layer: page.layers.find(layer => page.bindings[layer.id]?.slot === name)! };
};

describe.skipIf(!available)('スライド 段階 1 の受け入れ（画面なしの通し）', () => {
  let runId = '';
  it('[1] 不正な構成案は MCP と貼り付けの両方で拒否し、文書が変わらない', async () => {
    await human({ type: 'set-script', text: scriptText(45) });
    const t = await target(), before = (await http<State>('/session', {})).document;
    const bad = { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: [{ key: 's1', layout: 'cover', title: '表紙', sourceParagraphIds: ['p1', 'p99'] }] };
    expect((await tool('slides_apply_outline', { ...t, operationId: 'bad-mcp', payload: bad })).json).toMatchObject({ status: 'rejected', route: 'mcp' });
    expect(await http<Json>('/apply', { ...t, kind: 'outline', operationId: 'bad-paste', payload: bad })).toMatchObject({ status: 'rejected', route: 'paste' });
    expect((await http<State>('/session', {})).document).toEqual(before);
  });
  it('[2] 段落 45 を数ページずつ作り、再送・中止・再開しても二重にならず、全段落がどれか 1 ページに入る', async () => {
    const outline = { schema: SLIDES_OUTLINE_SCHEMA, glossary: [{ term: 'グリップ', note: 'カタカナで書く' }],
      pages: KEYS.map((key, index) => ({ key, layout: layoutOf(key), title: `ページ ${index + 1}`, sourceParagraphIds: [1, 2, 3].map(n => `p${index * 3 + n}`) })) };
    const applied = (await tool('slides_apply_outline', { ...await target(), operationId: 'outline', model: 'acceptance', payload: outline })).json;
    runId = applied.runId;
    await human({ type: 'confirm-outline' });
    const chunk = (from: number) => KEYS.slice(from, from + 6).map(key => pageBody(key, layoutOf(key)));
    const t = await target(), first = (await tool('slides_apply_pages', { ...t, operationId: 'c0', runId, payload: chunk(0) })).json;
    expect((await tool('slides_apply_pages', { ...t, operationId: 'c0', runId, payload: chunk(0) })).json).toMatchObject({ replayed: true, revision: first.revision });
    await tool('slides_cancel', { ...await target(), operationId: 'stop', runId });
    await human({ type: 'resume-generation', runId });
    for (const from of [6, 12]) expect((await tool('slides_apply_pages', { ...await target(), operationId: `c${from}`, runId, payload: chunk(from) })).json.status).toBe('applied');
    const document = (await http<State>('/session', {})).document;
    expect(document.generation!.status).toBe('complete');
    expect(document.pages).toHaveLength(15);
    expect(document.pages.flatMap(page => page.sourceParagraphIds).sort()).toEqual(document.script.paragraphs.map(paragraph => paragraph.id).sort());
  });
  it('[3] 手で直したページは、作り直しで上書きされず置き換え案になる', async () => {
    const { page, layer } = slot((await http<State>('/session', {})).document, 's3', 'heading');
    if (layer.content.kind !== 'text') throw new Error('見出しが文字ではありません');
    await human({ type: 'update-layer', pageId: page.id, layerId: layer.id, patch: { content: { ...layer.content, text: '手で直した見出し' } } });
    const result = (await tool('slides_apply_pages', { ...await target(), operationId: 'regen-s3', runId, regenerate: true, payload: [pageBody('s3', 'points')] })).json;
    expect(result.pages[0]).toMatchObject({ key: 's3', result: 'proposal' });
    const document = (await http<State>('/session', {})).document, after = slot(document, 's3', 'heading').layer;
    expect(after.content.kind === 'text' && after.content.text).toBe('手で直した見出し');
    expect(document.generation!.pages.find(page => page.key === 's3')!.proposal).toBeDefined();
  });
  it('[4] テーマを変えると色と書体だけが変わり、各レイヤーの位置は変わらない', async () => {
    const before = (await http<State>('/session', {})).document, after = (await human({ type: 'set-theme', theme: { id: 'white-navy' } })).document;
    expect(after.pages.map(page => page.layers.map(layer => [layer.id, layer.visual]))).toEqual(before.pages.map(page => page.layers.map(layer => [layer.id, layer.visual])));
    expect(after.pages.flatMap(page => page.layers).some(layer => layer.content.kind === 'text' && layer.content.appearance.color === SLIDE_THEMES['white-navy'].colors.text)).toBe(true);
  });
  it('[5] 最小文字サイズで収まらない文字は「収まらない」と出る（大きさは最小を下回らない）', async () => {
    const { page, layer } = slot((await http<State>('/session', {})).document, 's5', 'left-body');
    if (layer.content.kind !== 'text') throw new Error('本文が文字ではありません');
    const document = (await human({ type: 'update-layer', pageId: page.id, layerId: layer.id, patch: { content: { ...layer.content, text: 'あ'.repeat(300) } } })).document;
    const fit = pageFit(document.pages.find(item => item.id === page.id)!);
    expect(fit).toMatchObject({ status: 'overflow', suggestions: ['shorten', 'layout'] });
    // AI の本文から組んだ文字は、自動で縮めても最小文字サイズを下回らない（人が直した 1 枚以外の全ページ）。
    expect(document.pages.filter(item => item.id !== page.id).flatMap(item => pageFit(item).slots).every(item => item.fontSize >= item.minFontSize)).toBe(true);
  });
  it('[6] 表示用 PDF のページ数が文書と一致する', async () => {
    const state = await http<State>('/session', {}), executionId = crypto.randomUUID();
    let status = await http<SlidesExportStatus>('/export', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId, format: 'pdf' });
    while (['checking', 'rendering', 'composing'].includes(status.phase)) { await new Promise(resolve => setTimeout(resolve, 300)); status = await http(`/export/status?executionId=${executionId}`); }
    expect(status.phase).toBe('complete');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(root, '講義', status.files![0]!))), isOffscreenCanvasSupported: false }).promise;
    expect(pdf.numPages).toBe(state.document.pages.length);
  }, 240_000);
  it('[7] 動画に取り込んだ画像は、取り込み時の版が記録される', async () => {
    const state = await http<State>('/session', {});
    const record = await http<Json>('/video-import', { sessionId: state.sessionId, videoProjectId: 'video-case', pageIds: [state.document.pages[0]!.id] });
    expect(record.slides).toEqual({ projectId: '講義', documentId: state.document.id, revision: state.document.revision });
  }, 120_000);
});
