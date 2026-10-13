import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanThumbnailFileName } from '../../core/thumbnail/model';

/** 書き出しの名前と、プロジェクトのカードの画像（メインの案の書き出し）の場所。一覧（sequence/summary・projectsWatch）からも読む軽いモジュール。 */
export const THUMBNAIL_EXPORT_FOLDER = 'サムネ';
const FILE_BASE_MAX = 120, PROJECT_PART_MAX = 75;
/** カードの画像として配る上限（PNG は 2MB を超えることがある）。 */
const COVER_MAX_BYTES = 32 * 1024 * 1024;
const COVER_TYPES = [['.png', 'image/png'], ['.jpg', 'image/jpeg']] as const;

/** UTF-16 で max 以内に切る（サロゲートペアを割らない）。 */
function cut(value: string, max: number): string {
  let out = '';
  for (const char of value) { if (out.length + char.length > max) break; out += char; }
  return out;
}
/**
 * 書き出しの名前（拡張子なし）。メインの案は「<案件名> サムネ」、それ以外は「<案件名> サムネ <案の名前>」。
 * 案件名は 75 字で切り、案の名前（40 字まで）を足しても 120 字に収める。長い案件名でもメインとそれ以外の名前が重ならない。
 */
export function thumbnailFileBase(projectName: string, pageName: string, main: boolean): string {
  const project = cut(cleanThumbnailFileName(projectName), PROJECT_PART_MAX).replace(/[. ]+$/g, '');
  return cut(main ? `${project} サムネ` : `${project} サムネ ${cleanThumbnailFileName(pageName)}`, FILE_BASE_MAX);
}

/** カードの画像。file は案件からの相対パス、mtimeMs は画像の取り直し（?v=）に使う。 */
export interface ThumbnailCover { file: string; mtimeMs: number }
interface LocatedCover extends ThumbnailCover { path: string; type: string }

/**
 * 案件内の サムネ/<案件名> サムネ.(png|jpg) だけを探す。両方あれば新しい方。
 * フォルダー・ファイルがリンクなら使わない（案件の外を配らない）。名前はクライアントから受け取らず、ここで決める。
 */
function locateThumbnailCover(directory: string): LocatedCover | null {
  try {
    const root = realpathSync(directory), folder = join(root, THUMBNAIL_EXPORT_FOLDER);
    if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return null;
    const base = thumbnailFileBase(basename(root), '', true);
    let found: LocatedCover | null = null;
    for (const [extension, type] of COVER_TYPES) {
      const path = join(folder, base + extension), entry = lstatSync(path, { throwIfNoEntry: false });
      if (!entry?.isFile() || entry.size === 0 || entry.size > COVER_MAX_BYTES) continue;
      if (!found || entry.mtimeMs > found.mtimeMs) found = { file: `${THUMBNAIL_EXPORT_FOLDER}/${base}${extension}`, path, type, mtimeMs: entry.mtimeMs };
    }
    return found;
  } catch { return null; }
}
export function thumbnailCoverOf(directory: string): ThumbnailCover | undefined {
  const cover = locateThumbnailCover(directory);
  return cover ? { file: cover.file, mtimeMs: cover.mtimeMs } : undefined;
}
/**
 * 通常のファイルだけを読む（空・上限超えは null）。リンクは辿らず（O_NOFOLLOW）、FIFO などに差し替えられていても
 * 開くところで止まらない（O_NONBLOCK。通常のファイルの読み込みには効かない）。開いたものを fstat で確かめる。
 */
export function readRegularFileNoFollow(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
/** 配る中身。確かめた後にリンク・FIFO などへ差し替えられても辿らず、止まらない（readRegularFileNoFollow）。 */
export function readThumbnailCover(directory: string): { bytes: Buffer; type: string } | null {
  const cover = locateThumbnailCover(directory);
  if (!cover) return null;
  const bytes = readRegularFileNoFollow(cover.path, COVER_MAX_BYTES);
  return bytes ? { bytes, type: cover.type } : null;
}
