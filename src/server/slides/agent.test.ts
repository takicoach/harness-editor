import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SLIDES_OUTLINE_SCHEMA } from '../../core/slides/contract';
import { pageBody, scriptText } from '../../core/slides/fixtures';
import { SLIDE_LAYOUT_IDS, type SlideLayoutId, type SlideOutlinePage } from '../../core/slides/model';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { importSequenceAsset, registeredSequenceAssets } from '../sequence/assets';
import { SlidesAgent, SlidesAgentError } from './agent';
import { createSlidesProject } from './projects';
import { SlidesService } from './service';
import { SlidesStore } from './store';

const roots: string[] = [], ffmpeg = resolveFfmpegBin();
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(paragraphs = 9) {
  const root = mkdtempSync(join(tmpdir(), 'slides-agent-')); roots.push(root);
  const { id } = createSlidesProject(root, '講義'), service = new SlidesService(), agent = new SlidesAgent(() => root, service), directory = join(root, id);
  const opened = service.open(directory);
  service.execute(directory, { sessionId: opened.sessionId, expectedRevision: 0, executionId: 'script', command: { type: 'set-script', text: scriptText(paragraphs) } });
  return { root, directory, service, agent, projectId: id };
}
type Ctx = ReturnType<typeof setup>;
const layoutOf = (key: string): SlideLayoutId => SLIDE_LAYOUT_IDS[(Number(key.slice(1)) - 1) % 6]!;
function outline(count: number, perPage: number): { schema: string; glossary: []; pages: SlideOutlinePage[] } {
  return { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: Array.from({ length: Math.ceil(count / perPage) }, (_, index) => ({ key: `s${index + 1}`, layout: layoutOf(`s${index + 1}`),
    title: `ページ ${index + 1}`, sourceParagraphIds: Array.from({ length: perPage }, (_, n) => index * perPage + n + 1).filter(n => n <= count).map(n => `p${n}`) })) };
}
function target(ctx: Ctx) {
  const read = ctx.agent.read(ctx.projectId) as { documentId: string; sessionId: string; revision: number };
  return { projectId: ctx.projectId, documentId: read.documentId, sessionId: read.sessionId, expectedRevision: read.revision };
}
const saved = (ctx: Ctx) => { const load = new SlidesStore(ctx.directory).load(); if (load.kind !== 'ok') throw new Error('保存がありません'); return load.saved; };
/** 人が画面で「この構成で作る」を押した（保存まで）。 */
function humanConfirm(ctx: Ctx): void {
  const t = target(ctx);
  ctx.service.agentApply(ctx.directory, { sessionId: t.sessionId, expectedRevision: t.expectedRevision, executionId: `confirm-${t.expectedRevision}`, command: { type: 'confirm-outline' } });
}
async function ready(paragraphs = 9) {
  const ctx = setup(paragraphs), result = ctx.agent.applyOutline({ ...target(ctx), operationId: 'outline', route: 'mcp', payload: outline(paragraphs, 3) });
  return { ctx, runId: result.runId! };
}

describe('構成案（受け入れ 1：拒否したら文書を変えない）', () => {
  const base = outline(9, 3), first = (change: Partial<SlideOutlinePage>) => ({ ...base, pages: base.pages.map((page, i) => i === 0 ? { ...page, ...change } : page) });
  it.each([
    ['版違い', { ...base, schema: 'harness-slides-outline/9' }, 'SCHEMA_VERSION'],
    ['段落の欠落', { ...base, pages: base.pages.slice(0, 2) }, 'MISSING'],
    ['段落の重複', first({ sourceParagraphIds: ['p1', 'p2', 'p3', 'p4'] }), 'DUPLICATE'],
    ['存在しない段落', first({ sourceParagraphIds: ['p1', 'p2', 'p3', 'p99'] }), 'UNKNOWN_PARAGRAPH'],
    ['文字数超え', first({ title: 'あ'.repeat(61) }), 'TOO_LONG'],
    ['知らないレイアウト', first({ layout: 'hero' as never }), 'UNKNOWN_LAYOUT'],
  ])('%s の構成案は拒否し、文書を変えない', (_label, payload, code) => {
    const ctx = setup(), before = target(ctx), document = ctx.service.inspect(ctx.directory, before.sessionId).document;
    const result = ctx.agent.applyOutline({ ...before, operationId: 'op-bad', route: 'paste', payload });
    expect(result.status).toBe('rejected');
    expect(result.issues.map(issue => issue.code)).toContain(code);
    expect(ctx.service.inspect(ctx.directory, before.sessionId).document).toEqual(document);
  });
  it('正しい構成案は 1 回の Undo で適用して保存する。同じ operationId の再送は再実行せず、中身が違えば断る', () => {
    const ctx = setup(), t = target(ctx);
    const result = ctx.agent.applyOutline({ ...t, operationId: 'op-1', route: 'mcp', model: 'claude', payload: outline(9, 3) });
    expect(result).toMatchObject({ status: 'applied', replayed: false, revision: t.expectedRevision + 1, savedRevision: t.expectedRevision + 1 });
    expect(saved(ctx).document.generation).toMatchObject({ runId: result.runId, status: 'outline', model: 'claude' });
    expect(ctx.agent.applyOutline({ ...t, operationId: 'op-1', route: 'mcp', model: 'claude', payload: outline(9, 3) })).toMatchObject({ replayed: true, runId: result.runId });
    expect(saved(ctx).savedRevision).toBe(t.expectedRevision + 1);
    expect(() => ctx.agent.applyOutline({ ...t, operationId: 'op-1', route: 'mcp', payload: outline(9, 9) })).toThrow(SlidesAgentError);
  });
});

describe('ページ本文', () => {
  it('構成案が確定する前は受け取らず、次にすることを返す', async () => {
    const { ctx, runId } = await ready();
    await expect(ctx.agent.applyPages({ ...target(ctx), operationId: 'p1', route: 'mcp', runId, payload: [pageBody('s1', 'cover')] }))
      .rejects.toMatchObject({ code: 'RUN_STATE', recovery: expect.stringContaining('この構成で作る') });
  });
  it('成功したページは残し、不正なページだけ位置と理由を返す。修復は 1 ページにつき 2 回まで', async () => {
    const { ctx, runId } = await ready(); humanConfirm(ctx);
    const bad = { ...pageBody('s2', 'chapter'), fields: { number: '01' } };
    let result = await ctx.agent.applyPages({ ...target(ctx), operationId: 'try-1', route: 'mcp', runId, payload: [pageBody('s1', 'cover'), bad] });
    expect(result.status).toBe('partial');
    expect(result.pages.map(page => [page.key, page.result, page.attempts])).toEqual([['s1', 'applied', 0], ['s2', 'rejected', 1]]);
    expect(result.pages[1]!.issues[0]).toMatchObject({ path: '[1].fields.title', code: 'REQUIRED' });
    const revision = target(ctx).expectedRevision;
    result = await ctx.agent.applyPages({ ...target(ctx), operationId: 'try-2', route: 'mcp', runId, payload: [bad] });
    expect([result.status, result.pages[0]!.result, result.pages[0]!.attempts, target(ctx).expectedRevision]).toEqual(['rejected', 'rejected', 2, revision]);
    result = await ctx.agent.applyPages({ ...target(ctx), operationId: 'try-3', route: 'mcp', runId, payload: [bad] });
    expect([result.pages[0]!.result, result.pages[0]!.attempts]).toEqual(['failed', 3]);
    expect(saved(ctx).document.generation!.pages[1]).toMatchObject({ status: 'failed', reasons: ['[0].fields.title: 章名がありません'] });
  });
  it('版が古い要求は断る（人の編集と重なったとき）。文書 ID・セッションの食い違いも断る', async () => {
    const { ctx, runId } = await ready(); humanConfirm(ctx);
    const old = target(ctx);
    ctx.service.execute(ctx.directory, { sessionId: old.sessionId, expectedRevision: old.expectedRevision, executionId: 'human',
      command: { type: 'set-notes', pageId: saved(ctx).document.pages[0]!.id, notes: '人' } });
    await expect(ctx.agent.applyPages({ ...old, operationId: 'late', route: 'mcp', runId, payload: [pageBody('s1', 'cover')] })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(ctx.agent.applyPages({ ...target(ctx), documentId: 'other', operationId: 'doc', route: 'mcp', runId, payload: [pageBody('s1', 'cover')] })).rejects.toMatchObject({ code: 'DOCUMENT_MISMATCH' });
    await expect(ctx.agent.applyPages({ ...target(ctx), sessionId: 'gone', operationId: 'sess', route: 'mcp', runId, payload: [pageBody('s1', 'cover')] })).rejects.toMatchObject({ code: 'SESSION_CHANGED' });
  });
  it.skipIf(!ffmpeg.ok)('MCP の経路は画像ファイルを取り込んで画像枠に置く。貼り付けの経路では受け取らず、枠を空けたまま知らせる', async () => {
    const { ctx, runId } = await ready(30); humanConfirm(ctx);
    const png = join(ctx.directory, 'photo.png');
    if (ffmpeg.ok) execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=80x60', '-frames:v', '1', png]);
    // s4 は 4 番目のレイアウト（image-text）。
    const body = { ...pageBody('s4', 'image-text'), imageSlots: [{ slot: 'image', prompt: '構えの写真', file: png }] };
    const page = () => saved(ctx).document.pages.find(item => item.outlineKey === 's4')!;
    const viaPaste = await ctx.agent.applyPages({ ...target(ctx), operationId: 'paste-1', route: 'paste', runId, payload: [body] });
    expect(viaPaste.pages[0]!.notes[0]).toContain('貼り付けの経路では受け取れません');
    expect(page().layers.some(layer => layer.content.kind === 'image')).toBe(false);
    const viaMcp = await ctx.agent.applyPages({ ...target(ctx), operationId: 'mcp-1', route: 'mcp', runId, regenerate: true, payload: [body] });
    expect(viaMcp.pages[0]).toMatchObject({ result: 'applied', notes: [] });
    expect(page().layers.find(layer => layer.content.kind === 'image')).toMatchObject({ content: { kind: 'image', role: 'element' } });
  });
  it('MCP の画像は案件フォルダ・ホームの中だけを取り込む。中身が画像でないファイルは素材台帳に登録しない', async () => {
    const { ctx, runId } = await ready(30); humanConfirm(ctx);
    const imported: string[] = [];
    const agent = new SlidesAgent(() => ctx.root, ctx.service, async (directory, file) => { imported.push(file); return importSequenceAsset(directory, file); }, directory => [directory]);
    const outside = join(ctx.root, 'outside.png'), link = join(ctx.directory, 'link.png'), fake = join(ctx.directory, 'fake.png');
    writeFileSync(outside, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]));
    symlinkSync(outside, link);
    writeFileSync(fake, 'これは画像ではありません');
    const cases: Array<[string, string]> = [[outside, '案件フォルダ'], [link, '案件フォルダ'], [fake, '画像として読み込めません']];
    for (const [index, [file, message]] of cases.entries()) {
      const result = await agent.applyPages({ ...target(ctx), operationId: `image-${index}`, route: 'mcp', runId, regenerate: index > 0,
        payload: [{ ...pageBody('s4', 'image-text'), imageSlots: [{ slot: 'image', prompt: '構えの写真', file }] }] });
      expect(result.pages[0]!.notes[0]).toContain(message);
    }
    expect(imported).toEqual([]);
    expect(await registeredSequenceAssets(ctx.directory)).toEqual([]);
  });
  it('段落 45：数ページずつ作り、途中で再送・中止・再開しても二重にならず、全段落がどれか 1 ページに入る（受け入れ 2）', async () => {
    const { ctx, runId } = await ready(45); humanConfirm(ctx);
    const keys = Array.from({ length: 15 }, (_, i) => `s${i + 1}`), chunk = (from: number) => keys.slice(from, from + 6).map(key => pageBody(key, layoutOf(key)));
    const first = await ctx.agent.applyPages({ ...target(ctx), operationId: 'chunk-1', route: 'mcp', runId, payload: chunk(0) });
    // 接続が切れて結果が届かなかった想定: 同じ operationId・同じ内容で送り直しても二重にならない。
    const resent = await ctx.agent.applyPages({ ...target(ctx), expectedRevision: first.revision - 1, operationId: 'chunk-1', route: 'mcp', runId, payload: chunk(0) });
    expect(resent).toMatchObject({ replayed: true, revision: first.revision });
    expect(ctx.agent.runs(ctx.projectId, { operationId: 'chunk-1' })).toMatchObject({ operation: { status: 'applied', operationId: 'chunk-1' } });
    ctx.agent.cancel({ ...target(ctx), operationId: 'stop', route: 'mcp', runId });
    await expect(ctx.agent.applyPages({ ...target(ctx), operationId: 'chunk-2', route: 'mcp', runId, payload: chunk(6) })).rejects.toMatchObject({ code: 'RUN_STATE' });
    const t = target(ctx);
    ctx.service.agentApply(ctx.directory, { sessionId: t.sessionId, expectedRevision: t.expectedRevision, executionId: 'resume', command: { type: 'resume-generation', runId } });
    const again = await ctx.agent.applyPages({ ...target(ctx), operationId: 'chunk-1-again', route: 'mcp', runId, payload: chunk(0) });
    expect(again.pages.every(page => page.result === 'rejected' && page.issues.some(issue => issue.code === 'ALREADY_GENERATED'))).toBe(true);
    for (const from of [6, 12]) await ctx.agent.applyPages({ ...target(ctx), operationId: `chunk-${from}`, route: 'mcp', runId, payload: chunk(from) });
    const document = saved(ctx).document;
    expect(document.generation!.status).toBe('complete');
    expect(document.pages).toHaveLength(15);
    expect(document.pages.flatMap(page => page.sourceParagraphIds).sort()).toEqual(document.script.paragraphs.map(paragraph => paragraph.id).sort());
  });
});
