import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';
import { assertEditorDeliveryMaySave } from './editorSaveGuard';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'editor-reconcile-')); directories.push(directory);
  const elements = [{ id: '1', text: 'before', sourceFrameRange: { start: 0, end: 30 } }];
  let saved = { elements, fingerprint: 'saved-a' };
  const store = new EditorOperationStore(join(directory, 'operations.json'), 'a');
  const service = new EditorAgentService(store, () => {}, Date.now, 15000, () => saved);
  const heartbeat = { sessionId: 'window', sessionKey: 'a'.repeat(32), sequence: 1,
    snapshot: { status: 'ready', projectId: 'a', revision: 'r1', dirty: false, saving: false, humanBusy: false, elements } };
  service.heartbeat(heartbeat);
  const request = { schemaVersion: 1, operationId: 'op', projectId: 'a', baseRevision: 'r1',
    changes: [{ type: 'set_telop_text', elementId: '1', before: 'before', after: 'after', sourceFrameRange: { start: 0, end: 30 } }] };
  const first = service.enqueue('window', request);
  const oldToken = store.get(first.runId).claim!.token;
  service.disconnect('window', heartbeat.sessionKey);
  service.heartbeat({ ...heartbeat, sequence: 2 });
  return { service, store, first, heartbeat, request, oldToken, setSaved: (next: typeof saved) => { saved = next; } };
}
describe('保存内容を確認して結果不明から再開する', () => {
  it('履歴の結果不明を改変せず、確認後だけ新しい操作を受付する', () => {
    const f = fixture();
    expect(() => f.service.enqueue('window', { ...f.request, operationId: 'next' })).toThrow(/RECONCILIATION_REQUIRED/);
    const preview = f.service.prepareReconciliation('window', f.first.runId);
    expect(preview.targets[0]?.current?.text).toBe('before');
    const reviewed = f.service.reconcile('window', f.heartbeat.sessionKey, f.first.runId, 'review-1', preview.snapshotHash, 'synthetic');
    expect(reviewed).toMatchObject({ phase: 'unknown', confirmed: { applied: false, saved: false },
      humanReview: 'pending', reconciliation: { source: 'synthetic' } });
    expect(f.service.reconcile('window', f.heartbeat.sessionKey, f.first.runId, 'review-1', preview.snapshotHash, 'synthetic')).toEqual(reviewed);
    expect(f.service.enqueue('window', { ...f.request, operationId: 'next' }).phase).toBe('running');
    expect(() => assertEditorDeliveryMaySave({ 'x-harness-editor-run': f.first.runId,
      'x-harness-editor-token': f.oldToken }, 'a', f.service)).toThrow(/DELIVERY_FENCED/);
  });
  it('確認画面を開いた後の保存内容変更とUI版変更では再開を拒否する', () => {
    const f = fixture(); const preview = f.service.prepareReconciliation('window', f.first.runId);
    f.setSaved({ elements: f.heartbeat.snapshot.elements, fingerprint: 'saved-b' });
    expect(() => f.service.reconcile('window', f.heartbeat.sessionKey, f.first.runId, 'review-1', preview.snapshotHash, 'synthetic')).toThrow(/REVIEW_STALE/);
    const refreshed = f.service.prepareReconciliation('window', f.first.runId);
    f.service.heartbeat({ ...f.heartbeat, sequence: 3, snapshot: { ...f.heartbeat.snapshot, revision: 'r2' } });
    expect(() => f.service.reconcile('window', f.heartbeat.sessionKey, f.first.runId, 'review-1', refreshed.snapshotHash, 'synthetic')).toThrow(/REVIEW_STALE/);
    expect(f.store.get(f.first.runId).reconciliation).toBeUndefined();
  });
  it('未保存・別案件・保存と画面の相違では再開確認を作らない', () => {
    const f = fixture();
    f.service.heartbeat({ ...f.heartbeat, sequence: 3, snapshot: { ...f.heartbeat.snapshot, dirty: true } });
    expect(() => f.service.prepareReconciliation('window', f.first.runId)).toThrow(/UNSAVED_CHANGES/);
    f.service.heartbeat({ ...f.heartbeat, sequence: 4 });
    f.setSaved({ elements: [{ ...f.heartbeat.snapshot.elements[0]!, text: 'changed on disk' }], fingerprint: 'saved-b' });
    expect(() => f.service.prepareReconciliation('window', f.first.runId)).toThrow(/SAVED_STATE_MISMATCH/);
    f.service.heartbeat({ ...f.heartbeat, sequence: 5, snapshot: { ...f.heartbeat.snapshot, projectId: 'b' } });
    expect(() => f.service.prepareReconciliation('window', f.first.runId)).toThrow(/PROJECT_MISMATCH/);
    expect(f.store.get(f.first.runId).reconciliation).toBeUndefined();
  });
  it('最終確認後からatomic書込までに遅延結果が届いた場合も再確認を求める', () => {
    const f = fixture(); const preview = f.service.prepareReconciliation('window', f.first.runId);
    const commit = f.store.reconcile.bind(f.store);
    vi.spyOn(f.store, 'reconcile').mockImplementationOnce((runId, review) => {
      f.store.acknowledge(runId, 'window', f.oldToken,
        { phase: 'saved', revision: 'late-r2', applied: true, saved: true, code: null });
      return commit(runId, review);
    });
    expect(() => f.service.reconcile('window', f.heartbeat.sessionKey, f.first.runId,
      'review-1', preview.snapshotHash, 'synthetic')).toThrow(/REVIEW_STALE/);
    expect(f.store.get(f.first.runId).reconciliation).toBeUndefined();
    expect(f.store.get(f.first.runId).lateResult?.saved).toBe(true);
  });
});
