import { describe, expect, it, vi } from 'vitest';
import { executeEditorDelivery } from './editorDelivery';
import { publicEditorOperation, type EditorOperation, type EditorOperationResult } from '../../shared/editorOperations';

const operation = (): EditorOperation => ({ schemaVersion: 1, runId: 'run-a', serverInstance: 'server-a', createdAt: 1, updatedAt: 1,
  phase: 'running', claim: { sessionId: 'window-a', token: 'token-a' }, confirmed: { applied: false, saved: false },
  cancelRequested: false, result: null, lateResult: null, humanReview: 'pending',
  request: { schemaVersion: 1, operationId: 'op-a', projectId: 'project-a', baseRevision: 'rev-a',
    changes: [{ type: 'set_telop_text', elementId: '1', before: 'before', after: 'after', sourceFrameRange: { start: 0, end: 30 } }] } });
const applied: EditorOperationResult = { phase: 'applied', revision: 'rev-b', code: null, applied: true, saved: false };
const saved: EditorOperationResult = { ...applied, phase: 'saved', saved: true };
function setup() {
  let current = operation();
  const read = vi.fn(async () => structuredClone(current));
  const acknowledge = vi.fn(async (result: EditorOperationResult) => {
    current = { ...current, phase: result.phase, result, confirmed: { applied: result.applied, saved: result.saved } };
    return publicEditorOperation(current);
  });
  const deps = { read, acknowledge, apply: vi.fn(() => applied), save: vi.fn(async () => saved) };
  return { deps, current: () => current, update: (patch: Partial<EditorOperation>) => { current = { ...current, ...patch }; } };
}
describe('適用確認後だけ保存するブラウザ配送', () => {
  it.each(['STALE_SCRIPT_EDIT', 'SCRIPT_EDIT_SEGMENT_SPEED_CONFLICT', 'SCRIPT_EDIT_SEGMENT_LAYOUT_CONFLICT', 'SCRIPT_EDIT_TRANSITION_CONFLICT'])(
    '台本の適用前検証 %s は副作用のない失敗として記録する', async code => {
      const { deps } = setup();
      deps.apply.mockImplementation(() => { throw new Error(`${code}: rejected before mutation`); });
      expect(await executeEditorDelivery(operation(), deps)).toMatchObject({ kind: 'finished', operation: {
        phase: 'failed', confirmed: { applied: false, saved: false }, result: { code },
      } });
      expect(deps.save).not.toHaveBeenCalled();
    });
  it('再検証中の取消は適用も保存もしない', async () => {
    const { deps, update } = setup();
    expect(await executeEditorDelivery(operation(), { ...deps, validate: async () => { update({ cancelRequested: true }); } }))
      .toMatchObject({ kind: 'finished', operation: { phase: 'cancelled', confirmed: { applied: false, saved: false } } });
    expect(deps.apply).not.toHaveBeenCalled(); expect(deps.save).not.toHaveBeenCalled();
  });
  it('適用→適用記録→担当再照会→保存→保存記録の順を守る', async () => {
    const { deps } = setup();
    const result = await executeEditorDelivery(operation(), deps);
    expect(result).toMatchObject({ kind: 'finished', operation: { phase: 'saved', humanReview: 'pending' } });
    expect(deps.acknowledge.mock.calls.map(([value]) => value.phase)).toEqual(['applied', 'saved']);
    expect(deps.read).toHaveBeenCalledTimes(2);
    expect(deps.apply.mock.invocationCallOrder[0]).toBeLessThan(deps.acknowledge.mock.invocationCallOrder[0]!);
    expect(deps.acknowledge.mock.invocationCallOrder[0]).toBeLessThan(deps.save.mock.invocationCallOrder[0]!);
  });
  it('適用確認の返事がない間は保存しない', async () => {
    const { deps } = setup(); deps.acknowledge.mockRejectedValueOnce(new Error('lost response'));
    expect(await executeEditorDelivery(operation(), deps)).toEqual({ kind: 'retry' });
    expect(deps.apply).toHaveBeenCalledOnce(); expect(deps.save).not.toHaveBeenCalled();
  });
  it('適用前の取消は画面を変更せず、適用後の取消は保存を止める', async () => {
    const first = setup(); first.update({ cancelRequested: true });
    expect(await executeEditorDelivery(operation(), first.deps)).toMatchObject({ kind: 'finished',
      operation: { phase: 'cancelled', confirmed: { applied: false, saved: false } } });
    expect(first.deps.apply).not.toHaveBeenCalled(); expect(first.deps.save).not.toHaveBeenCalled();
    const second = setup();
    second.deps.read.mockImplementation(async () => ({ ...second.current(), cancelRequested: second.current().phase === 'applied' }));
    expect(await executeEditorDelivery(operation(), second.deps)).toMatchObject({ kind: 'finished',
      operation: { phase: 'cancelled', confirmed: { applied: true, saved: false } } });
    expect(second.deps.save).not.toHaveBeenCalled();
  });
  it('保存結果が不明なら成功/失敗の記録を偽造しない', async () => {
    const { deps } = setup(); deps.save.mockRejectedValueOnce(new Error('SAVE_RESULT_UNKNOWN'));
    expect(await executeEditorDelivery(operation(), deps)).toMatchObject({ kind: 'unknown' });
    expect(deps.acknowledge.mock.calls.map(([value]) => value.phase)).toEqual(['applied']);
  });
  it('適用前の版不一致は副作用なしの失敗、適用確認不能は結果不明にする', async () => {
    const first = setup(); first.deps.apply.mockImplementation(() => { throw new Error('REVISION_CONFLICT: changed'); });
    expect(await executeEditorDelivery(operation(), first.deps)).toMatchObject({ kind: 'finished',
      operation: { phase: 'failed', confirmed: { applied: false, saved: false } } });
    const second = setup(); second.deps.apply.mockImplementation(() => { throw new Error('APPLY_UNCONFIRMED'); });
    expect(await executeEditorDelivery(operation(), second.deps)).toMatchObject({ kind: 'unknown' });
    expect(second.deps.acknowledge).not.toHaveBeenCalled();
  });
  it('担当取り違え・再起動で結果不明となった実行を保存しない', async () => {
    const first = setup(); first.update({ claim: { sessionId: 'window-b', token: 'token-b' } });
    expect(await executeEditorDelivery(operation(), first.deps)).toMatchObject({ kind: 'retry' });
    expect(first.deps.apply).not.toHaveBeenCalled();
    const second = setup();
    second.deps.read.mockImplementation(async () => second.current().phase === 'applied'
      ? { ...second.current(), phase: 'unknown' } : second.current());
    expect(await executeEditorDelivery(operation(), second.deps)).toMatchObject({ kind: 'unknown' });
    expect(second.deps.save).not.toHaveBeenCalled();
  });
});
