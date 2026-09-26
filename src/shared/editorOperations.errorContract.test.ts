import { expect, it } from 'vitest';
import { publicEditorOperation, type EditorOperation } from './editorOperations';

const base = { schemaVersion: 1 as const, runId: 'run-1', serverInstance: 'server-1', createdAt: 1, updatedAt: 1,
  request: { schemaVersion: 1 as const, operationId: 'op-1', projectId: 'project-1', baseRevision: 'r1',
    changes: [{ type: 'set_telop_text' as const, elementId: 'telop-1', before: 'before', after: 'after',
      sourceFrameRange: { start: 0, end: 30 } }] }, cancelRequested: false,
  claim: { sessionId: 'session-1', token: 'secret-token' }, humanReview: 'pending' as const, lateResult: null,
};

it('公開receiptはfailedと結果不明に共通の再送可否・復旧案内を派生する', () => {
  const failed = publicEditorOperation({ ...base, phase: 'failed', confirmed: { applied: false, saved: false },
    result: { phase: 'failed', revision: null, code: 'SAVE_RESULT_UNKNOWN', applied: false, saved: false } } as EditorOperation);
  expect(failed.errorDetail).toMatchObject({ code: 'SAVE_RESULT_UNKNOWN', retryable: false,
    recovery: { action: 'inspect_run' } });

  const unknown = publicEditorOperation({ ...base, phase: 'unknown', confirmed: { applied: false, saved: false }, result: null } as EditorOperation);
  expect(unknown.errorDetail).toMatchObject({ code: 'RESULT_UNKNOWN', retryable: false,
    recovery: { action: 'reconcile_result' } });
  expect(JSON.stringify(unknown)).not.toContain('secret-token');
});
