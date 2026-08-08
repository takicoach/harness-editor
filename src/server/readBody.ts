import type { IncomingMessage } from 'node:http';
import { HttpError } from './http';

/** JSON 系リクエストボディの既定上限（保存ボディは telopDataSource 等で数 MB になりうる）。 */
export const DEFAULT_JSON_BODY_MAX_BYTES = 16 * 1024 * 1024;

/** ジョブ起動系（denoise / normalize / render 等）の小さなオプション body 上限（64 KiB）。 */
export const JOB_BODY_MAX_BYTES = 64 * 1024;

/**
 * リクエストボディを上限付きで読み切ってテキストで返す。
 * 受信バイトが maxBytes を超えた時点で中断し HttpError(413) を投げる
 * （巨大ボディでメモリを食い尽くす DoS を防ぐ）。
 */
export async function readBodyText(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'リクエストボディが大きすぎます');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** リクエストボディを上限付きで読み切って JSON.parse する。空・非 JSON は HttpError(400)。 */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<unknown> {
  const text = await readBodyText(req, maxBytes);
  if (text === '') {
    throw new HttpError(400, 'リクエストボディが空です');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'リクエストボディが JSON ではありません');
  }
}
