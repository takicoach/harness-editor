/**
 * AI ターミナルへドロップされたファイルの受け皿（ブラウザ版専用）。
 * ブラウザは File から実パスを取れないため、中身を一時フォルダへ保存し、その絶対パスを
 * 端末へ入力させる。デスクトップ版は preload の getPathForFile で実パスを使うのでここを通らない。
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { assertContentLengthWithin, moveIntoPlace, resolveMaxUploadBytes, streamBodyToTempFile } from './streamUpload';

const MAX_NAME_LENGTH = 120;

let attachmentRoot: string | undefined;
/**
 * 一時保存の親フォルダ。OS の一時領域に置き、プロジェクトフォルダを散らかさない。
 * 名前を推測できないよう起動ごとに mkdtemp で作る（共有の一時領域で他者に先回りされない）。
 */
export function terminalAttachmentRoot(): string {
  attachmentRoot ??= mkdtempSync(join(tmpdir(), 'harness-editor-terminal-drops-'));
  return attachmentRoot;
}

/**
 * 利用者のファイル名から、1 階層のファイル名として安全な名前を作る。
 * 区切り文字・制御文字を除き、長すぎる名前は拡張子を残して切り詰める。
 */
export function safeAttachmentName(raw: string | null): string {
  const base = (raw ?? '').normalize('NFC').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f:]/g, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'file';
  if (cleaned.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
}

/** リクエスト本文を一時フォルダへ保存し、元のファイル名のまま置いた絶対パスを返す。 */
export async function saveTerminalAttachment(req: IncomingMessage, rawName: string | null): Promise<string> {
  const maxBytes = resolveMaxUploadBytes();
  assertContentLengthWithin(req, maxBytes);
  const root = terminalAttachmentRoot();
  const received = await streamBodyToTempFile(req, join(root, 'incoming'), maxBytes);
  // 同名ファイルを続けて落としても上書きしないよう、1 件ごとに別フォルダへ置く。
  const folder = join(root, randomUUID());
  mkdirSync(folder, { recursive: true });
  const destination = join(folder, safeAttachmentName(rawName));
  moveIntoPlace(received, destination);
  return destination;
}
