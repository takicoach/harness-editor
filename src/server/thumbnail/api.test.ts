import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textLayer } from '../../core/thumbnail/fixtures';
import { SequenceStore } from '../sequence/store';
import { handleThumbnailApi } from './api';
import { ThumbnailExports } from './exports';
import { ThumbnailPreviews } from './previews';
import { ThumbnailRenderInputs } from './renderInputs';
import { ThumbnailService } from './service';
import { ThumbnailStore } from './store';

const projectId = 'api-case', service = new ThumbnailService();
let server: Server, origin = '', root = '', project = '';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'thumb-api-')); project = join(root, projectId); mkdirSync(project);
  new SequenceStore(project).save({ expectedSavedRevision: null, executionId: 'video', document: { schemaVersion: 2, id: 'video', name: '動画', revision: 0,
    fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [],
    ducking: { enabled: false, strength: 'mid' } } });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleThumbnailApi(req, res, url, root, { service, inputs: new ThumbnailRenderInputs(), exports: new ThumbnailExports(), previews: new ThumbnailPreviews() }).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); rmSync(root, { recursive: true, force: true }); });
async function call(route: string, body?: unknown, query = ''): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api/thumbnail${route}?id=${projectId}${query}`,
    body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
type State = { sessionId: string; document: { revision: number; pages: Array<{ id: string }> }; canUndo: boolean; savedRevision: number; replayed?: boolean };

describe('/api/thumbnail', () => {
  let state: State;
  it('まだ無ければ missing、作成すると案が 1 つ', async () => {
    expect(await call('')).toEqual({ status: 200, json: { status: 'missing', backupAvailable: false, preservedFiles: [] } });
    const created = await call('/create', { executionId: 'create-1' });
    expect(created.status).toBe(200);
    state = created.json as unknown as State;
    expect(state.document.pages).toHaveLength(1);
  });
  it('コマンドを実行し、不正な要求は状態を変えずに断る（受け入れ 4）', async () => {
    const pageId = state.document.pages[0]!.id;
    const added = await call('/command', { sessionId: state.sessionId, expectedRevision: 0, executionId: 'add-1', command: { type: 'add-layer', pageId, layer: textLayer('t') } });
    expect(added.status).toBe(200);
    state = added.json as unknown as State;
    let badCount = 0;
    const flags = (count: number) => ({ type: 'batch', commands: Array.from({ length: count }, () => ({ type: 'set-layer-flags', pageId, layerId: 't', hidden: true })) });
    for (const [command, message] of [[flags(51), 'まとめる編集操作が多すぎます'], [{ type: 'explode' }, '未対応の編集操作です'], [{ type: 'register-assets', assets: [] }, '未対応の編集操作です'],
      [{ type: 'add-layer', pageId, layer: { ...textLayer('bad'), visual: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 2 } } }, 'レイヤーの配置が不正です']] as const) {
      const rejected = await call('/command', { sessionId: state.sessionId, expectedRevision: 1, executionId: `bad-${String(++badCount)}`, command });
      expect(rejected.status).toBe(400);
      expect(String(rejected.json.error)).toContain(message);
    }
    expect((await call('/session/status', { sessionId: state.sessionId })).json).toMatchObject({ document: { revision: 1 }, canUndo: true });
  });
  it('保存の再送は二重保存にならず、動画の文書は変わらない', async () => {
    const videoFile = join(project, '.harness', 'project.v2.json'), before = readFileSync(videoFile);
    const body = { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 'save-1' };
    expect((await call('/save', body)).json).toMatchObject({ replayed: false, savedRevision: 1 });
    expect((await call('/save', body)).json).toMatchObject({ replayed: true, savedRevision: 1 });
    expect(readFileSync(videoFile).equals(before)).toBe(true);
  });
  it('衝突したら未保存の内容を退避して 409 を返す', async () => {
    const pageId = state.document.pages[0]!.id, store = new ThumbnailStore(project), outside = store.load();
    if (outside.kind !== 'ok') throw new Error('保存済みのサムネがありません');
    await call('/command', { sessionId: state.sessionId, expectedRevision: 1, executionId: 'add-2', command: { type: 'add-layer', pageId, layer: textLayer('u') } });
    store.save({ expectedSavedRevision: 1, executionId: 'outside', document: { ...outside.saved.document, revision: 2, pages: [{ ...outside.saved.document.pages[0]!, name: '外' }] } });
    const conflict = await call('/save', { sessionId: state.sessionId, expectedRevision: 2, expectedSavedRevision: 1, executionId: 'save-2' });
    expect(conflict.status).toBe(409);
    expect(existsSync(join(project, '.harness', String(conflict.json.evacuatedFile)))).toBe(true);
  });
  it('壊れたファイルは 409 THUMBNAIL_BROKEN、控えから戻せる', async () => {
    writeFileSync(new ThumbnailStore(project).file, 'broken');
    expect((await call('/session', {})).json).toMatchObject({ code: 'THUMBNAIL_BROKEN' });
    expect((await call('')).json).toMatchObject({ status: 'broken', backupAvailable: true });
    expect((await call('/recover', { choice: 'backup', executionId: 'recover-1' })).status).toBe(200);
  });
  it('画像以外の取り込みと、取り込んでいない素材の登録を断る', async () => {
    const upload = await fetch(`${origin}/api/thumbnail/upload?id=${projectId}&name=memo.txt`, { method: 'POST', body: 'x' });
    expect(upload.status).toBe(400);
    const session = (await call('/session', {})).json as unknown as State;
    const register = await call('/register', { sessionId: session.sessionId, expectedRevision: session.document.revision, executionId: 'reg', assetIds: ['nothing'] });
    expect(register.status).toBe(404);
  });
});
describe('/api/thumbnail/cover（プロジェクトのカードの画像）', () => {
  const cover = (query = '') => fetch(`${origin}/api/thumbnail/cover?id=${projectId}${query}`);
  const folder = () => join(project, 'サムネ');
  it('メインの書き出し サムネ/<案件名> サムネ.png だけを返す。無い・別名だけなら 404', async () => {
    rmSync(folder(), { recursive: true, force: true });
    expect((await cover()).status).toBe(404);
    mkdirSync(folder()); writeFileSync(join(folder(), `${projectId} サムネ 案B.png`), 'other');
    expect((await cover()).status).toBe(404);
    writeFileSync(join(folder(), `${projectId} サムネ.png`), 'main');
    // 余計な指定（ファイル名・相対パス）は見ない。
    const response = await cover('&file=../../outside.png&v=123');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(await response.text()).toBe('main');
  });
  it('JPEG は image/jpeg で返す。POST は受けない', async () => {
    rmSync(folder(), { recursive: true, force: true }); mkdirSync(folder());
    writeFileSync(join(folder(), `${projectId} サムネ.jpg`), 'jpeg');
    const response = await cover();
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(await response.text()).toBe('jpeg');
    expect((await fetch(`${origin}/api/thumbnail/cover?id=${projectId}`, { method: 'POST', body: '{}' })).status).toBe(405);
  });
  it('案件の外を指すリンク（ファイル・フォルダー）は返さない', async () => {
    const outside = join(root, 'outside.png'); writeFileSync(outside, 'secret');
    rmSync(folder(), { recursive: true, force: true }); mkdirSync(folder());
    symlinkSync(outside, join(folder(), `${projectId} サムネ.png`));
    expect((await cover()).status).toBe(404);
    const elsewhere = mkdtempSync(join(tmpdir(), 'thumb-api-outside-'));
    try {
      writeFileSync(join(elsewhere, `${projectId} サムネ.png`), 'secret');
      rmSync(folder(), { recursive: true, force: true }); symlinkSync(elsewhere, folder());
      const response = await cover();
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('secret');
    } finally { rmSync(folder(), { force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
  });
});
