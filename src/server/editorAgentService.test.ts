import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptAdoptionFixture, scriptJudgmentFixture } from '../core/__fixtures__/scriptAdoption';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const request = { schemaVersion: 1, operationId: 'op-a', projectId: 'project-a', baseRevision: 'rev-a',
  changes: [{ type: 'set_telop_text', elementId: '1', before: '素振りする', after: '素振りをする', sourceFrameRange: { start: 0, end: 30 } }] };
const heartbeat = (sessionId = 'window-a', projectId = 'project-a') => ({ sessionId, sessionKey: sessionId.repeat(8), sequence: 1,
  snapshot: { status: 'ready', projectId, revision: 'rev-a', dirty: false, saving: false, humanBusy: false,
    elements: [{ id: '1', text: '素振りする', sourceFrameRange: { start: 0, end: 30 } }] } });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'editor-agent-')); directories.push(directory);
  let now = 1000;
  const store = new EditorOperationStore(join(directory, 'operations.json'), 'server-a', () => now);
  const requireProject = (id: string) => { if (!['project-a', 'project-b'].includes(id)) throw new Error('PROJECT_NOT_FOUND'); };
  const service = new EditorAgentService(store, requireProject, () => now, 100);
  return { store, service, requireProject, tick: () => { now += 101; } };
}

describe('既存編集画面への型付き操作配送', () => {
  it('明示した画面だけに一意のclaimを配送し、公開結果から担当tokenを隠す', () => {
    const { service } = fixture(); const a = heartbeat(); const b = heartbeat('window-b', 'project-b');
    service.heartbeat(a); service.heartbeat(b);
    const first = service.enqueue(a.sessionId, request);
    expect(first.phase).toBe('running'); expect(first.sessionId).toBe(a.sessionId);
    expect(first).not.toHaveProperty('claim');
    expect(service.heartbeat(b).deliveries).toEqual([]);
    const [delivery] = service.heartbeat(a).deliveries;
    expect(delivery?.runId).toBe(first.runId);
    expect(service.heartbeat(a).deliveries[0]?.claim).toEqual(delivery?.claim);
    expect(() => service.delivery(b.sessionId, b.sessionKey, first.runId)).toThrow(/CLAIM_MISMATCH/);
    expect(() => service.delivery(a.sessionId, b.sessionKey, first.runId)).toThrow(/OWNERSHIP_CONFLICT/);
    expect(service.enqueue(b.sessionId, { ...request, operationId: 'op-b', projectId: 'project-b' }).phase).toBe('running');
    expect(service.list()).toHaveLength(2);
  });

  it('未保存・古い版・不正な2件目を受付前に拒否し、部分的な記録を作らない', () => {
    const { service, store } = fixture(); const a = heartbeat();
    service.heartbeat({ ...a, snapshot: { ...a.snapshot, dirty: true } });
    expect(() => service.enqueue(a.sessionId, request)).toThrow(/UNSAVED_CHANGES/);
    service.heartbeat({ ...a, sequence: 2 });
    expect(() => service.enqueue(a.sessionId, { ...request, baseRevision: 'old' })).toThrow(/REVISION_CONFLICT/);
    expect(() => service.enqueue(a.sessionId, { ...request, changes: [...request.changes, { ...request.changes[0], elementId: 'missing' }] }))
      .toThrow(/TARGET_NOT_FOUND/);
    expect(store.list()).toEqual([]);
    expect(service.validate(a.sessionId, request).valid).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it('適用と保存を別checkpointで記録し、後の状態変化でも同じ操作を再実行しない', () => {
    const { service } = fixture(); const a = heartbeat(); service.heartbeat(a);
    const first = service.enqueue(a.sessionId, request);
    const delivery = service.delivery(a.sessionId, a.sessionKey, first.runId);
    const applied = { phase: 'applied', revision: 'rev-b', code: null, applied: true, saved: false };
    service.acknowledge(a.sessionId, a.sessionKey, first.runId, delivery.claim!.token, applied);
    const saved = service.acknowledge(a.sessionId, a.sessionKey, first.runId, delivery.claim!.token,
      { ...applied, phase: 'saved', saved: true });
    service.heartbeat({ ...a, sequence: 2, snapshot: { status: 'home', projectId: null } });
    expect(service.enqueue('closed-window', request)).toEqual(saved);
    expect(saved.humanReview).toBe('pending');
    expect(service.heartbeat({ ...a, sequence: 2, snapshot: { status: 'home', projectId: null } }).deliveries).toEqual([]);
    expect(() => service.enqueue(a.sessionId, { ...request, baseRevision: 'rev-b' })).toThrow(/OPERATION_CONFLICT/);
  });

  it('期限切れとサーバ再起動後は結果不明にし、新しい画面へ再配信しない', () => {
    const { service, store, tick, requireProject } = fixture(); const a = heartbeat(); service.heartbeat(a);
    const first = service.enqueue(a.sessionId, request); tick();
    expect(service.get(first.runId).phase).toBe('unknown');
    const restarted = new EditorOperationStore(store.file, 'server-b'); restarted.recoverInterrupted();
    const next = new EditorAgentService(restarted, requireProject);
    const b = heartbeat('window-b'); next.heartbeat(b);
    expect(next.enqueue(b.sessionId, request).runId).toBe(first.runId);
    expect(next.heartbeat(b).deliveries).toEqual([]);
    expect(() => next.enqueue(b.sessionId, { ...request, operationId: 'new' })).toThrow(/RECONCILIATION_REQUIRED/);
  });

  it('browser未到達の台本queuedだけを再起動後の現在版へ接続し、一度だけclaimする', () => {
    const { store } = fixture();
    const judgment = scriptJudgmentFixture();
    const oldRequest = { schemaVersion: 1 as const, operationId: `script:${judgment.id}`,
      projectId: judgment.projectId, baseRevision: 'before-reload',
      script: { judgmentId: judgment.id, artifact: judgment.artifact }, changes: [] };
    const queued = store.enqueue(oldRequest);
    const restarted = new EditorOperationStore(store.file, 'server-b'); restarted.recoverInterrupted();
    const context = { validateScriptDecision: () => {}, review: (operations: unknown[]) => operations };
    const service = new EditorAgentService(restarted, () => {}, Date.now, 15_000, undefined, context as never);
    const browser = { ...heartbeat('window-a', judgment.projectId), snapshot: {
      ...heartbeat('window-a', judgment.projectId).snapshot, revision: 'after-reload' } };
    service.heartbeat(browser);

    expect(() => service.enqueue(browser.sessionId, { ...oldRequest, baseRevision: 'after-reload',
      script: { ...oldRequest.script, artifact: scriptAdoptionFixture('structure') } })).toThrow(/OPERATION_CONFLICT/);
    expect(restarted.get(queued.runId)).toMatchObject({ phase: 'queued', request: { baseRevision: 'before-reload' } });
    const recovered = service.enqueue(browser.sessionId, { ...oldRequest, baseRevision: 'after-reload' });
    expect(recovered).toMatchObject({ runId: queued.runId, phase: 'running',
      request: { operationId: oldRequest.operationId, baseRevision: 'after-reload', script: oldRequest.script } });
    expect(service.heartbeat({ ...browser, sequence: 2 }).deliveries).toHaveLength(1);
    expect(service.enqueue(browser.sessionId, { ...oldRequest, baseRevision: 'after-reload' }).runId).toBe(queued.runId);
    expect(() => service.enqueue(browser.sessionId, { ...oldRequest, baseRevision: 'another-revision' }))
      .toThrow(/OPERATION_CONFLICT/);
    expect(restarted.list()).toHaveLength(1);
  });

  it('取消要求を担当画面が再取得でき、適用済みとは偽らない', () => {
    const { service } = fixture(); const a = heartbeat(); service.heartbeat(a);
    const first = service.enqueue(a.sessionId, request); service.cancel(first.runId);
    const delivery = service.delivery(a.sessionId, a.sessionKey, first.runId);
    expect(delivery.cancelRequested).toBe(true);
    const final = service.acknowledge(a.sessionId, a.sessionKey, first.runId, delivery.claim!.token,
      { phase: 'cancelled', revision: null, code: 'CANCELLED_BEFORE_APPLY', applied: false, saved: false });
    expect(final.confirmed).toEqual({ applied: false, saved: false });
    expect(service.heartbeat(a).deliveries).toEqual([]);
  });

  it('同じ画面で案件を切り替えたら旧案件の配信を結果不明にして停止する', () => {
    const { service, store } = fixture(); const a = heartbeat(); service.heartbeat(a);
    const first = service.enqueue(a.sessionId, request);
    const response = service.heartbeat({ ...heartbeat('window-a', 'project-b'), sequence: 2 });
    expect(response.deliveries).toEqual([]);
    expect(store.get(first.runId).phase).toBe('unknown');
    expect(service.enqueue('window-a', { ...request, projectId: 'project-b', operationId: 'b' }).phase).toBe('running');
  });

  it('一覧取得を最大100字幕に制限し、未知案件を接続させない', () => {
    const { service } = fixture(); const a = heartbeat();
    const elements = Array.from({ length: 101 }, (_, index) => ({ ...a.snapshot.elements[0]!, id: String(index) }));
    service.heartbeat({ ...a, snapshot: { ...a.snapshot, elements } });
    const first = service.read(a.sessionId);
    if (first.status !== 'ready') throw new Error('ready expected');
    expect(first.elements).toHaveLength(100); expect(first.nextOffset).toBe(100);
    const second = service.read(a.sessionId, 100);
    if (second.status !== 'ready') throw new Error('ready expected');
    expect(second.elements).toHaveLength(1); expect(second.nextOffset).toBeNull();
    expect(() => service.read(a.sessionId, 0, 101)).toThrow(/INVALID_PAGE/);
    expect(() => service.heartbeat(heartbeat('window-b', 'missing'))).toThrow(/PROJECT_NOT_FOUND/);
  });
});
