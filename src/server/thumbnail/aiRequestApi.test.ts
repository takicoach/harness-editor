import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { VIDEO_ASSET } from '../../core/thumbnail/fixtures';
import type { ThumbnailAiButtonInput } from '../../shared/thumbnailAi';
import { createInstructionInbox } from '../instructionInbox';
import { SequenceStore } from '../sequence/store';
import { ThumbnailAgent } from './agent';
import { ThumbnailAiRequestStore } from './aiRequests';
import { createThumbnailAiButtonRequest, thumbnailAiLatest, type ThumbnailAiApiDeps } from './aiRequestApi';
import { ThumbnailService } from './service';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
/** 字幕は音声のストリームにしか付けられない（validate.ts の文字起こしの検査）ので、見本の動画に音声を足す。 */
const AV_ASSET: SequenceAsset = { ...VIDEO_ASSET, streams: [...VIDEO_ASSET.streams, { index: 1, kind: 'audio', codec: 'aac', duration: { num: 3, den: 1 }, sampleRate: 48000, channels: 2 }] };
/** 受け箱は受付時刻が 24 時間以内でないと 409 にするので、実際の時刻を 1 度だけ取って同じ値を送り直す（画面と同じ）。 */
const CREATED_AT = Date.now();
const input = (over: Partial<ThumbnailAiButtonInput> = {}): ThumbnailAiButtonInput => ({ projectId: 'a', kind: 'new', pageId: null, cutout: 'auto', note: '飛距離の回',
  requestId: 'aaaaaaaa-bbbb-cccc-dddd-000000000001', requestCreatedAt: CREATED_AT, ...over });

/** agent.test.ts の setup() と同じ案件（案が 1 つ）に、本物の受け箱と偽の貼り付けをつなぐ。 */
function harness() {
  root = mkdtempSync(join(tmpdir(), 'thumb-api-'));
  const service = new ThumbnailService(), agent = new ThumbnailAgent({ root: () => root, service }), inbox = createInstructionInbox();
  const directory = join(root, 'a'); mkdirSync(directory);
  const video: SequenceDocument = { schemaVersion: 2, id: 'a', name: 'a', revision: 0, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30,
    background: '#000000', assets: [AV_ASSET], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
  new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'v', document: video });
  service.create(directory, 'c-a');
  const pasted: string[] = [];
  const deps: ThumbnailAiApiDeps = { agent, inbox, running: () => true, paste: text => { pasted.push(text); return { ok: true }; }, projectDir: projectId => join(root, projectId) };
  const addPages = (count: number) => {
    let state = service.open(directory);
    for (let index = 0; index < count; index++)
      state = service.execute(directory, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: `add-${index}`, command: { type: 'add-page', pageId: `page-${index}`, name: `案${index}` } });
  };
  return { deps, pasted, inbox, addPages, service, directory };
}

describe('サムネの AI のボタンの依頼（HTTP の中身）', () => {
  it('押した時点で依頼の記録を作り、依頼番号つきの依頼文を貼る。状態は送信待ち', () => {
    const { deps, pasted } = harness();
    const created = createThumbnailAiButtonRequest(input(), deps);
    expect(created.status).toBe(200);
    expect(pasted).toEqual([expect.stringMatching(/^サムネ: 新しい案を作って（切り抜き: AI に任せる）飛距離の回（依頼 #\d+）$/)]);
    expect(created.body).toMatchObject({ status: 'pending', request: { route: 'button', kind: 'new', requestId: expect.stringMatching(/^inst-/) } });
  });
  it('同じ requestId の再送は貼り直さない', () => {
    const { deps, pasted } = harness();
    createThumbnailAiButtonRequest(input(), deps); createThumbnailAiButtonRequest(input(), deps);
    expect(pasted).toHaveLength(1);
  });
  it('案が 3 つで新しい案なのに入れ替える案が無ければ 409 で、貼らない。AI が起動していなければ 409', () => {
    const { deps, pasted, addPages } = harness(); addPages(2);
    expect(createThumbnailAiButtonRequest(input(), deps)).toMatchObject({ status: 409, body: { code: 'PAGE_LIMIT' } });
    expect(createThumbnailAiButtonRequest(input({ requestId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002' }), { ...deps, running: () => false })).toMatchObject({ status: 409, body: { code: 'AI_NOT_RUNNING' } });
    expect(pasted).toEqual([]);
  });
  it('案が 3 つ未満で入れ替える案が付いた依頼は 400 で、貼らず、案は消えない（頼んでいない案を消さない）', () => {
    const { deps, pasted, addPages, service, directory } = harness(); addPages(1);
    const pageId = service.open(directory).document.pages[1]!.id;
    expect(createThumbnailAiButtonRequest(input({ pageId }), deps)).toMatchObject({ status: 400, body: { code: 'INVALID_INPUT' } });
    expect(pasted).toEqual([]);
    expect(deps.agent.latest('a')).toBeUndefined();
    expect(service.open(directory).document.pages).toHaveLength(2);
  });
  it('受け箱を作り直して番号 inst-1 が使い回されても、前の依頼の記録は流用せず、押した瞬間の対象で作り直す', () => {
    const { deps, addPages, service, directory } = harness(); addPages(1);
    const [first, second] = service.open(directory).document.pages;
    createThumbnailAiButtonRequest(input({ kind: 'edit', pageId: first!.id }), deps);
    const old = deps.agent.latest('a')!;
    expect(old).toMatchObject({ requestId: 'inst-1', targetPageId: first!.id });
    // 前の依頼が確定済みの記録を残したまま、受け箱だけが 0 から始まり直す（再起動・二重起動・ロック競合）。
    new ThumbnailAiRequestStore(directory).update('inst-1', current => ({ ...current, apply: { operationId: 'op-old', requestHash: 'h', status: 'saved', pageId: first!.id, appliedRevision: 1, savedRevision: 1, message: null, evacuatedFile: null, at: 't' } }));
    const fresh = { ...deps, inbox: createInstructionInbox() };
    const result = createThumbnailAiButtonRequest(input({ kind: 'edit', pageId: second!.id, requestId: 'aaaaaaaa-bbbb-cccc-dddd-000000000002' }), fresh);
    expect(result.body).toMatchObject({ status: 'pending', request: { requestId: 'inst-1', kind: 'edit', targetPageId: second!.id, apply: null } });
  });
  it('同じ依頼の再送（created=false）は記録を作り直さない（途中の作業を消さない）', () => {
    const { deps, pasted } = harness();
    createThumbnailAiButtonRequest(input(), deps);
    new ThumbnailAiRequestStore(deps.projectDir('a')).update('inst-1', current => ({ ...current, previews: 2, phase: 'reviewing' }));
    createThumbnailAiButtonRequest(input(), deps);
    expect(deps.agent.latest('a')).toMatchObject({ requestId: 'inst-1', previews: 2, phase: 'reviewing' });
    expect(pasted).toHaveLength(1);
  });
  it('貼れなかったら受け箱の依頼を失敗にして 409', () => {
    const { deps } = harness();
    const result = createThumbnailAiButtonRequest(input(), { ...deps, paste: () => ({ ok: false, error: '貼れません' }) });
    expect(result.status).toBe(409);
    expect(thumbnailAiLatest('a', deps).status).toBe('failed');
  });
  it('照会は受け箱の状態と作業の段階を合わせる（Enter → 作業中 → 確認中）', () => {
    const { deps, inbox } = harness();
    createThumbnailAiButtonRequest(input(), deps);
    inbox.markPastedSubmitted();
    expect(thumbnailAiLatest('a', deps)).toMatchObject({ status: 'working', label: '作業中' });
    const requestId = thumbnailAiLatest('a', deps).request!.requestId;
    new ThumbnailAiRequestStore(deps.projectDir('a')).update(requestId, current => ({ ...current, phase: 'reviewing' }));
    expect(thumbnailAiLatest('a', deps)).toMatchObject({ status: 'reviewing', label: '仕上がりを確認中' });
  });
});
