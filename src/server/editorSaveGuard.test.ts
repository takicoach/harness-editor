import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorAgentService } from './editorAgentService';
import { EditorOperationStore } from './editorOperationStore';
import { assertEditorDeliveryMaySave } from './editorSaveGuard';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'editor-save-guard-')); directories.push(directory);
  let now = 1000;
  const store = new EditorOperationStore(join(directory, 'operations.json'), 'a', () => now);
  const service = new EditorAgentService(store, () => {}, () => now, 100);
  service.heartbeat({ sessionId: 'window-a', sessionKey: 'a'.repeat(32), sequence: 1,
    snapshot: { status: 'ready', projectId: 'a', revision: 'r1', dirty: false, saving: false, humanBusy: false,
      elements: [{ id: '1', text: 'before', sourceFrameRange: { start: 0, end: 30 } }] } });
  const op = service.enqueue('window-a', { schemaVersion: 1, operationId: 'op', projectId: 'a', baseRevision: 'r1',
    changes: [{ type: 'set_telop_text', elementId: '1', before: 'before', after: 'after', sourceFrameRange: { start: 0, end: 30 } }] });
  const claim = store.get(op.runId).claim!;
  const headers = { 'x-harness-editor-run': op.runId, 'x-harness-editor-token': claim.token };
  const apply = () => store.acknowledge(op.runId, claim.sessionId, claim.token,
    { phase: 'applied', revision: 'r2', code: null, applied: true, saved: false });
  return { service, store, op, headers, apply, expire: () => { now = 1100; } };
}
describe('既存保存の直前に古いAI担当を停止する', () => {
  it('通常UIは従来どおり、AIは現在の担当・適用確認がそろった場合だけ通す', () => {
    expect(() => assertEditorDeliveryMaySave({}, 'a')).not.toThrow();
    const f = fixture();
    expect(() => assertEditorDeliveryMaySave(f.headers, 'a', f.service)).toThrow(/DELIVERY_FENCED/);
    f.apply(); expect(() => assertEditorDeliveryMaySave(f.headers, 'a', f.service)).not.toThrow();
    expect(() => assertEditorDeliveryMaySave(f.headers, 'b', f.service)).toThrow(/DELIVERY_FENCED/);
    expect(() => assertEditorDeliveryMaySave({ ...f.headers, 'x-harness-editor-token': 'wrong' }, 'a', f.service)).toThrow(/DELIVERY_FENCED/);
  });
  it('期限切れ・取消・再起動後の遅いPUTを止める', () => {
    const expired = fixture(); expired.apply(); expired.expire();
    expect(() => assertEditorDeliveryMaySave(expired.headers, 'a', expired.service)).toThrow(/DELIVERY_FENCED/);
    expect(expired.store.get(expired.op.runId).phase).toBe('unknown');
    const cancelled = fixture(); cancelled.apply(); cancelled.service.cancel(cancelled.op.runId);
    expect(() => assertEditorDeliveryMaySave(cancelled.headers, 'a', cancelled.service)).toThrow(/DELIVERY_FENCED/);
    const restarted = fixture(); restarted.apply();
    const next = new EditorOperationStore(restarted.store.file, 'b'); next.recoverInterrupted();
    expect(() => assertEditorDeliveryMaySave(restarted.headers, 'a', new EditorAgentService(next, () => {}))).toThrow(/DELIVERY_FENCED/);
  });
  it('不完全なheaderや接続不明で従来の通常保存へ抜けない', () => {
    const f = fixture(); f.apply();
    expect(() => assertEditorDeliveryMaySave({ 'x-harness-editor-run': f.op.runId }, 'a', f.service)).toThrow(/INVALID_DELIVERY_GUARD/);
    expect(() => assertEditorDeliveryMaySave(f.headers, 'a')).toThrow(/EDITOR_SERVICE_UNAVAILABLE/);
  });
});
