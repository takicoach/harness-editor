import { describe, expect, it } from 'vitest';
import { checkHandoffTarget, checkOperationId, handoffRequestHash, MAX_PAYLOAD_DEPTH, OPERATION_ID, replayHandoff, stableJson, type HandoffFail } from './agentHandoff';

class TestError extends Error { constructor(readonly code: string, message: string, readonly recovery: string) { super(message); } }
const fail: HandoffFail = (code, message, recovery) => new TestError(code, message, recovery);
const caught = (run: () => unknown): TestError => { try { run(); } catch (error) { return error as TestError; } throw new Error('例外が出ませんでした'); };

describe('照合・再送判定の共通関数', () => {
  it('stableJson は鍵の順に依らず同じ文字列。入れ子が深すぎれば INVALID_INPUT（スライドと同じ文言）', () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: undefined }] }, 'x_read', fail)).toBe('{"a":[1,{"d":2}],"b":1}');
    let deep: unknown = 1;
    for (let index = 0; index < MAX_PAYLOAD_DEPTH + 1; index += 1) deep = [deep];
    expect(caught(() => stableJson(deep, 'slides_read', fail))).toMatchObject({ code: 'INVALID_INPUT', message: '回答の入れ子が深すぎます（32 段まで）',
      recovery: 'slides_read の schemas の形に合わせた JSON で送り直してください' });
  });
  it('handoffRequestHash は道具名と中身の指紋（鍵の順に依らない）', () => {
    expect(handoffRequestHash('apply-outline', { b: 1, a: 2 }, 'x', fail)).toBe(handoffRequestHash('apply-outline', { a: 2, b: 1 }, 'x', fail));
    expect(handoffRequestHash('apply-outline', { a: 1 }, 'x', fail)).not.toBe(handoffRequestHash('cancel', { a: 1 }, 'x', fail));
  });
  it('operationId の形', () => {
    expect(OPERATION_ID.test('op-2026-10-08:1')).toBe(true);
    expect(() => checkOperationId('op-1', fail)).not.toThrow();
    expect(caught(() => checkOperationId('-bad', fail))).toMatchObject({ code: 'INVALID_INPUT', recovery: '毎回新しい operationId（例: 日時と連番）を付けてください' });
  });
  it('対象の照合: セッション・文書 ID・版（スライドと同じ文言）', () => {
    const state = { document: { id: 'doc', revision: 3 } };
    expect(checkHandoffTarget({ documentId: 'doc', expectedRevision: 3 }, () => state, 'slides_read', fail)).toBe(state);
    expect(caught(() => checkHandoffTarget({ documentId: 'doc', expectedRevision: 3 }, () => { throw new Error('gone'); }, 'slides_read', fail)))
      .toMatchObject({ code: 'SESSION_CHANGED', message: '編集セッションが変わりました（エディタの再起動や読み直しのあと）', recovery: 'slides_read で sessionId と revision を取り直してから、もう一度送ってください' });
    expect(caught(() => checkHandoffTarget({ documentId: 'other', expectedRevision: 3 }, () => state, 'slides_read', fail))).toMatchObject({ code: 'DOCUMENT_MISMATCH', recovery: 'slides_read で documentId を取り直してください' });
    expect(caught(() => checkHandoffTarget({ documentId: 'doc', expectedRevision: 2 }, () => state, 'slides_read', fail)))
      .toMatchObject({ code: 'REVISION_CONFLICT', message: '版が変わっています（今は 3）。人の編集と重なりました' });
  });
  it('同じ操作の再送: 記録が無ければ null、同じ中身なら replayed、違えば OPERATION_MISMATCH', () => {
    expect(replayHandoff(undefined, 'h', fail)).toBeNull();
    expect(replayHandoff({ requestHash: 'h', result: { status: 'applied', replayed: false } }, 'h', fail)).toEqual({ status: 'applied', replayed: true });
    expect(caught(() => replayHandoff({ requestHash: 'h', result: {} }, 'other', fail))).toMatchObject({ code: 'OPERATION_MISMATCH' });
  });
});
