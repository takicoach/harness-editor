/**
 * 複数画像のアップロード本文の形（設計 M3b）。1回の要求で順序付きの一覧と中身を送る:
 *   [4 バイト（ビッグエンディアン）の一覧の長さ][一覧の JSON（UTF-8）][1枚目の中身][2枚目の中身]…
 * 一覧は {version:1, files:[{name, size}]}。サーバーは各画像を作業用の一時フォルダへ順に書き出し、全件そろってから作成する。
 * 名前を URL や見出しに載せない（200 枚の日本語名は見出しの上限を超えるため）。
 */
export const IMAGE_UPLOAD_MANIFEST_MAX_BYTES = 256 * 1024;
export interface ImageUploadEntry { name: string; size: number }
export interface ImageUploadManifest { version: 1; files: ImageUploadEntry[] }

export function imageUploadPrefix(files: readonly ImageUploadEntry[]): Uint8Array<ArrayBuffer> {
  const manifest: ImageUploadManifest = { version: 1, files: files.map(({ name, size }) => ({ name, size })) };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const prefix = new Uint8Array(4 + json.length);
  new DataView(prefix.buffer).setUint32(0, json.length);
  prefix.set(json, 4);
  return prefix;
}
