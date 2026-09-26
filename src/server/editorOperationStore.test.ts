import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorOperationStore } from './editorOperationStore';
import { publicEditorOperation, type EditorOperation } from '../shared/editorOperations';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'editor-receipts-')); directories.push(directory);
  return new EditorOperationStore(path.join(directory, 'operations.json'), 'server-a', () => 1000);
}
const request = { schemaVersion: 1, projectId: 'project-a', operationId: 'operation-a', baseRevision: 'revision-a',
  changes: [{ type: 'set_telop_text', elementId: '1', before: '素振りする', after: '素振りをする', sourceFrameRange: { start: 0, end: 30 } }] };
const applied = { phase: 'applied', revision: 'revision-b', code: null, applied: true, saved: false };
const saved = { ...applied, phase: 'saved', saved: true };
function acknowledge(store: EditorOperationStore, claim: EditorOperation, input: unknown) {
  return store.acknowledge(claim.runId, claim.claim!.sessionId, claim.claim!.token, input);
}

describe('編集の実行受付と結果の永続記録', () => {
  it('同じID再送は同じ結果を返し、別内容・別案件へのID再利用を拒否する', () => {
    const store = fixture(); const first = store.enqueue(request);
    expect(store.enqueue(structuredClone(request))).toEqual(first);
    expect(() => store.enqueue({ ...request, projectId: 'project-b' })).toThrow(/OPERATION_CONFLICT/);
    expect(() => store.enqueue({ ...request, baseRevision: 'different' })).toThrow(/OPERATION_CONFLICT/);
    expect(store.list()).toHaveLength(1);
  });
  it('同じ案件の実行を直列化し、別案件と混ぜずに並行できる', () => {
    const store = fixture(); store.enqueue(request);
    expect(() => store.enqueue({ ...request, operationId: 'second' })).toThrow(/PROJECT_BUSY/);
    store.enqueue({ ...request, operationId: 'second', projectId: 'project-b' });
    expect(store.list('project-a')).toHaveLength(1);
    expect(store.list('project-b')).toHaveLength(1);
  });
  it('担当を一度だけ引き当て、別クライアントの完了報告や未適用の保存成功を拒否する', () => {
    const store = fixture(); const first = store.enqueue(request); const claim = store.claim(first.runId, 'browser-a');
    expect(() => store.claim(first.runId, 'browser-b')).toThrow(/NOT_CLAIMABLE/);
    expect(() => store.acknowledge(first.runId, 'browser-b', claim.claim!.token, applied)).toThrow(/CLAIM_MISMATCH/);
    expect(() => acknowledge(store, claim, saved)).toThrow(/APPLY_UNCONFIRMED/);
    expect(publicEditorOperation(claim)).not.toHaveProperty('claim');
    expect(JSON.stringify(publicEditorOperation(claim))).not.toContain(claim.claim!.token);
  });
  it('適用と保存の再送を一度の結果へまとめ、人の採用には変換しない', () => {
    const store = fixture(); const claim = store.claim(store.enqueue(request).runId, 'browser-a');
    acknowledge(store, claim, applied); acknowledge(store, claim, applied);
    const complete = acknowledge(store, claim, saved);
    expect(acknowledge(store, claim, saved)).toEqual(complete);
    expect(complete.confirmed).toEqual({ applied: true, saved: true });
    expect(complete.humanReview).toBe('pending');
    expect(new EditorOperationStore(store.file, 'server-b').get(claim.runId)).toEqual(complete);
    expect(() => acknowledge(store, claim, { ...applied, phase: 'failed' })).toThrow(/RUN_FINISHED/);
  });
  it('同じ内容の適用確認だけを冪等にし、異なる版によるcheckpoint上書きを拒否する', () => {
    const store = fixture(); const claim = store.claim(store.enqueue(request).runId, 'browser-a');
    const first = acknowledge(store, claim, applied);
    expect(acknowledge(store, claim, structuredClone(applied))).toEqual(first);

    expect(() => acknowledge(store, claim, { ...applied, revision: 'revision-c' })).toThrow(/CHECKPOINT_CONFLICT/);
    expect(store.get(claim.runId).result).toEqual(applied);
  });
  it('適用済み・保存済みと適用後の失敗には確認済みrevisionを必須にする', () => {
    const store = fixture(); const claim = store.claim(store.enqueue(request).runId, 'browser-a');
    expect(() => acknowledge(store, claim, { ...applied, revision: null })).toThrow();
    acknowledge(store, claim, applied);
    for (const result of [
      { phase: 'saved', revision: null, code: null, applied: true, saved: true },
      { phase: 'failed', revision: null, code: 'SAVE_FAILED', applied: true, saved: false },
      { phase: 'cancelled', revision: null, code: 'CANCELLED', applied: true, saved: false },
      { phase: 'saved', revision: 'revision-c', code: null, applied: true, saved: true },
      { phase: 'failed', revision: 'revision-c', code: 'SAVE_FAILED', applied: true, saved: false },
      { phase: 'cancelled', revision: 'revision-c', code: 'CANCELLED', applied: true, saved: false },
    ]) expect(() => acknowledge(store, claim, result)).toThrow();
    expect(store.get(claim.runId).result).toEqual(applied);
  });
  it('開始前の取消は配信を止め、開始後は取消要求と実際の保存結果を両方残す', () => {
    const store = fixture(); const first = store.enqueue(request); store.cancel(first.runId);
    expect(() => store.claim(first.runId, 'browser-a')).toThrow(/NOT_CLAIMABLE/);
    const claim = store.claim(store.enqueue({ ...request, operationId: 'second' }).runId, 'browser-a');
    store.cancel(claim.runId);
    expect(store.get(claim.runId).phase).toBe('running');
    acknowledge(store, claim, applied);
    const complete = acknowledge(store, claim, saved);
    expect(complete.cancelRequested).toBe(true);
    expect(complete.phase).toBe('saved'); // Too late to stop, never pretend rollback.
  });
  it('保存失敗でも適用済みを保持し、未適用への巻き戻し報告を拒否する', () => {
    const store = fixture(); const claim = store.claim(store.enqueue(request).runId, 'browser-a');
    acknowledge(store, claim, applied);
    expect(() => acknowledge(store, claim, { phase: 'failed', revision: null, code: 'CONFLICT', applied: false, saved: false })).toThrow(/RESULT_REGRESSION/);
    const failed = acknowledge(store, claim, { ...applied, phase: 'failed', code: 'SAVE_CONFLICT' });
    expect(failed.confirmed).toEqual({ applied: true, saved: false });
  });
  it('再起動と切断は結果不明として保持し、再取得を再実行にしない', () => {
    const store = fixture(); const claim = store.claim(store.enqueue(request).runId, 'browser-a');
    acknowledge(store, claim, applied);
    const reopened = new EditorOperationStore(store.file, 'server-b', () => 2000); reopened.recoverInterrupted();
    const unknown = reopened.get(claim.runId);
    expect(unknown.phase).toBe('unknown'); expect(unknown.confirmed.applied).toBe(true);
    expect(reopened.enqueue(request).runId).toBe(claim.runId);
    expect(() => reopened.enqueue({ ...request, operationId: 'unsafe-retry' })).toThrow(/RECONCILIATION_REQUIRED/);
    expect(() => reopened.claim(claim.runId, 'browser-b')).toThrow(/NOT_CLAIMABLE/);
    const late = acknowledge(reopened, claim, saved);
    expect(late.phase).toBe('unknown'); expect(late.confirmed.saved).toBe(false);
    expect(late.lateResult?.saved).toBe(true);
    const other = store.claim(store.enqueue({ ...request, projectId: 'project-b', operationId: 'other' }).runId, 'browser-b');
    store.disconnect('browser-b'); expect(store.get(other.runId).phase).toBe('unknown');
  });
  it('再起動時は未配信queuedを新所有者へ引き継ぎ、claim済みだけを結果不明にする', () => {
    const store = fixture();
    const queued = store.enqueue(request);
    const other = store.claim(store.enqueue({ ...request, projectId: 'project-b', operationId: 'other' }).runId, 'browser-a');
    const reopened = new EditorOperationStore(store.file, 'server-b', () => 2000);

    reopened.recoverInterrupted();

    const recoveredQueued = reopened.get(queued.runId);
    expect(recoveredQueued).toMatchObject({ phase: 'queued', claim: null, serverInstance: 'server-b', updatedAt: 2000 });
    expect(reopened.enqueue(request).runId).toBe(queued.runId);
    expect(reopened.claim(queued.runId, 'browser-b').claim?.sessionId).toBe('browser-b');
    expect(reopened.get(other.runId)).toMatchObject({ phase: 'unknown', serverInstance: 'server-a' });
  });
  it('ロック中・破損・未知版で成功を返さず記録を保全する', () => {
    const store = fixture(); store.enqueue(request); const before = readFileSync(store.file, 'utf8');
    mkdirSync(`${store.file}.lock`);
    expect(() => store.cancel(store.list()[0]!.runId)).toThrow(/STORE_BUSY/);
    expect(readFileSync(store.file, 'utf8')).toBe(before);
    rmSync(`${store.file}.lock`, { recursive: true });
    for (const invalid of ['{broken', '{"schemaVersion":2,"operations":[]}']) {
      writeFileSync(store.file, invalid);
      expect(() => store.enqueue(request)).toThrow();
      expect(readFileSync(store.file, 'utf8')).toBe(invalid);
    }
  });
  it('phase・確認済み結果・claimが矛盾するjournalを拒否し元ファイルを保全する', () => {
    const cases = [
      { phase: 'saved', confirmed: { applied: true, saved: true }, result: null },
      { phase: 'saved', confirmed: { applied: true, saved: false }, result: saved },
      { phase: 'saved', confirmed: { applied: true, saved: true }, result: saved, claim: null },
      { phase: 'running', confirmed: { applied: false, saved: false }, result: applied },
      { phase: 'unknown', confirmed: { applied: true, saved: true }, result: saved,
        claim: { sessionId: 'browser-a', token: 'token-a' } },
      { phase: 'cancelled', cancelRequested: false,
        result: { phase: 'cancelled', revision: null, code: 'CANCELLED', applied: false, saved: false } },
    ];
    for (const replacement of cases) {
      const store = fixture(); store.enqueue(request);
      const journal = JSON.parse(readFileSync(store.file, 'utf8'));
      Object.assign(journal.operations[0], replacement);
      const corrupt = JSON.stringify(journal);
      writeFileSync(store.file, corrupt);

      expect(() => new EditorOperationStore(store.file, 'server-b').list()).toThrow();
      expect(readFileSync(store.file, 'utf8')).toBe(corrupt);
    }
  });
});
