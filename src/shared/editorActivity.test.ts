import { describe, expect, it } from 'vitest';
import type { PublicEditorOperation } from './editorOperations';
import { editorOperationActivityPage } from './editorActivity';

const operation = (index: number): PublicEditorOperation => ({
  schemaVersion: 1, runId: `run-${index}`, serverInstance: 'server', createdAt: index, updatedAt: index,
  phase: 'saved', cancelRequested: false, confirmed: { applied: true, saved: true }, sessionId: null,
  result: { phase: 'saved', revision: `revision-${index}`, code: null, applied: true, saved: true }, lateResult: null,
  humanReview: index === 0 ? 'pending' : 'reviewed',
  request: { schemaVersion: 1, operationId: `operation-${index}`, projectId: 'video', baseRevision: `base-${index}`,
    changes: [{ type: 'set_telop_text', elementId: '1', before: `before-${index}`, after: `after-${index}`,
      sourceFrameRange: { start: 0, end: 30 } }] },
});

describe('editorOperationActivityPage', () => {
  it('引数なしは従来どおり最新20件を返し、古い未確認へ続ける', () => {
    const operations = Array.from({ length: 21 }, (_, index) => operation(index));
    const latest = editorOperationActivityPage(operations, undefined);
    expect(latest.operations.map((item) => item.runId)).toEqual(Array.from({ length: 20 }, (_, index) => `run-${20 - index}`));
    expect(latest).toMatchObject({ total: 21, nextOffset: 1 });
    expect(editorOperationActivityPage(operations, latest.nextOffset!).operations.map((item) => item.runId)).toEqual(['run-0']);
  });

  it('初回offset=0は省略時と同じ最新pageを返し、続きは返却された正のcursorで取得する', () => {
    const operations = Array.from({ length: 21 }, (_, index) => operation(index));
    expect(editorOperationActivityPage(operations, 0)).toEqual(editorOperationActivityPage(operations, undefined));
    expect(editorOperationActivityPage(operations, 0).nextOffset).toBe(1);
  });

  it('page間に30件追記されても旧cursorをずらさず、最新から読み直せば中間へ到達する', () => {
    const initial = Array.from({ length: 21 }, (_, index) => operation(index));
    const first = editorOperationActivityPage(initial, undefined);
    const expanded = Array.from({ length: 51 }, (_, index) => operation(index));
    expect(editorOperationActivityPage(expanded, first.nextOffset!).operations.map((item) => item.runId)).toEqual(['run-0']);

    const refreshed = editorOperationActivityPage(expanded, undefined);
    expect(refreshed.nextOffset).toBe(31);
    const older = editorOperationActivityPage(expanded, refreshed.nextOffset!);
    expect(older.operations.map((item) => item.runId)).toContain('run-25');
  });

  it('不正な件数とcursorを拒否する', () => {
    const operations = [operation(0)];
    for (const [offset, limit] of [[undefined, 0], [undefined, 101], [-1, 20], [2, 20], [Number.NaN, 20]] as const) {
      expect(() => editorOperationActivityPage(operations, offset, limit)).toThrow(/INVALID_PAGE/);
    }
  });
});
