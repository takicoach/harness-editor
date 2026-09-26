import type { ServerResponse } from 'node:http';

/** API ハンドラが投げる、HTTP ステータス付きのエラー。 */
export class HttpError extends Error {
  /** 中止理由の機械可読コード（省略可）。UI が文言をコードで出し分けるために使う。 */
  public readonly reason?: string;
  constructor(public readonly status: number, message: string, options?: { reason?: string; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HttpError';
    this.reason = options?.reason;
  }
}

/** JSON レスポンスを返す。 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // JSON.stringify は循環参照・BigInt 等で throw する。catch ハンドラから
  // 呼ばれた場合に未捕捉例外で開発サーバを落とさないよう、ここで吸収する。
  let body: string;
  try {
    body = JSON.stringify(data);
  } catch {
    body = JSON.stringify({ error: 'レスポンスの直列化に失敗しました' });
    status = 500;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/**
 * API の例外を返す形（`{error}` または `{error,reason}`）。本番の配線（plugin.ts）と
 * テストの簡易サーバが同じ 1 本を呼ぶ（手で複製すると応答形が静かにずれる。Task 19/20 Minor）。
 */
export function sendApiError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  const reason = error instanceof HttpError ? error.reason : undefined;
  sendJson(res, status, reason ? { error: message, reason } : { error: message });
}

/** テキスト（JS バンドル等）レスポンスを返す。 */
export function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  contentType: string,
): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}
