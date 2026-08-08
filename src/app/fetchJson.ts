/** API エラーレスポンス（{error} 形式）からメッセージを取り出す。 */
export function extractErrorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const msg = (body as { error: unknown }).error;
    if (typeof msg === 'string' && msg !== '') return msg;
  }
  return 'サーバエラーが発生しました';
}

/** JSON API を叩く。非 2xx はサーバの error メッセージで例外化する。 */
export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(extractErrorMessage(body));
  }
  // 2xx でも本文が空・非 JSON だと body は null。呼び出し側の分割代入で
  // 実行時エラーになるため、ここで明示的に例外化する。
  if (body === null) {
    throw new Error(`${url} から空のレスポンスを受け取りました`);
  }
  return body as T;
}

/** JSON ボディを PUT で送り、JSON レスポンスを受け取る。非 2xx はサーバ error で例外化。 */
export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(extractErrorMessage(data));
  }
  if (data === null) {
    throw new Error(`${url} から空のレスポンスを受け取りました`);
  }
  return data as T;
}

/** JSON ボディを POST で送り、JSON レスポンスを受け取る。非 2xx はサーバ error で例外化。 */
export async function putJsonPost<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(extractErrorMessage(data));
  }
  if (data === null) {
    throw new Error(`${url} から空のレスポンスを受け取りました`);
  }
  return data as T;
}
