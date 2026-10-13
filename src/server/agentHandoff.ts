/**
 * AI からの書き込みの受け渡しの共通部分（スライドから切り出し。動作と文言は変えていない）。
 * 対象の照合（セッション・文書 ID・版）・同じ操作の再送判定・操作 ID の形・入れ子の深さの上限。
 * 操作記録・保存・修復回数は各道具が持つ（ここへは移さない）。
 */
import { createHash } from 'node:crypto';

export const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** 回答の入れ子の上限。正しい回答はこれよりずっと浅い。深すぎる入力は指紋の計算や検証より前に断る（再帰で落ちないように）。 */
export const MAX_PAYLOAD_DEPTH = 32;
export type HandoffErrorCode = 'INVALID_INPUT' | 'SESSION_CHANGED' | 'DOCUMENT_MISMATCH' | 'REVISION_CONFLICT' | 'OPERATION_MISMATCH';
/** 呼び出し側のエラー型を作る（スライドは SlidesAgentError）。 */
export type HandoffFail = (code: HandoffErrorCode, message: string, recovery: string) => Error;

/** 鍵の順に依らない JSON。reader は読み直しの道具の名前（例 slides_read）。 */
export function stableJson(value: unknown, reader: string, fail: HandoffFail, depth = 0): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (depth >= MAX_PAYLOAD_DEPTH) throw fail('INVALID_INPUT', `回答の入れ子が深すぎます（${MAX_PAYLOAD_DEPTH} 段まで）`, `${reader} の schemas の形に合わせた JSON で送り直してください`);
  if (Array.isArray(value)) return '[' + value.map(item => stableJson(item, reader, fail, depth + 1)).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + stableJson(object[key], reader, fail, depth + 1)).join(',') + '}';
}
/** 同じ要求かどうかの指紋。セッション ID は再起動で変わるので、呼び出し側が input に含めない。 */
export function handoffRequestHash(tool: string, input: Record<string, unknown>, reader: string, fail: HandoffFail): string {
  return createHash('sha256').update(stableJson({ tool, ...input }, reader, fail)).digest('hex');
}
export function checkOperationId(operationId: unknown, fail: HandoffFail): asserts operationId is string {
  if (typeof operationId !== 'string' || !OPERATION_ID.test(operationId)) throw fail('INVALID_INPUT', 'operationId は英数字で始まる 100 文字以内にしてください', '毎回新しい operationId（例: 日時と連番）を付けてください');
}
/** 対象の照合。inspect はセッションが変わっていたら例外を投げる（スライドは SlidesService.inspect）。 */
export function checkHandoffTarget<S extends { document: { id: string; revision: number } }>(input: { documentId: string; expectedRevision: number }, inspect: () => S, reader: string, fail: HandoffFail): S {
  let state: S;
  try { state = inspect(); }
  catch { throw fail('SESSION_CHANGED', '編集セッションが変わりました（エディタの再起動や読み直しのあと）', `${reader} で sessionId と revision を取り直してから、もう一度送ってください`); }
  if (state.document.id !== input.documentId) throw fail('DOCUMENT_MISMATCH', '文書 ID が違います', `${reader} で documentId を取り直してください`);
  if (state.document.revision !== input.expectedRevision) throw fail('REVISION_CONFLICT', `版が変わっています（今は ${state.document.revision}）。人の編集と重なりました`,
    `${reader} で読み直し、今の内容に合わせて新しい operationId で送ってください`);
  return state;
}
/** 同じ操作 ID の再送。記録が無ければ null（新しく処理する）、同じ中身なら前の結果、違えば断る。 */
export function replayHandoff<R extends object>(found: { requestHash: string; result: R } | null | undefined, hash: string, fail: HandoffFail): (R & { replayed: true }) | null {
  if (!found) return null;
  if (found.requestHash !== hash) throw fail('OPERATION_MISMATCH', '同じ operationId に異なる内容があります', '内容を直したときは新しい operationId で送ってください');
  return { ...found.result, replayed: true };
}
