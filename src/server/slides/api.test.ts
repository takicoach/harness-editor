import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { SequenceStore } from '../sequence/store';
import { handleSlidesApi } from './api';
import { SlidesService } from './service';

const service = new SlidesService(), ffmpeg = resolveFfmpegBin(), q = `?id=${encodeURIComponent('講義')}`;
let server: Server, origin = '', root = '';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'slides-api-'));
  const video = join(root, 'video-case'); mkdirSync(video);
  new SequenceStore(video).save({ expectedSavedRevision: null, executionId: 'video', document: { schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 },
    resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } } });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleSlidesApi(req, res, url, root, { service }).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server?.close(); rmSync(root, { recursive: true, force: true }); });
async function call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
type State = { sessionId: string; document: { revision: number; pages: Array<{ id: string }>; assets: Array<{ id: string }> }; savedRevision: number; dirty: boolean };

describe('/api/slides', () => {
  let state: State;
  it('スライド案件を作って一覧に出し、開く', async () => {
    expect(await call('/api/slides/projects/create', { name: '講義' })).toEqual({ status: 200, json: { id: '講義' } });
    expect((await call('/api/slides/projects')).json.projects).toEqual([expect.objectContaining({ id: '講義', status: 'ok', pages: 0 })]);
    expect((await call(`/api/slides${q}`)).json).toMatchObject({ status: 'saved', savedRevision: 0 });
    state = (await call(`/api/slides/session${q}`, {})).json as unknown as State;
    expect(state.document.pages).toEqual([]);
  });
  it('コマンドを適用し、不正な要求は状態を変えずに断る（AI だけが出す操作も /command では受けない）', async () => {
    const added = await call(`/api/slides/command${q}`, { sessionId: state.sessionId, expectedRevision: 0, executionId: 'add-1', command: { type: 'add-page', pageId: 'page-1', layout: 'points' } });
    expect(added.status).toBe(200);
    state = added.json as unknown as State;
    const notes = (count: number) => ({ type: 'batch', commands: Array.from({ length: count }, (_, i) => ({ type: 'set-notes', pageId: 'page-1', notes: String(i) })) });
    let n = 0;
    for (const [command, message] of [[notes(51), 'まとめる編集操作が多すぎます'], [{ type: 'explode' }, '未対応の編集操作です'],
      [{ type: 'register-assets', assets: [] }, '未対応の編集操作です'], [{ type: 'set-outline', runId: 'r1', outline: [], glossary: [], model: null }, '未対応の編集操作です'],
      [{ type: 'apply-page-bodies', runId: 'r1', bodies: [], failures: [], model: null }, '未対応の編集操作です'],
      [{ type: 'set-notes', pageId: 'page-1', notes: 'あ'.repeat(2001) }, '話すメモは 2000 文字までです']] as const) {
      const rejected = await call(`/api/slides/command${q}`, { sessionId: state.sessionId, expectedRevision: 1, executionId: `bad-${++n}`, command });
      expect(rejected.status).toBe(400);
      expect(String(rejected.json.error)).toContain(message);
    }
    expect(((await call(`/api/slides/session/status${q}`, { sessionId: state.sessionId })).json as unknown as State).document.revision).toBe(1);
  });
  it('保存する。動画の案件・無い ID・外へ出る ID はスライドとして扱わない', async () => {
    const saved = await call(`/api/slides/save${q}`, { sessionId: state.sessionId, expectedRevision: 1, expectedSavedRevision: 0, executionId: 'save-1' });
    expect(saved.json).toMatchObject({ dirty: false, savedRevision: 1 });
    expect((await call('/api/slides?id=video-case')).status).toBe(404);
    expect((await call('/api/slides?id=nothing')).status).toBe(404);
    expect((await call('/api/slides?id=..')).status).toBe(400);
  });
  it.skipIf(!ffmpeg.ok)('画像を取り込んで登録し、原本を配る。画像以外は断る', async () => {
    const png = join(root, 'red.png');
    if (ffmpeg.ok) execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', png]);
    const uploaded = await fetch(`${origin}/api/slides/upload${q}&name=red.png`, { method: 'POST', body: readFileSync(png) });
    const asset = (await uploaded.json() as { asset: { id: string; kind: string } }).asset;
    expect(asset.kind).toBe('image');
    const registered = await call(`/api/slides/register${q}`, { sessionId: state.sessionId, expectedRevision: 1, executionId: 'reg-1', assetIds: [asset.id] });
    expect((registered.json as unknown as State).document.assets.map(item => item.id)).toEqual([asset.id]);
    const served = await fetch(`${origin}/api/slides/asset${q}&asset=${asset.id}`);
    expect([served.status, served.headers.get('content-type')]).toEqual([200, 'image/png']);
    expect((await fetch(`${origin}/api/slides/upload${q}&name=memo.txt`, { method: 'POST', body: 'x' })).status).toBe(400);
  });
});
