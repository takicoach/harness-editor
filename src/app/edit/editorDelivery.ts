import { editorOperationSchema, type EditorOperation, type EditorOperationResult, type PublicEditorOperation } from '../../shared/editorOperations';
import type { EditorChangeSet } from '../../shared/editorCommands';

interface DeliveryDependencies {
  read(): Promise<EditorOperation>;
  acknowledge(result: EditorOperationResult): Promise<PublicEditorOperation>;
  apply(request: EditorChangeSet): EditorOperationResult | Promise<EditorOperationResult>;
  save(request: EditorChangeSet): Promise<EditorOperationResult>;
  validate?(request: EditorChangeSet): Promise<void>;
}
export type DeliveryOutcome = { kind: 'finished'; operation: PublicEditorOperation }
  | { kind: 'retry' } | { kind: 'unknown'; message: string };

/** Each network acknowledgement is retriable; each UI effect is deduplicated by the session bridge. */
export async function executeEditorDelivery(initial: EditorOperation, dependencies: DeliveryDependencies): Promise<DeliveryOutcome> {
  const expected = editorOperationSchema.parse(initial);
  const matches = (operation: EditorOperation) => operation.runId === expected.runId
    && operation.claim?.token === expected.claim?.token && operation.claim?.sessionId === expected.claim?.sessionId
    && JSON.stringify(operation.request) === JSON.stringify(expected.request);
  const read = async () => {
    const operation = editorOperationSchema.parse(await dependencies.read());
    if (!matches(operation)) throw new Error('DELIVERY_CHANGED: 実行担当または内容が変わりました');
    return operation;
  };
  const finish = async (result: EditorOperationResult): Promise<DeliveryOutcome> => {
    try {
      const operation = await dependencies.acknowledge(result);
      return operation.phase === 'unknown' ? { kind: 'unknown', message: '保存結果を確認してから再開してください' }
        : { kind: 'finished', operation };
    } catch { return { kind: 'retry' }; }
  };
  let operation: EditorOperation;
  try { operation = await read(); } catch { return { kind: 'retry' }; }
  if (!['running', 'applied'].includes(operation.phase)) {
    return operation.phase === 'unknown' ? { kind: 'unknown', message: '前の実行結果の確認が必要です' } : { kind: 'retry' };
  }
  if (operation.cancelRequested && !operation.confirmed.applied) {
    return finish({ phase: 'cancelled', revision: null, code: 'CANCELLED_BEFORE_APPLY', applied: false, saved: false });
  }
  let applied: EditorOperationResult;
  if (dependencies.validate) {
    try { await dependencies.validate(operation.request); }
    catch {
      if (operation.confirmed.applied) return { kind: 'unknown', message: '反映済みの内容を確認できません。実行履歴を確認してください' };
      return finish({ phase: 'failed', revision: null, code: 'SCRIPT_INPUT_CHANGED', applied: false, saved: false });
    }
    try { operation = await read(); } catch { return { kind: 'retry' }; }
    if (!['running', 'applied'].includes(operation.phase)) return { kind: 'retry' };
    if (operation.cancelRequested && !operation.confirmed.applied) {
      return finish({ phase: 'cancelled', revision: null, code: 'CANCELLED_BEFORE_APPLY', applied: false, saved: false });
    }
  }
  try { applied = await dependencies.apply(operation.request); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.split(':', 1)[0]!;
    const knownNoEffect = ['EDITOR_UNAVAILABLE', 'HUMAN_BUSY', 'UNSAVED_CHANGES', 'SAVE_IN_PROGRESS',
      'PROJECT_MISMATCH', 'REVISION_CONFLICT', 'TARGET_NOT_FOUND', 'CONTENT_CONFLICT', 'RANGE_CONFLICT',
      'STALE_SCRIPT_EDIT', 'SCRIPT_EDIT_SEGMENT_SPEED_CONFLICT', 'SCRIPT_EDIT_SEGMENT_LAYOUT_CONFLICT', 'SCRIPT_EDIT_TRANSITION_CONFLICT',
      'SOURCE_REFERENCE_REQUIRED','SOURCE_REFERENCE_CONFLICT','SOURCE_OCCURRENCE_UNAVAILABLE','AMBIGUOUS_SOURCE_OCCURRENCE','NATIVE_SCRIPT_REVIEW_REQUIRED','DELIVERY_FENCED'];
    if (knownNoEffect.includes(code) && !operation.confirmed.applied) {
      return finish({ phase: 'failed', revision: null, code, applied: false, saved: false });
    }
    return { kind: 'unknown', message: '編集への反映を確認できません。画面で内容を確認してください' };
  }
  try {
    const checkpoint = await dependencies.acknowledge(applied);
    if (checkpoint.phase === 'unknown') return { kind: 'unknown', message: '反映後に接続が切れました。内容を確認してください' };
    operation = await read();
  } catch { return { kind: 'retry' }; }
  if (operation.phase !== 'applied') return { kind: 'unknown', message: '保存前の実行状態を確認できません' };
  if (operation.cancelRequested) return finish({ ...applied, phase: 'cancelled', code: 'CANCELLED_AFTER_APPLY' });
  try { return finish(await dependencies.save(operation.request)); }
  catch { return { kind: 'unknown', message: '保存の返事を確認できません。内容を確認してから再開してください' }; }
}
