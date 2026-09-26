import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { editorChangeSetSchema } from '../shared/editorCommands';
import { editorOperationResultSchema, editorOperationSchema, type EditorOperation } from '../shared/editorOperations';
import { readAtomicJsonFile, updateAtomicJsonFile } from '../shared/atomicJsonFile.node';
import {nativeEditorEvidenceSchema,type NativeEditorEvidence} from '../shared/nativeEditorEvidence';

const journalSchema = z.object({ schemaVersion: z.literal(1), operations: z.array(editorOperationSchema) }).strict();
type Journal = z.infer<typeof journalSchema>;
const unfinished = (op: EditorOperation) => ['queued', 'running', 'applied'].includes(op.phase);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const editorOperationHash = (operation: EditorOperation): string => createHash('sha256').update(JSON.stringify(operation)).digest('hex');

/** Receipts for typed editor mutations, not a replacement for the existing instruction inbox/job queue.
 * No project files are written here. Each update rereads the file under a cross-process lock.
 */
export class EditorOperationStore {
  constructor(readonly file: string, readonly serverInstance: string, private readonly now = Date.now) {}

  private readJournal(): Journal {
    return readAtomicJsonFile(this.file, (input) => {
      const journal = journalSchema.parse(input);
      const ids = new Set<string>(); const runs = new Set<string>();
      for (const op of journal.operations) {
        if (ids.has(op.request.operationId) || runs.has(op.runId)) throw new Error('JOURNAL_INVALID: 実行IDが重複しています');
        ids.add(op.request.operationId); runs.add(op.runId);
        if (op.confirmed.saved && !op.confirmed.applied) throw new Error('JOURNAL_INVALID: 保存確認が不正です');
        if (op.phase === 'saved' && !op.confirmed.saved) throw new Error('JOURNAL_INVALID: 保存結果がありません');
        if (op.phase === 'queued' && (op.claim || op.confirmed.applied)) throw new Error('JOURNAL_INVALID: 未実行状態が不正です');
        if (['running', 'applied'].includes(op.phase) && !op.claim) throw new Error('JOURNAL_INVALID: 実行担当がありません');
      }
      return journal;
    }, () => ({ schemaVersion: 1, operations: [] }));
  }
  list(projectId?: string): EditorOperation[] {
    return this.readJournal().operations.filter((op) => projectId === undefined || op.request.projectId === projectId);
  }
  get(runId: string): EditorOperation {
    const operation = this.list().find((op) => op.runId === runId);
    if (!operation) throw new Error('RUN_NOT_FOUND: 実行がありません');
    return operation;
  }
  private change(runId: string, update: (op: EditorOperation) => EditorOperation): EditorOperation {
    const journal = updateAtomicJsonFile(this.file, () => this.readJournal(), (current) => {
      const index = current.operations.findIndex((op) => op.runId === runId);
      if (index < 0) throw new Error('RUN_NOT_FOUND: 実行がありません');
      const previous = current.operations[index]!;
      const next = update(previous);
      if (next === previous) return current;
      const operations = current.operations.slice();
      operations[index] = editorOperationSchema.parse({ ...next, updatedAt: this.now() });
      return { ...current, operations };
    });
    return journal.operations.find((op) => op.runId === runId)!;
  }

  enqueue(input: unknown, nativeEvidence?:NativeEditorEvidence): EditorOperation {
    const request = editorChangeSetSchema.parse(input);
    const evidence=nativeEvidence===undefined?undefined:nativeEditorEvidenceSchema.parse(nativeEvidence);
    const journal = updateAtomicJsonFile(this.file, () => this.readJournal(), (current) => {
      const existing = current.operations.find((op) => op.request.operationId === request.operationId);
      if (existing) {
        if (!same(existing.request, request)) throw new Error('OPERATION_CONFLICT: 同じ操作IDに別の内容は指定できません');
        if(evidence&&!same(existing.nativeEvidence,evidence))throw new Error('OPERATION_CONFLICT: 編集前後の確認内容が変わっています');
        return current;
      }
      if(!!request.sequence!==!!evidence)throw new Error('REVIEW_UNAVAILABLE: タイムライン編集の保存照合がありません');
      if (current.operations.some((op) => op.request.projectId === request.projectId && op.phase === 'unknown' && !op.reconciliation)) {
        throw new Error('RECONCILIATION_REQUIRED: 前の編集結果が不明です。画面と保存内容を確認してから再開してください');
      }
      if (current.operations.some((op) => op.request.projectId === request.projectId && unfinished(op))) {
        throw new Error('PROJECT_BUSY: この案件への編集を実行中です');
      }
      const at = this.now();
      const operation: EditorOperation = { schemaVersion: 1, runId: randomUUID(), request, serverInstance: this.serverInstance,
        ...(evidence?{nativeEvidence:evidence}:{}),
        createdAt: at, updatedAt: at, phase: 'queued', cancelRequested: false, confirmed: { applied: false, saved: false },
        claim: null, result: null, lateResult: null, humanReview: 'pending' };
      return { ...current, operations: [...current.operations, editorOperationSchema.parse(operation)] };
    });
    return journal.operations.find((op) => op.request.operationId === request.operationId)!;
  }

  /**
   * A persisted script request that never reached a browser is safe to attach to
   * the current browser revision. Every intent-bearing field remains immutable;
   * only the transport revision may change before the first claim.
   */
  rebindQueuedScript(runId: string, input: unknown): EditorOperation {
    const request = editorChangeSetSchema.parse(input);
    return this.change(runId, (op) => {
      if (op.phase !== 'queued' || op.claim !== null || op.serverInstance !== this.serverInstance) {
        throw new Error('NOT_CLAIMABLE: この編集操作はすでに画面へ渡されています');
      }
      const { baseRevision: _previousRevision, ...previousIntent } = op.request;
      const { baseRevision: _nextRevision, ...nextIntent } = request;
      if (!op.request.script || !request.script || !same(previousIntent, nextIntent)) {
        throw new Error('OPERATION_CONFLICT: 同じ操作IDに別の内容は指定できません');
      }
      return same(op.request, request) ? op : { ...op, request };
    });
  }

  /** Persist the unique delivery token before handing work to one specific live UI session. */
  claim(runId: string, sessionId: string): EditorOperation {
    if (!sessionId.trim() || sessionId.length > 256) throw new Error('SESSION_INVALID: 編集画面を指定してください');
    return this.change(runId, (op) => {
      if (op.phase !== 'queued' || op.serverInstance !== this.serverInstance) throw new Error('NOT_CLAIMABLE: 再実行できない状態です');
      return { ...op, phase: 'running', claim: { sessionId, token: randomUUID() } };
    });
  }

  cancel(runId: string): EditorOperation {
    return this.change(runId, (op) => {
      if (!unfinished(op) || op.cancelRequested) return op;
      if (op.phase === 'queued') return { ...op, phase: 'cancelled', cancelRequested: true,
        result: { phase: 'cancelled', revision: null, code: 'CANCELLED_BEFORE_START', applied: false, saved: false } };
      // Execution may already have affected the UI. Its actual outcome still has to be acknowledged.
      return { ...op, cancelRequested: true };
    });
  }

  /** Release the project after a separate review of its current saved state. Never invent the old outcome. */
  reconcile(runId: string, review: NonNullable<EditorOperation['reconciliation']>): EditorOperation {
    return this.change(runId, (op) => {
      if (op.phase !== 'unknown') throw new Error('REVIEW_NOT_REQUIRED: 結果不明の実行ではありません');
      if (op.reconciliation) {
        if (!same(op.reconciliation, review)) throw new Error('REVIEW_CONFLICT: この実行の再開確認は記録済みです');
        return op;
      }
      if (editorOperationHash(op) !== review.operationHash) throw new Error('REVIEW_STALE: 実行結果が変わりました。確認を更新してください');
      return { ...op, reconciliation: review };
    });
  }

  acknowledge(runId: string, sessionId: string, token: string, input: unknown): EditorOperation {
    const result = editorOperationResultSchema.parse(input);
    return this.change(runId, (op) => {
      if (op.claim?.sessionId !== sessionId || op.claim.token !== token) throw new Error('CLAIM_MISMATCH: 実行担当が異なります');
      if (op.phase === 'unknown' || op.serverInstance !== this.serverInstance) {
        // Keep the observation for reconciliation, but never convert a fenced old worker into a new success.
        if (op.lateResult && !same(op.lateResult, result)) throw new Error('LATE_RESULT_CONFLICT: 遅延結果が一致しません');
        return op.lateResult ? op : { ...op, lateResult: result };
      }
      if (op.result && same(op.result, result)) return op; // Retrying an acknowledgement never reapplies the edit.
      if (!['running', 'applied'].includes(op.phase)) throw new Error('RUN_FINISHED: 実行は終了しています');
      if (op.confirmed.applied && !result.applied) throw new Error('RESULT_REGRESSION: 適用済みの事実を取り消せません');
      if (op.result?.phase === 'applied') {
        if (result.phase === 'applied' || (result.applied && result.revision !== op.result.revision)) {
          throw new Error('CHECKPOINT_CONFLICT: 確認済みの適用結果と一致しません');
        }
      }
      if (result.phase === 'saved' && op.phase !== 'applied') throw new Error('APPLY_UNCONFIRMED: 先に適用結果を確認してください');
      return { ...op, phase: result.phase, result, confirmed: { applied: result.applied, saved: result.saved } };
    });
  }

  /** Invoke only when a single owning editor server has acquired its root lock. No implicit retry. */
  recoverInterrupted(): void {
    updateAtomicJsonFile(this.file, () => this.readJournal(), (current) => {
      let changed = false;
      const operations = current.operations.map((op): EditorOperation => {
        if (!unfinished(op) || op.serverInstance === this.serverInstance) return op;
        changed = true;
        // A queued operation has not reached a browser and therefore cannot have affected project state.
        // Transfer it to the new owning server so it remains safely claimable after restart.
        if (op.phase === 'queued') return { ...op, serverInstance: this.serverInstance, updatedAt: this.now() };
        return { ...op, phase: 'unknown', updatedAt: this.now() };
      });
      // Validate before atomic rename so recovery never persists a state the normal read path rejects.
      return changed ? journalSchema.parse({ ...current, operations }) : current;
    });
  }

  /** A vanished browser may have edited or saved before disconnecting; retain its confirmed checkpoints. */
  disconnect(sessionId: string): void {
    for (const operation of this.list().filter((op) => op.claim?.sessionId === sessionId && unfinished(op))) {
      this.change(operation.runId, (op) => unfinished(op) ? { ...op, phase: 'unknown' } : op);
    }
  }
}
