import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SequenceAsset, SequenceDocument } from '../../core/sequence/model';
import { shapeLayer, VIDEO_ASSET } from '../../core/thumbnail/fixtures';
import { SequenceStore } from '../sequence/store';
import { ThumbnailAiRequestStore } from './aiRequests';
import { NEW_PAGE } from './aiCommand';
import { ThumbnailAgent, ThumbnailAgentError } from './agent';
import { ThumbnailService } from './service';
import { ThumbnailStore } from './store';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });
/** 字幕は音声のストリームにしか付けられない（validate.ts の文字起こしの検査）ので、見本の動画に音声を足す。 */
const AV_ASSET: SequenceAsset = { ...VIDEO_ASSET, streams: [...VIDEO_ASSET.streams, { index: 1, kind: 'audio', codec: 'aac', duration: { num: 3, den: 1 }, sampleRate: 48000, channels: 2 }] };
function setup() {
  root = mkdtempSync(join(tmpdir(), 'thumb-agent-'));
  const service = new ThumbnailService(), agent = new ThumbnailAgent({ root: () => root, service });
  const make = (projectId: string) => {
    const directory = join(root, projectId); mkdirSync(directory);
    const video: SequenceDocument = { schemaVersion: 2, id: projectId, name: projectId, revision: 0, fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 30,
      background: '#000000', assets: [AV_ASSET], tracks: [], clips: [], transitions: [], transcripts: [
        { assetId: AV_ASSET.id, streamIndex: 1, words: [{ id: 'w1', text: '飛距離が', start: { num: 1, den: 2 }, end: { num: 3, den: 2 } }, { id: 'w2', text: '伸びる。', start: { num: 3, den: 2 }, end: { num: 5, den: 2 } }] }],
      ducking: { enabled: false, strength: 'mid' } };
    new SequenceStore(directory).save({ expectedSavedRevision: null, executionId: 'v', document: video });
    service.create(directory, `c-${projectId}`);
    return directory;
  };
  return { service, agent, make };
}
const code = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof ThumbnailAgentError ? error.code : String(error); } return 'NONE'; };
const textOp = (id: string) => ({ type: 'add-layer', pageId: NEW_PAGE, layer: { id, content: { kind: 'text', text: '飛ぶ' } } });

describe('ThumbnailAgent', () => {
  it('A で依頼 → B を開く → 確定: A にだけ書け、B には同じ依頼番号で書けない（依頼の固定）', () => {
    const { agent, service, make } = setup(), a = make('a'), b = make('b');
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    expect(code(() => agent.apply({ projectId: 'b', requestId, operationId: 'op-1', baseRevision: service.open(b).document.revision, ops: [textOp('t1')] }))).toBe('NOT_FOUND');
    const result = agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: service.open(a).document.revision, ops: [textOp('t1')] });
    expect(result.status).toBe('saved');
    expect(new ThumbnailStore(a).load()).toMatchObject({ kind: 'ok', saved: { document: { pages: [{}, { id: result.pageId }] } } });
    expect(service.open(b).document.pages).toHaveLength(1);
  });
  it('直す依頼で別の案の削除・メインの変更は OUT_OF_REQUEST で、文書は変わらない', () => {
    const { agent, service, make } = setup(), a = make('a'), state = service.open(a), pageId = state.document.pages[0]!.id;
    const { requestId } = agent.begin({ projectId: 'a', kind: 'edit', pageId });
    for (const op of [{ type: 'delete-page', pageId }, { type: 'set-main-page', pageId }])
      expect(code(() => agent.apply({ projectId: 'a', requestId, operationId: `op-${op.type}`, baseRevision: state.document.revision, ops: [op] }))).toBe('OUT_OF_REQUEST');
    expect(service.open(a).document.revision).toBe(state.document.revision);
  });
  it('入れ替えの同意の後に人がその案を変えたら TARGET_CHANGED', () => {
    const { agent, service, make } = setup(), a = make('a');
    let state = service.open(a);
    for (const [pageId, name] of [['page-b', '案B'], ['page-c', '案C']] as const)
      state = service.execute(a, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: `add-${pageId}`, command: { type: 'add-page', pageId, name } });
    expect(code(() => agent.begin({ projectId: 'a', kind: 'new' }))).toBe('PAGE_LIMIT');
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new', replacePageId: 'page-c' });
    state = service.execute(a, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'human', command: { type: 'add-layer', pageId: 'page-c', layer: shapeLayer('h') } });
    expect(code(() => agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: state.document.revision, ops: [textOp('t1')] }))).toBe('TARGET_CHANGED');
  });
  it('入れ替える案は案が 3 つの時だけ。3 つ未満で渡されたら INVALID_INPUT で、案は消えず依頼の記録も作らない', () => {
    const { agent, service, make } = setup(), a = make('a');
    let state = service.open(a);
    state = service.execute(a, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'add-b', command: { type: 'add-page', pageId: 'page-b', name: '案B' } });
    expect(code(() => agent.begin({ projectId: 'a', kind: 'new', replacePageId: 'page-b' }))).toBe('INVALID_INPUT');
    expect(code(() => agent.draft({ projectId: 'a', kind: 'new', pageId: 'page-b', cutout: 'auto', note: '', route: 'button' }))).toBe('INVALID_INPUT');
    expect(agent.latest('a')).toBeUndefined();
    expect(service.open(a).document.pages.map(page => page.id)).toContain('page-b');
    // 入れ替えずに新しい案を頼むのは通る。
    expect(code(() => agent.begin({ projectId: 'a', kind: 'new' }))).toBe('NONE');
  });
  it('入れ替えを頼んだ後に人が案を消して 3 つ未満になったら、確定は TARGET_CHANGED で止まり、何も消えない', () => {
    const { agent, service, make } = setup(), a = make('a');
    let state = service.open(a);
    for (const [pageId, name] of [['page-b', '案B'], ['page-c', '案C']] as const)
      state = service.execute(a, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: `add-${pageId}`, command: { type: 'add-page', pageId, name } });
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new', replacePageId: 'page-c' });
    state = service.execute(a, { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: 'human-delete', command: { type: 'delete-page', pageId: 'page-b' } });
    expect(code(() => agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: state.document.revision, ops: [textOp('t1')] }))).toBe('TARGET_CHANGED');
    expect(service.open(a).document.pages.map(page => page.id)).toContain('page-c');
    expect(agent.runs({ projectId: 'a', requestId }).apply).toBeNull();
  });
  it('ほかの案だけが変わって版が進んだら REVISION_CONFLICT（読み直して出し直せる）', () => {
    const { agent, service, make } = setup(), a = make('a');
    let state = service.open(a);
    const { requestId } = agent.begin({ projectId: 'a', kind: 'edit', pageId: state.document.pages[0]!.id });
    const old = state.document.revision;
    state = service.execute(a, { sessionId: state.sessionId, expectedRevision: old, executionId: 'other', command: { type: 'add-page', pageId: 'page-b', name: '案B' } });
    const pageId = state.document.pages[0]!.id, op = { type: 'shift-page-hue', pageId, degrees: 20 };
    expect(code(() => agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: old, ops: [op] }))).toBe('REVISION_CONFLICT');
    expect(agent.apply({ projectId: 'a', requestId, operationId: 'op-2', baseRevision: state.document.revision, ops: [op] }).status).toBe('saved');
  });
  it('手順を飛ばして確定だけを送っても範囲で止まる（依頼番号の無い・知らない依頼番号は NOT_FOUND）', () => {
    const { agent, make } = setup(); make('a');
    expect(code(() => agent.apply({ projectId: 'a', requestId: 'inst-999', operationId: 'op-1', baseRevision: 0, ops: [textOp('t1')] }))).toBe('NOT_FOUND');
  });
  it('保存の後に応答が消えても、同じ実行 ID の再送と runs で二重にならない。別の実行 ID は ALREADY_APPLIED', () => {
    const { agent, service, make } = setup(), a = make('a'), base = service.open(a).document.revision;
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    const first = agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: base, ops: [textOp('t1')] });
    const again = agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: base, ops: [textOp('t1')] });
    expect(again).toMatchObject({ status: 'saved', pageId: first.pageId, replayed: true });
    expect(service.open(a).document.pages).toHaveLength(2);
    expect(agent.runs({ projectId: 'a', requestId }).apply).toMatchObject({ status: 'saved', operationId: 'op-1' });
    expect(code(() => agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: base, ops: [textOp('t2')] }))).toBe('OPERATION_MISMATCH');
    expect(code(() => agent.apply({ projectId: 'a', requestId, operationId: 'op-2', baseRevision: base, ops: [textOp('t1')] }))).toBe('ALREADY_APPLIED');
  });
  it('再起動で受け箱の番号が inst-1 から振り直されても、2 回目の確定は保存の受領記録とぶつからず saved になる', () => {
    const { agent, service, make } = setup(), a = make('a');
    const button = (target: ThumbnailAgent) => {
      const request = { requestId: 'inst-1', ...target.draft({ projectId: 'a', kind: 'new', pageId: null, cutout: 'auto', note: '', route: 'button' }) };
      target.store('a', request); return request.requestId;
    };
    const first = agent.apply({ projectId: 'a', requestId: button(agent), operationId: 'op-1', baseRevision: service.open(a).document.revision, ops: [textOp('t1')] });
    expect(first.status).toBe('saved');
    // 別のエディタ（受け箱のロックを取れず、メモリだけで動く）: 新しいサービスが保存済みの文書を読み、番号は inst-1 から。
    const restarted = new ThumbnailService(), other = new ThumbnailAgent({ root: () => root, service: restarted });
    const second = other.apply({ projectId: 'a', requestId: button(other), operationId: 'op-2', baseRevision: restarted.open(a).document.revision, ops: [textOp('t2')] });
    expect(second).toMatchObject({ status: 'saved', message: null });
    expect(second.pageId).not.toBe(first.pageId);
    expect(new ThumbnailStore(a).load()).toMatchObject({ kind: 'ok', saved: { document: { pages: [{}, { id: first.pageId }, { id: second.pageId }] } } });
    // 保存の受領記録に残る実行 ID は依頼番号に依らず、毎回別になる。
    const ids = (JSON.parse(readFileSync(new ThumbnailStore(a).file, 'utf8')).receipts as Array<{ executionId: string }>).map(item => item.executionId).filter(item => item.startsWith('ai-'));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.some(item => item.includes('inst-1'))).toBe(false);
  });
  it('確定の後の元に戻す 1 回で AI の作業がまるごと戻る', () => {
    const { agent, service, make } = setup(), a = make('a'), before = service.open(a);
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    agent.apply({ projectId: 'a', requestId, operationId: 'op-1', baseRevision: before.document.revision, ops: [textOp('t1'), textOp('t2')] });
    const applied = service.open(a);
    const undone = service.execute(a, { sessionId: applied.sessionId, expectedRevision: applied.document.revision, executionId: 'undo', command: { type: 'undo' } });
    expect(undone.document.pages).toEqual(before.document.pages);
    expect(undone.document.assets).toEqual(before.document.assets);
  });
  it('read は文書・依頼の対象・使える動画・字幕の行（元の秒）を返す', () => {
    const { agent, make } = setup(); make('a');
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new', note: '飛距離の回' });
    const read = agent.read({ projectId: 'a', requestId });
    expect(read.request).toMatchObject({ requestId, kind: 'new', targetPageId: null, note: '飛距離の回' });
    expect(read.videos).toEqual([expect.objectContaining({ assetId: AV_ASSET.id, streamIndex: 0, seconds: 3 })]);
    expect(read.transcript.lines[0]).toMatchObject({ assetId: AV_ASSET.id, start: 0.5, end: 2.5, text: '飛距離が伸びる。' });
  });
  it('依頼の記録は案件の .harness に残る（再起動の後も runs で確かめられる）', () => {
    const { agent, make } = setup(), a = make('a');
    const { requestId } = agent.begin({ projectId: 'a', kind: 'new' });
    expect(new ThumbnailAiRequestStore(a).get(requestId)?.route).toBe('direct');
  });
});
