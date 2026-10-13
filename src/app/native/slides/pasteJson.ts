/** AI の回答から JSON を取り出す（コードの囲み ``` と、最初の { か [ より前の文は外す）。 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  const body = text.replace(/```(?:json)?/gi, '').trim(), start = body.search(/[[{]/);
  if (start < 0) return { ok: false, message: 'JSON が見つかりません（{ か [ で始まる部分を貼ってください）' };
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  try { return { ok: true, value: JSON.parse(body.slice(start, end + 1)) }; }
  catch (error) { return { ok: false, message: `JSON として読めません（${error instanceof Error ? error.message : String(error)}）` }; }
}
/** 本文は配列のほか、{"pages": [...]} で返す AI もあるので受ける。 */
export function normalizePages(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { pages?: unknown }).pages) ? (value as { pages: unknown[] }).pages : value;
}
