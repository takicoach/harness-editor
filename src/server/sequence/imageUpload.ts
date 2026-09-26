import { open, type FileHandle } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { z } from 'zod';
import { HttpError } from '../http';
import { IMAGE_UPLOAD_MANIFEST_MAX_BYTES, type ImageUploadManifest } from '../../shared/imageUploadFrame';
import { MAX_CREATE_IMAGES, classifyCreateSelection, imageLimitMessage } from '../../shared/createMedia';

const manifestSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({ name: z.string().min(1).max(255).refine(name => !/[/\\]/.test(name)), size: z.number().int().positive().safe() }).strict()).min(1),
}).strict();

/** 一覧を検査する。受け付けない一覧は、中身を1バイトも書き出す前に断る（設計 M1・M3b）。 */
export function parseImageUploadManifest(text: string): ImageUploadManifest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new HttpError(400, '画像の一覧が不正です'); }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, '画像の一覧が不正です');
  const files = parsed.data.files;
  const limit = imageLimitMessage(files.length, files.reduce((sum, file) => sum + file.size, 0));
  if (limit) throw new HttpError(files.length > MAX_CREATE_IMAGES ? 400 : 413, limit);
  const selection = classifyCreateSelection(files.map(file => file.name));
  if (!selection.ok) throw new HttpError(400, selection.message);
  if (selection.kind !== 'image') throw new HttpError(400, '複数のファイルから作れるのは画像だけです。動画・音声は1件ずつ選んでください');
  return parsed.data;
}

export interface ReceivedImage { name: string; path: string; size: number }

async function writeAll(handle: FileHandle, data: Buffer): Promise<void> {
  let offset = 0;
  while (offset < data.length) offset += (await handle.write(data, offset, data.length - offset)).bytesWritten;
}
const asBuffer = (chunk: unknown): Buffer => Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);

/**
 * imageUploadFrame の形の本文を読み、各画像を directory へ順に書き出す（000.png, 001.jpg …）。
 * 一覧より短い・長い本文は 400。directory は呼び出し側が作り、成否にかかわらず呼び出し側が消す。
 */
export async function receiveImageUploads(body: AsyncIterable<unknown>, directory: string): Promise<ReceivedImage[]> {
  let header = Buffer.alloc(0), manifest: ImageUploadManifest | undefined;
  let current: { handle: FileHandle; remaining: number } | undefined;
  const received: ReceivedImage[] = [];
  try {
    for await (const raw of body) {
      let chunk = asBuffer(raw);
      while (chunk.length) {
        if (!manifest) {
          header = Buffer.concat([header, chunk]); chunk = Buffer.alloc(0);
          if (header.length < 4) break;
          const length = header.readUInt32BE(0);
          if (length < 2 || length > IMAGE_UPLOAD_MANIFEST_MAX_BYTES) throw new HttpError(400, '画像の一覧が不正です');
          if (header.length < 4 + length) break;
          manifest = parseImageUploadManifest(header.subarray(4, 4 + length).toString('utf8'));
          chunk = header.subarray(4 + length); header = Buffer.alloc(0);
          continue;
        }
        if (!current) {
          const entry = manifest.files[received.length];
          if (!entry) throw new HttpError(400, '画像の一覧より多いデータが送られました');
          const path = join(directory, `${String(received.length).padStart(3, '0')}${extname(entry.name).toLowerCase()}`);
          current = { handle: await open(path, 'wx', 0o600), remaining: entry.size };
          received.push({ name: entry.name, path, size: entry.size });
        }
        const part = chunk.subarray(0, current.remaining);
        await writeAll(current.handle, part);
        current.remaining -= part.length; chunk = chunk.subarray(part.length);
        if (current.remaining === 0) { const done = current; current = undefined; await done.handle.close(); }
      }
    }
    if (!manifest || current || received.length !== manifest.files.length) throw new HttpError(400, '画像の受信が途中で終わりました。もう一度作成してください');
    return received;
  } finally { await current?.handle.close().catch(() => undefined); }
}
