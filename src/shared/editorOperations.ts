import { z } from 'zod';
import { editorChangeSetSchema } from './editorCommands';
import { editorAgentErrorDetail, type EditorAgentErrorDetail } from './editorAgentErrors';
import {nativeEditorEvidenceSchema,nativeEditorReconciliationSchema} from './nativeEditorEvidence';

const id = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const scriptReconciliationSchema = z.object({
  documentFormat:z.enum(['legacy','sequence-v2']).optional(),
  kind: z.enum(['caption', 'structure']),
  savedState: z.enum(['input', 'proposal', 'diverged']),
  stateHash: sha256,
  inputStateHash: sha256,
  proposalStateHash: sha256,
  fingerprintHash: sha256,
  presenceHash: sha256,
}).strict();
export const editorOperationPhaseSchema = z.enum(['queued', 'running', 'applied', 'saved', 'failed', 'cancelled', 'unknown']);
export const editorOperationResultSchema = z.object({
  phase: z.enum(['applied', 'saved', 'failed', 'cancelled']),
  revision: id.nullable(),
  code: z.string().min(1).max(128).nullable(),
  applied: z.boolean(), saved: z.boolean(),
}).strict().superRefine((result, ctx) => {
  if (result.saved && !result.applied) ctx.addIssue({ code: 'custom', message: '保存済みは適用済みでもあります' });
  if ((result.phase === 'saved') !== result.saved) ctx.addIssue({ code: 'custom', message: '保存状態が一致しません' });
  if (result.phase === 'applied' && !result.applied) ctx.addIssue({ code: 'custom', message: '適用状態が一致しません' });
  if (result.applied && result.revision === null) ctx.addIssue({ code: 'custom', path: ['revision'], message: '適用済みの結果には確認した版が必要です' });
});
export type EditorOperationResult = z.infer<typeof editorOperationResultSchema>;

export const editorOperationSchema = z.object({
  schemaVersion: z.literal(1), runId: id, request: editorChangeSetSchema,
  nativeEvidence:nativeEditorEvidenceSchema.optional(),
  serverInstance: id, createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  phase: editorOperationPhaseSchema, cancelRequested: z.boolean(),
  confirmed: z.object({ applied: z.boolean(), saved: z.boolean() }).strict(),
  claim: z.object({ sessionId: id, token: id }).strict().nullable(),
  result: editorOperationResultSchema.nullable(),
  lateResult: editorOperationResultSchema.nullable(),
  // A transport success cannot become an owner's preference label.
  humanReview: z.literal('pending'),
  reconciliation: z.object({ reviewId: id, sessionId: id, revision: id, snapshotHash: id, operationHash: id,
    reviewedAt: z.number().int().nonnegative(), source: z.enum(['human', 'synthetic']),
    script: scriptReconciliationSchema.optional(), sequence:nativeEditorReconciliationSchema.optional() }).strict().optional(),
}).strict().superRefine((operation, ctx) => {
  const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
  if(!!operation.nativeEvidence!==!!operation.request.sequence)issue('タイムライン編集には実行前後の保存照合が必要です',['nativeEvidence']);
  if(operation.nativeEvidence&&operation.nativeEvidence.documentId!==operation.request.sequence?.documentId)issue('保存照合の編集文書が一致しません',['nativeEvidence','documentId']);
  if(operation.reconciliation&&!!operation.reconciliation.sequence!==!!operation.request.sequence)issue('タイムライン編集の再開確認には保存内容の照合が必要です',['reconciliation','sequence']);
  if (operation.reconciliation && operation.phase !== 'unknown') issue('再開確認は結果不明の実行だけに記録できます', ['reconciliation']);
  if (operation.reconciliation?.script && !operation.request.script) {
    issue('台本の保存照合は台本編集の実行だけに記録できます', ['reconciliation', 'script']);
  }
  if (operation.reconciliation && operation.request.script) {
    if (!operation.reconciliation.script) issue('台本編集の再開確認には保存内容の照合が必要です', ['reconciliation', 'script']);
    else if (operation.reconciliation.script.kind !== operation.request.script.artifact.proposal.kind) {
      issue('台本の保存照合種別が変更案と一致しません', ['reconciliation', 'script', 'kind']);
    }
  }
  const resultApplied = operation.result?.applied ?? false;
  const resultSaved = operation.result?.saved ?? false;
  if (operation.confirmed.applied !== resultApplied || operation.confirmed.saved !== resultSaved) {
    issue('確認済み状態が結果と一致しません', ['confirmed']);
  }

  const expectedResultPhase = operation.phase === 'queued' || operation.phase === 'running' || operation.phase === 'unknown'
    ? null : operation.phase;
  if (expectedResultPhase !== null && operation.result?.phase !== expectedResultPhase) {
    issue('実行状態と結果が一致しません', ['result']);
  }
  if ((operation.phase === 'queued' || operation.phase === 'running') && operation.result !== null) {
    issue('未確定の実行に結果は保存できません', ['result']);
  }
  if (operation.phase === 'unknown' && operation.result !== null && operation.result.phase !== 'applied') {
    issue('結果不明へ移る前に確定できるのは適用結果だけです', ['result']);
  }

  if (operation.phase === 'queued' && operation.claim !== null) issue('未配信の実行に担当はありません', ['claim']);
  if (['running', 'applied', 'saved', 'failed', 'unknown'].includes(operation.phase) && operation.claim === null) {
    issue('配信後の実行には担当が必要です', ['claim']);
  }
  if (operation.phase === 'cancelled' && operation.result?.applied && operation.claim === null) {
    issue('適用後に取り消した実行には担当が必要です', ['claim']);
  }
  if (operation.phase === 'queued' && operation.cancelRequested) {
    issue('取消要求済みの実行は受付状態に残せません', ['cancelRequested']);
  }
  if (operation.phase === 'cancelled' && !operation.cancelRequested) {
    issue('取消結果には取消要求が必要です', ['cancelRequested']);
  }
  if (operation.phase !== 'unknown' && operation.lateResult !== null) {
    issue('遅延結果は結果不明の実行だけに保存できます', ['lateResult']);
  }
});
export type EditorOperation = z.infer<typeof editorOperationSchema>;
export type PublicEditorOperation = Omit<EditorOperation, 'claim' | 'humanReview'> & {
  sessionId: string | null; humanReview: 'pending' | 'partial' | 'reviewed' | 'unavailable';
  errorDetail?: EditorAgentErrorDetail;
  review?: { completed: number; total: number; synthetic: boolean;
    judgments: Array<{ id: string; decision: 'accepted' | 'accepted_modified' | 'rejected' | 'deferred';
      provenance: 'human' | 'imported_human' | 'synthetic' | 'model';
      /** Text chosen by this recorded judgment; not a claim about the current saved project. */
      recordedText?: string } | null> };
};
export function publicEditorOperation(operation: EditorOperation): PublicEditorOperation {
  const { claim, ...rest } = operation;
  const code = operation.phase === 'unknown' ? operation.result?.code ?? 'RESULT_UNKNOWN'
    : operation.phase === 'failed' ? operation.result?.code ?? 'EDITOR_OPERATION_FAILED'
      : operation.phase === 'cancelled' ? operation.result?.code ?? 'EDITOR_OPERATION_CANCELLED' : null;
  const baseDetail = code ? editorAgentErrorDetail(code) : null;
  // A terminal receipt is already durable. Re-sending its original operationId only returns this same receipt;
  // it never retries the underlying edit. Recovery therefore follows the phase, even if the recorded result code
  // (for example STORE_BUSY or SAVE_RESULT_UNKNOWN) has different guidance at a live request boundary.
  const errorDetail = baseDetail && operation.phase === 'unknown'
    ? { ...baseDetail, retryable: false,
      recovery: operation.reconciliation
        ? { action: 'inspect_run' as const, message: 'この結果不明は人が保存状態を確認済みです。editor_runsと現在の編集状態を確認してください。' }
        : { action: 'reconcile_result' as const,
          message: 'editor_runsと編集画面の保存内容を確認し、人が結果を確定してから再開してください。' } }
    : baseDetail && operation.phase === 'failed'
      ? { ...baseDetail, retryable: false,
        ...(baseDetail.recovery.action === 'reconcile_result' || baseDetail.retryable
          ? { recovery: { action: 'inspect_run' as const,
            message: 'この実行は失敗で確定済みです。editor_runsと現在の状態を取得し、未反映なら変更案を再検証して新しいoperationIdで依頼し、反映済みなら保存状態を確認してください。' } } : {}) }
      : baseDetail ? { ...baseDetail, retryable: false,
        recovery: { action: 'inspect_run' as const,
          message: 'この実行は停止済みです。editor_runsと現在の編集状態を確認してください。' } } : null;
  return { ...rest, sessionId: claim?.sessionId ?? null,
    ...(errorDetail ? { errorDetail } : {}) };
}
