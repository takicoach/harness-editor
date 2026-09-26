import { expect, it } from 'vitest';
import type { EditorOperation } from './editorOperations';
import { editorBoardHumanReview, editorBoardOperation, editorProjectBoardItemSchema, selectEditorBoardOperation } from './editorBoard';
import type { PublicEditorOperation } from './editorOperations';

const operation = (runId: string, phase: EditorOperation['phase'], updatedAt: number,
  applied = false, saved = false): EditorOperation => ({
  schemaVersion: 1, runId, serverInstance: 'server', createdAt: 1, updatedAt, phase, cancelRequested: phase === 'cancelled',
  request: { schemaVersion: 1, operationId: `op-${runId}`, projectId: 'video', baseRevision: 'revision-secret',
    changes: [{ type: 'set_telop_text', elementId: '1', before: '保存本文before', after: '保存本文after',
      sourceFrameRange: { start: 0, end: 30 } }] },
  confirmed: { applied, saved }, claim: phase === 'queued' ? null : { sessionId: 'private-session', token: 'private-token' },
  result: ['queued', 'running', 'unknown'].includes(phase) ? null : {
    phase: phase as 'applied' | 'saved' | 'failed' | 'cancelled', revision: applied ? 'revision-after' : null,
    code: phase === 'failed' ? 'FAILED' : phase === 'cancelled' ? 'CANCELLED' : null, applied, saved,
  }, lateResult: null, humanReview: 'pending',
});

const reviewed = (value: EditorOperation, humanReview: PublicEditorOperation['humanReview']): PublicEditorOperation => {
  const { claim: _claim, humanReview: _stored, ...rest } = value;
  return { ...rest, sessionId: null, humanReview };
};

it('案件内の未解決operationをterminalより優先し、本文・claim・sessionを公開しない', () => {
  const selected = selectEditorBoardOperation([
    operation('unknown-old', 'unknown', 10),
    operation('saved-new', 'saved', 20, true, true),
  ]);
  expect(selected?.runId).toBe('unknown-old');
  const summary = editorBoardOperation(selected!);
  expect(summary).toEqual({ phase: 'unknown', updatedAt: 10, applied: false, saved: false, reconciled: false });
  expect(JSON.stringify(summary)).not.toMatch(/保存本文|private|revision|claim|session|token|runId/);
});

it('未解決が無ければ最新を選び、適用済み停止の保存未確認を保持する', () => {
  const selected = selectEditorBoardOperation([
    operation('failed-old', 'failed', 10),
    operation('cancelled-new', 'cancelled', 20, true, false),
  ]);
  expect(editorBoardOperation(selected!)).toEqual({ phase: 'cancelled', updatedAt: 20, applied: true, saved: false, reconciled: false });
});

it('人が確認して再開済みのunknownは未解決として新しいsavedを隠さない', () => {
  const reconciled = { ...operation('unknown-reviewed', 'unknown', 30), reconciliation: {
    reviewId: 'review', sessionId: 'session', revision: 'revision', snapshotHash: 'snapshot', operationHash: 'operation',
    reviewedAt: 31, source: 'human' as const,
  } };
  const selected = selectEditorBoardOperation([reconciled, operation('saved-new-work', 'saved', 40, true, true)]);
  expect(selected?.runId).toBe('saved-new-work');
  expect(editorBoardOperation(reconciled)).toMatchObject({ phase: 'unknown', reconciled: true });

  const active = operation('running', 'running', 10);
  expect(selectEditorBoardOperation([reconciled, active])?.runId).toBe('running');
});

it('旧board応答のfailed欠落をfalseとして読み、未接続の読込失敗は拒否する', () => {
  expect(editorProjectBoardItemSchema.parse({ projectId: 'video',
    editor: { connected: false, ready: false, dirty: false }, operation: null }).editor.failed).toBe(false);
  expect(() => editorProjectBoardItemSchema.parse({ projectId: 'video',
    editor: { connected: false, ready: false, dirty: false, failed: true }, operation: null })).toThrow(/読込失敗/);
});

it('人確認の未知状態と公開対象外フィールドを拒否する', () => {
  const base = { projectId: 'video', editor: { connected: false, ready: false, dirty: false }, operation: null };
  expect(() => editorProjectBoardItemSchema.parse({ ...base, humanReview: 'accepted' })).toThrow();
  expect(() => editorProjectBoardItemSchema.parse({ ...base, humanReview: 'pending', token: 'private-token' })).toThrow();
});

it('人確認は最新runだけでなく案件内の全適用済みrunを集約する', () => {
  const olderPending = reviewed(operation('older', 'saved', 10, true, true), 'pending');
  const newerReviewed = reviewed(operation('newer', 'saved', 20, true, true), 'reviewed');
  expect(editorBoardHumanReview([olderPending, newerReviewed])).toBe('partial');
  expect(editorBoardHumanReview([newerReviewed])).toBe('reviewed');
});

it('未適用のqueued/runningは確認対象にせず、適用済み停止・失敗は対象にする', () => {
  const queued = reviewed(operation('queued', 'queued', 30), 'pending');
  const running = reviewed(operation('running', 'running', 40), 'pending');
  expect(editorBoardHumanReview([queued, running])).toBeNull();

  const cancelled = reviewed(operation('cancelled', 'cancelled', 20, true), 'pending');
  const failed = reviewed(operation('failed', 'failed', 10, true), 'reviewed');
  expect(editorBoardHumanReview([queued, cancelled])).toBe('pending');
  expect(editorBoardHumanReview([cancelled, failed])).toBe('partial');
});

it('台帳を読めない適用済みrunが1件でもあれば確認済みへ倒さない', () => {
  const unavailable = reviewed(operation('unknown-review', 'saved', 10, true, true), 'unavailable');
  const reviewedRun = reviewed(operation('reviewed', 'saved', 20, true, true), 'reviewed');
  expect(editorBoardHumanReview([reviewedRun, unavailable])).toBe('unavailable');
});
