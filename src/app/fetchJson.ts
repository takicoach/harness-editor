/**
 * HTTP ステータスを保持する API エラー。
 * 呼び出し側が「保存衝突（409）」だけを他のエラーと区別できるようにするために足した
 * （2026-09-04 のデータ損失: 409 を通常のエラーとして表示するだけだったため、
 * 利用者の出口が「開き直す＝未保存の編集を捨てる」しか無かった）。
 * Error の派生なので、message だけ見る既存の呼び出し側は挙動が変わらない。
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** API エラーレスポンス（{error} 形式）からメッセージを取り出す。 */
export function extractErrorMessage(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const msg = (body as { error: unknown }).error;
    if (typeof msg === 'string' && msg !== '') return msg;
  }
  return 'サーバエラーが発生しました';
}

/** JSON API を叩く。非 2xx はサーバの error メッセージで例外化する。 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init === undefined ? await fetch(url) : await fetch(url, init);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(body));
  }
  // 2xx でも本文が空・非 JSON だと body は null。呼び出し側の分割代入で
  // 実行時エラーになるため、ここで明示的に例外化する。
  if (body === null) {
    throw new Error(`${url} から空のレスポンスを受け取りました`);
  }
  return body as T;
}

/**
 * JSON ボディを PUT で送り、JSON レスポンスを受け取る。非 2xx はサーバ error で例外化。
 * `headers` は追加ヘッダ（保存の X-Harness-Writer など）。
 */
export async function putJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, extractErrorMessage(data));
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
    throw new ApiError(res.status, extractErrorMessage(data));
  }
  if (data === null) {
    throw new Error(`${url} から空のレスポンスを受け取りました`);
  }
  return data as T;
}
