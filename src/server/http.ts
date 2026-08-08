import type { ServerResponse } from 'node:http';

/** API ハンドラが投げる、HTTP ステータス付きのエラー。 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
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
