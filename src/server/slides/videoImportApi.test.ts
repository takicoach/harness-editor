import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceDocument } from '../../core/sequence/model';
import type { SlideImportRecord } from '../../core/slides/videoImport';
import { sequenceService } from '../sequence/service';
import { SequenceStore } from '../sequence/store';
import { SlidesImportLedger } from './videoImport';
import { handleSlidesImportsApi } from './videoImportApi';

let server: Server, origin = '', root = '';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'slides-imports-api-'));
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleSlidesImportsApi(req, res, url, root).then(handled => { if (!handled) { res.statusCode = 404; res.end('{}'); } });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { server?.close(); rmSync(root, { recursive: true, force: true }); });

const FINGERPRINT = 'a'.repeat(64);
const videoDocument = (): SequenceDocument => ({ schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 },
  sequenceEndFrame: 30, background: '#000000', assets: [{ id: 'asset-1', kind: 'image', name: '講義_001.png', file: `.harness/assets/${FINGERPRINT}.png`, fingerprint: FINGERPRINT, streams: [] }],
  tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } });
/** 取り込み済み（素材は動画に登録済み）の記録を 1 件持つ動画案件を作る。 */
function setup() {
  const name = `video-${randomUUID().slice(0, 8)}`, directory = join(root, name); mkdirSync(directory);
  new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'seed', document: videoDocument() });
  const record: SlideImportRecord = { importId: `imp-${randomUUID()}`, createdAt: '2026-10-06T00:00:00.000Z', slides: { projectId: '講義', documentId: 'slides-1', revision: 1 },
    pages: [{ pageId: 'page-1', number: 1, assetId: 'asset-1', fingerprint: FINGERPRINT, contentHash: 'h1', name: '講義_001.png' }], placed: null };
  new SlidesImportLedger(directory).add(record);
  return { name, directory, record };
}
async function call(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
type Placed = { record: SlideImportRecord; state: { sessionId: string; replayed: boolean; appliedRevision: number; document: { revision: number; clips: Array<{ id: string }> } } };

describe('/api/slides-imports/place', () => {
  it('古い /placed（置かずに記録だけ付ける）は受け付けない', async () => {
    const ctx = setup();
    expect((await call(`/api/slides-imports/placed?id=${ctx.name}`, { importId: ctx.record.importId, videoRevision: 0, clipIds: ['c1'] })).status).toBe(404);
    expect(new SlidesImportLedger(ctx.directory).find(ctx.record.importId).placed).toBeNull();
  });
  it('動画側の版の衝突・外部変更は 409、操作の検証エラーは 400 で返す（500 にしない）', async () => {
    const ctx = setup(), state = sequenceService.open(ctx.directory);
    const tooFar = await call(`/api/slides-imports/place?id=${ctx.name}`, { importId: ctx.record.importId, sessionId: state.sessionId, expectedRevision: state.document.revision,
      executionId: 'place-far', at: Number.MAX_SAFE_INTEGER - 10 });
    expect(tooFar.status).toBe(400);
    expect(tooFar.json.code).toEqual(expect.any(String));
    // 外部で保存版が変わった（編集画面で読み直しが要る）。
    new SequenceStore(ctx.directory).save({ expectedSavedRevision: 0, executionId: 'external', document: { ...videoDocument(), revision: 1, name: '外で直した' } });
    const conflict = await call(`/api/slides-imports/place?id=${ctx.name}`, { importId: ctx.record.importId, sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'place-1' });
    expect(conflict.status).toBe(409);
    expect(conflict.json.code).toBe('REVISION_CONFLICT');
  });
  it('同じ executionId の再送は、置き直さずに再実行扱いの応答（結果の照会）を返す', async () => {
    const ctx = setup(), state = sequenceService.open(ctx.directory);
    const body = { importId: ctx.record.importId, sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'place-once' };
    const first = await call(`/api/slides-imports/place?id=${ctx.name}`, body);
    expect(first.status).toBe(200);
    const placed = first.json as unknown as Placed;
    expect(placed.state.replayed).toBe(false);
    expect(placed.state.document.clips.map(clip => clip.id)).toEqual(placed.record.placed!.clipIds);
    const again = await call(`/api/slides-imports/place?id=${ctx.name}`, body);
    expect(again.status).toBe(200);
    const replayed = again.json as unknown as Placed;
    expect(replayed.state.replayed).toBe(true);
    expect(replayed.state.appliedRevision).toBe(placed.state.appliedRevision);
    expect(replayed.record.placed!.clipIds).toEqual(placed.record.placed!.clipIds);
    expect(sequenceService.open(ctx.directory).document.clips).toHaveLength(1);
    // 別の executionId では置けない（もう置いてある）。
    const other = await call(`/api/slides-imports/place?id=${ctx.name}`, { ...body, expectedRevision: placed.state.document.revision, executionId: 'place-twice' });
    expect(other.status).toBe(409);
  });
  it('動画への実行が成功した後に記録の書き込みが失敗しても、次の読み込みで動画の文書から置いた記録を直し、2 回は置けない', async () => {
    const ctx = setup(), state = sequenceService.open(ctx.directory);
    vi.spyOn(SlidesImportLedger.prototype, 'markPlaced').mockImplementationOnce(() => { throw new Error('ディスクがいっぱいです'); });
    const first = await call(`/api/slides-imports/place?id=${ctx.name}`, { importId: ctx.record.importId, sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'place-a' });
    expect(first.status).toBe(200);
    const placed = first.json as unknown as Placed, clipIds = placed.state.document.clips.map(clip => clip.id);
    expect(clipIds).toHaveLength(1);
    expect(new SlidesImportLedger(ctx.directory).find(ctx.record.importId).placed).toBeNull();
    // 次の読み込み（一覧）で、動画の文書に残るクリップから置いた記録を直す。
    const listed = await call(`/api/slides-imports?id=${ctx.name}`);
    expect((listed.json.imports as SlideImportRecord[]).find(item => item.importId === ctx.record.importId)!.placed).toMatchObject({ clipIds, videoRevision: placed.state.document.revision });
    expect(new SlidesImportLedger(ctx.directory).find(ctx.record.importId).placed?.clipIds).toEqual(clipIds);
    const twice = await call(`/api/slides-imports/place?id=${ctx.name}`, { importId: ctx.record.importId, sessionId: state.sessionId, expectedRevision: placed.state.document.revision, executionId: 'place-b' });
    expect(twice.status).toBe(409);
    expect(sequenceService.open(ctx.directory).document.clips).toHaveLength(1);
  });
  it('記録が書けず一覧も読まれないまま置き直そうとしても、動画の文書から照合して断る', async () => {
    const ctx = setup(), state = sequenceService.open(ctx.directory);
    vi.spyOn(SlidesImportLedger.prototype, 'markPlaced').mockImplementationOnce(() => { throw new Error('ディスクがいっぱいです'); });
    const first = await call(`/api/slides-imports/place?id=${ctx.name}`, { importId: ctx.record.importId, sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'place-c' });
    expect(first.status).toBe(200);
    const revision = (first.json as unknown as Placed).state.document.revision;
    const twice = await call(`/api/slides-imports/place?id=${ctx.name}`, { importId: ctx.record.importId, sessionId: state.sessionId, expectedRevision: revision, executionId: 'place-d' });
    expect(twice.status).toBe(409);
    expect(sequenceService.open(ctx.directory).document.clips).toHaveLength(1);
  });
});
