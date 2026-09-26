import { editorChangeSetSchema, type EditorChangeSet } from '../../shared/editorCommands';
import type { EditorDeliveryGuard } from '../../shared/editorDeliveryGuard';
import type { EditorOperationResult } from '../../shared/editorOperations';
import { samePersistedContent, type EditState } from './editState';
import { applyEditorChanges } from './editorCommands';

export interface LiveEditorSnapshot {
  projectId: string; revision: string; state: EditState; dirty: boolean; saving: boolean; humanBusy: boolean;
}
export interface EditorCommandSessionDependencies {
  read(): LiveEditorSnapshot | null;
  /** Must synchronously compare the current revision and commit one existing UI history entry. */
  apply(request: EditorChangeSet): void;
  /** Uses the existing non-overwrite save path. Must retain its session guard across the network call. */
  save(expectedState: EditState, delivery?: EditorDeliveryGuard): Promise<boolean>;
}
type Receipt = { request: EditorChangeSet; applied: EditorOperationResult; result?: EditorOperationResult; saving?: Promise<EditorOperationResult> };
const sameRequest = (a: EditorChangeSet, b: EditorChangeSet) => JSON.stringify(a) === JSON.stringify(b);

/** Browser-session delivery deduplication. Reload creates a new session and cannot reclaim an old delivery.
 * Historical receipts are not commands to reapply after Undo. The server retains cross-client receipts.
 */
export function createEditorCommandSession(deps: EditorCommandSessionDependencies) {
  const receipts = new Map<string, Receipt>();
  function apply(input: unknown): EditorOperationResult {
    const request = editorChangeSetSchema.parse(input);
    const previous = receipts.get(request.operationId);
    if (previous) {
      if (!sameRequest(previous.request, request)) throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が変わっています');
      return previous.applied;
    }
    const current = deps.read();
    if (!current) throw new Error('EDITOR_UNAVAILABLE: 編集画面で案件を開いてください');
    if (current.humanBusy) throw new Error('HUMAN_BUSY: 人がダイアログを操作中です');
    if (current.dirty) throw new Error('UNSAVED_CHANGES: 人の未保存編集があります。保存後に現在の版を取得してください');
    if (current.saving) throw new Error('SAVE_IN_PROGRESS: 保存完了を待ってください');
    const expected = applyEditorChanges(current.state, { projectId: current.projectId, revision: current.revision }, request);
    deps.apply(request); // No await between validation and guarded UI mutation.
    const next = deps.read();
    if (!next || next.projectId !== request.projectId || !samePersistedContent(next.state, expected)) {
      throw new Error('APPLY_UNCONFIRMED: 現在の編集画面で反映を確認できませんでした');
    }
    const result: EditorOperationResult = { phase: 'applied', revision: next.revision, code: null, applied: true, saved: false };
    receipts.set(request.operationId, { request, applied: result });
    return result;
  }

  async function save(input: unknown, delivery?: EditorDeliveryGuard): Promise<EditorOperationResult> {
    const request = editorChangeSetSchema.parse(input);
    const receipt = receipts.get(request.operationId);
    if (!receipt || !sameRequest(receipt.request, request)) throw new Error('OPERATION_NOT_APPLIED: この画面で反映した操作ではありません');
    if (receipt.result) return receipt.result;
    if (receipt.saving) return receipt.saving;
    const failure = (code: string): EditorOperationResult => ({ ...receipt.applied, phase: 'failed', code });
    const current = deps.read();
    // A human Undo/edit/project switch after application invalidates permission to save this delivery.
    if (!current || current.projectId !== request.projectId || current.revision !== receipt.applied.revision) {
      receipt.result = failure('EDIT_CHANGED_BEFORE_SAVE'); return receipt.result;
    }
    if (current.humanBusy || current.saving) {
      receipt.result = failure(current.humanBusy ? 'HUMAN_BUSY' : 'SAVE_IN_PROGRESS'); return receipt.result;
    }
    receipt.saving = (async () => {
      let saved: boolean;
      try { saved = await deps.save(current.state, delivery); }
      // A lost transport result is not proof that nothing was saved. The delivery broker must fence it as unknown.
      catch { throw new Error('SAVE_RESULT_UNKNOWN: 保存の結果を確認できません。内容を再取得してください'); }
      if (!saved) { receipt.result = failure('SAVE_FAILED'); return receipt.result; }
      const after = deps.read();
      // The historical save can succeed while the human moves on. Record that limit instead of claiming current UI equality.
      const stillSame = after?.projectId === request.projectId && after.revision === receipt.applied.revision;
      receipt.result = { ...receipt.applied, phase: 'saved', saved: true,
        code: stillSame ? null : 'SAVED_WITH_LATER_UI_CHANGES' };
      return receipt.result;
    })();
    return receipt.saving;
  }
  return { apply, save, hasApplied(input: unknown) {
    const request = editorChangeSetSchema.parse(input), receipt = receipts.get(request.operationId);
    if (receipt && !sameRequest(receipt.request, request)) throw new Error('OPERATION_CONFLICT: 同じ操作IDの内容が変わっています');
    return receipt !== undefined;
  } };
}
