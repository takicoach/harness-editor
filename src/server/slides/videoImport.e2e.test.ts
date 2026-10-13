import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEditorServer } from '../../../scripts/native-render-capture';
import type { SlideDocument } from '../../core/slides/model';
import type { SlideImportRecord } from '../../core/slides/videoImport';
import { slidesFixture } from '../../core/slides/fixtures';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { registeredSequenceAssets } from '../sequence/assets';
import { SequenceStore } from '../sequence/store';
import { SlidesStore } from './store';

const available = resolveNativeChromiumBin().ok && resolveFfmpegBin().ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('動画への取り込みの検証に Chromium と FFmpeg が必要です');
let root = '', video = '', server: Awaited<ReturnType<typeof startEditorServer>> | undefined;
beforeAll(async () => {
  if (!available) return;
  root = mkdtempSync(join(tmpdir(), 'slides-video-import-'));
  const slides = join(root, 'slides-case'); mkdirSync(slides); video = join(root, 'video-case'); mkdirSync(video);
  new SlidesStore(slides).save({ expectedSavedRevision: null, executionId: 'seed', document: slidesFixture() });
  new SequenceStore(video).save({ expectedSavedRevision: null, executionId: 'v', document: { schemaVersion: 2, id: 'video', name: '動画', revision: 0, fps: { num: 30, den: 1 },
    resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30, background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } } });
  server = await startEditorServer(process.cwd(), root);
}, 120_000);
afterAll(async () => { await server?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });
async function call<T>(path: string, body?: unknown, expected = 200): Promise<T> {
  const response = await fetch(`${server!.origin}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  if (response.status !== expected) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  return json as T;
}
type State = { sessionId: string; document: SlideDocument; savedRevision: number };
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe.skipIf(!available)('動画案件への取り込み（受け入れ 7）', () => {
  it('取り込んだ画像は新しい素材で、取り込み時の版が記録され、スライドを直しても変わらない', async () => {
    let state = await call<State>('/api/slides/session?id=slides-case', {});
    const first = await call<SlideImportRecord>('/api/slides/video-import?id=slides-case', { sessionId: state.sessionId, videoProjectId: 'video-case', pageIds: ['page-1', 'page-2'] });
    expect(first.slides).toEqual({ projectId: 'slides-case', documentId: state.document.id, revision: state.document.revision });
    expect(first.pages.map(page => [page.pageId, page.number, page.name])).toEqual([['page-1', 1, 'slides-case_001.png'], ['page-2', 2, 'slides-case_002.png']]);
    const registry = await registeredSequenceAssets(video), files = first.pages.map(page => join(video, registry.find(asset => asset.id === page.assetId)!.file)), before = files.map(sha);
    // スライドを直して保存する（2 ページ目の見出しを変える）。
    const page = state.document.pages[1]!, heading = page.layers.find(layer => page.bindings[layer.id]?.slot === 'heading')!;
    if (heading.content.kind !== 'text') throw new Error('見出しが文字ではありません');
    state = await call<State>('/api/slides/command?id=slides-case', { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'edit',
      command: { type: 'update-layer', pageId: page.id, layerId: heading.id, patch: { content: { ...heading.content, text: '直した見出し' } } } });
    await call<State>('/api/slides/save?id=slides-case', { sessionId: state.sessionId, expectedRevision: state.document.revision, expectedSavedRevision: state.savedRevision, executionId: 'save' });
    expect(files.map(sha)).toEqual(before);
    expect((await call<{ imports: SlideImportRecord[] }>('/api/slides-imports?id=video-case')).imports).toEqual([first]);
    // もう一度取り込むと、直したページは別の新しい素材になり、前の素材は残る。
    state = await call<State>('/api/slides/session?id=slides-case', {});
    const second = await call<SlideImportRecord>('/api/slides/video-import?id=slides-case', { sessionId: state.sessionId, videoProjectId: 'video-case', pageIds: ['page-2'] });
    expect(second.slides.revision).toBe(state.document.revision);
    expect(second.pages[0]!.fingerprint).not.toBe(first.pages[1]!.fingerprint);
    expect(files.every(file => existsSync(file))).toBe(true);
    expect(files.map(sha)).toEqual(before);
    // 置く操作は動画の編集履歴に入る（元に戻せる）。置いた記録は 1 回だけで、元に戻したら置き直せる。
    type Seq = { sessionId: string; document: { revision: number; clips: Array<{ id: string; content: { kind: string } }>; tracks: unknown[] } };
    const place = (seq: Seq, executionId: string, importId: string, expected = 200) => call<{ record: SlideImportRecord; state: Seq }>('/api/slides-imports/place?id=video-case',
      { importId, sessionId: seq.sessionId, expectedRevision: seq.document.revision, executionId }, expected);
    let seq = await call<Seq>('/api/sequence/session?id=video-case', {});
    const placed = await place(seq, 'place-1', first.importId);
    expect(placed.state.document.clips.map(clip => clip.id)).toEqual(placed.record.placed!.clipIds);
    expect(placed.state.document.clips).toHaveLength(2);
    seq = placed.state;
    await place(seq, 'place-2', first.importId, 409);
    seq = await call<Seq>('/api/sequence/command?id=video-case', { sessionId: seq.sessionId, expectedRevision: seq.document.revision, executionId: 'undo-1', command: { type: 'undo' } });
    expect(seq.document.clips).toHaveLength(0);
    const again = await place(seq, 'place-3', first.importId);
    expect(again.state.document.clips).toHaveLength(2);
    expect(again.record.placed!.clipIds).not.toEqual(placed.record.placed!.clipIds);
    expect((await call<{ imports: SlideImportRecord[] }>('/api/slides-imports?id=video-case')).imports.find(item => item.importId === first.importId)!.placed!.clipIds).toEqual(again.record.placed!.clipIds);
  }, 180_000);
});
