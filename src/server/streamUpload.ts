import { createWriteStream, cpSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { HttpError } from './http';

/** アップロードの既定上限（32 GiB）。素材動画は大きいので緩めだが、無制限にはしない。 */
export const DEFAULT_MAX_UPLOAD_BYTES = 32 * 1024 * 1024 * 1024;

/** 環境変数で指定できる上限の上側クランプ（1 TiB）。設定ミスで実質無制限になるのを防ぐ。 */
export const MAX_UPLOAD_BYTES_CEILING = 1024 * 1024 * 1024 * 1024;

/**
 * アップロードの最大バイト数を解決する。環境変数 HARNESS_MAX_UPLOAD_BYTES（旧 SME_MAX_UPLOAD_BYTES）で上書き可能
 * （正の整数のみ採用・不正値は既定にフォールバック・上限を超える指定は上限へクランプ）。
 */
export function resolveMaxUploadBytes(): number {
  const raw = process.env.HARNESS_MAX_UPLOAD_BYTES ?? process.env.SME_MAX_UPLOAD_BYTES;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return Math.min(n, MAX_UPLOAD_BYTES_CEILING);
  }
  return DEFAULT_MAX_UPLOAD_BYTES;
}

/** 一時ファイルの削除。削除自体が失敗しても元のエラーを潰さない（残骸は起動時掃除に委ねる）。 */
function safeRm(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Windows で fd 解放前だと EBUSY/EPERM になりうる。ここで握って元の HttpError を優先する。
  }
}

/**
 * Content-Length ヘッダがあり、それが上限を超えていれば受信前に HttpError(413) を投げる。
 * ヘッダが無い/不正な場合は素通し（実際のバイト数はストリーミング中に streamBodyToTempFile が enforce する）。
 */
export function assertContentLengthWithin(req: IncomingMessage, maxBytes: number): void {
  const raw = req.headers['content-length'];
  if (raw === undefined) return;
  const declared = Number(Array.isArray(raw) ? raw[0] : raw);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, `アップロードが上限（${maxBytes} バイト）を超えています`);
  }
}

/**
 * リクエストボディを一時ファイルへストリーミング書き込みする。
 * 全量をメモリに載せないため大容量動画も扱えるが、受信バイトが maxBytes を超えた時点で
 * 中断し一時ファイルを消して HttpError(413) を投げる（ディスク枯渇 DoS の防止）。
 * 受信エラー・空ボディ時も一時ファイルを削除してから HttpError を投げる。
 */
export async function streamBodyToTempFile(
  body: Readable,
  tmpDir: string,
  maxBytes: number = DEFAULT_MAX_UPLOAD_BYTES,
): Promise<string> {
  mkdirSync(tmpDir, { recursive: true });
  const tmpPath = join(tmpDir, `upload-${randomUUID()}.tmp`);
  const out = createWriteStream(tmpPath);
  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb): void {
      received += chunk.length;
      if (received > maxBytes) {
        cb(new HttpError(413, `アップロードが上限（${maxBytes} バイト）を超えました`));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, limiter, out);
  } catch (err) {
    safeRm(tmpPath);
    // 上限超過（limiter が投げた HttpError）はそのまま 413 として返す。
    if (err instanceof HttpError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    // 書き込み側（ディスク不足・権限等）はクライアントの問題ではないので 500 で区別する。
    if (code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EROFS' || code === 'EMFILE') {
      throw new HttpError(500, `サーバー側の保存に失敗しました（ディスク容量・権限を確認してください）: ${code}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpError(400, `アップロードの受信に失敗しました: ${message}`);
  }
  if (out.bytesWritten === 0) {
    safeRm(tmpPath);
    throw new HttpError(400, '空のファイルはアップロードできません');
  }
  return tmpPath;
}

/**
 * 一時ファイルを目的地へ移動する。同一ボリュームなら rename 一発、
 * ボリュームをまたぐ場合（EXDEV）はコピー＋削除にフォールバックする。
 */
export function moveIntoPlace(srcPath: string, destPath: string): void {
  try {
    renameSync(srcPath, destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    try {
      cpSync(srcPath, destPath);
    } catch (copyErr) {
      // 途中まで書かれた壊れファイルを目的地に残さない。
      rmSync(destPath, { force: true });
      throw copyErr;
    }
    rmSync(srcPath, { force: true });
  }
}
