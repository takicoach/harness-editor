/**
 * AI ターミナルへドロップされたファイルの受け皿（ブラウザ版専用）。
 * ブラウザは File から実パスを取れないため、中身を一時フォルダへ保存し、その絶対パスを
 * 端末へ入力させる。デスクトップ版は preload の getPathForFile で実パスを使うのでここを通らない。
 */
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { assertContentLengthWithin, moveIntoPlace, resolveMaxUploadBytes, streamBodyToTempFile } from './streamUpload';

const MAX_NAME_LENGTH = 120;
/** Linux の多くのファイルシステムは 1 つの名前を 255 バイトまでに制限する。余裕を持たせる。 */
const MAX_NAME_BYTES = 200;

const ROOT_PREFIX = 'harness-editor-terminal-drops-';
/** 異常終了などで残った前回までのフォルダを消す目安。使用中の添付を消さないよう長めに取る。 */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

let attachmentRoot: string | undefined;
/**
 * 一時保存の親フォルダ。OS の一時領域に置き、プロジェクトフォルダを散らかさない。
 * 名前を推測できないよう起動ごとに mkdtemp で作る（共有の一時領域で他者に先回りされない）。
 * 作る時に、異常終了で残った古いフォルダを片付ける。
 */
export function terminalAttachmentRoot(): string {
  if (attachmentRoot === undefined) {
    removeStaleAttachmentRoots();
    attachmentRoot = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  }
  return attachmentRoot;
}

/** サーバー終了時に呼ぶ。端末（AI）も同時に終わるため、今回の添付はもう参照されない。 */
export function removeTerminalAttachments(): void {
  const root = attachmentRoot;
  attachmentRoot = undefined;
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
}

/** 自分が所有する実フォルダのうち、1 日以上更新の無いものだけを消す（リンクや他人の物には触れない）。 */
function removeStaleAttachmentRoots(): void {
  const parent = tmpdir(), owner = process.getuid?.();
  let names: string[];
  try { names = readdirSync(parent); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const path = join(parent, name);
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || (owner !== undefined && info.uid !== owner)) continue;
      if (Date.now() - info.mtimeMs > STALE_AFTER_MS) rmSync(path, { recursive: true, force: true });
    } catch { /* 消せない物は次回に回す。添付の受け付け自体は止めない */ }
  }
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
  const fits = (name: string) => name.length <= MAX_NAME_LENGTH && Buffer.byteLength(name) <= MAX_NAME_BYTES;
  if (fits(cleaned)) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  // 文字単位（サロゲートペアを割らない）で後ろから削り、文字数とバイト数の両方に収める。
  const head = Array.from(ext ? cleaned.slice(0, dot) : cleaned);
  while (head.length && !fits(head.join('') + ext)) head.pop();
  return head.length ? head.join('') + ext : 'file';
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
