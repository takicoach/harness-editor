import { open } from 'node:fs/promises';

/** 画像の表示上の寸法（EXIF の向きを反映した後）。 */
export interface ImageDisplaySize { width: number; height: number }
/**
 * 登録時の検査で分かる画像の情報（設計 M3c・M3d）。素材台帳には保存しない。
 * displaySize が無い＝寸法情報が無い（作成は 1920x1080 にする）。読めない画像はここまで来ない（検査で断る）。
 * frames は必ずしも実際に復号したコマ数ではない: 配布版で AV1 が復号できない場合は `1`（寸法だけで受け付けた既定値）、
 * 動く WebP の見出しだけで判定できて1コマも復号できなかった場合は `0`（実数不明）になる（I-1・M-7）。
 */
export interface ImageInspection { displaySize?: ImageDisplaySize; orientation: number; frames: number; animated: boolean }

/** 先頭だけ読む量。EXIF（APP1）と WebP の見出しはこの範囲にある。 */
export const IMAGE_HEAD_BYTES = 256 * 1024;

export async function readImageHead(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(IMAGE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function tiffOrientation(tiff: Buffer): number | undefined {
  if (tiff.length < 8) return undefined;
  const order = tiff.toString('latin1', 0, 2), little = order === 'II';
  if (!little && order !== 'MM') return undefined;
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return undefined;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return undefined;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return undefined;
    if (u16(entry) !== 0x0112) continue;
    if (u16(entry + 2) !== 3 || u32(entry + 4) < 1) return undefined;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : undefined;
  }
  return undefined;
}

/**
 * JPEG の EXIF（APP1・IFD0 のタグ 0x0112）にある向き。無い・読めない・範囲外は 1（そのまま）。
 * ブラウザーの <img> は既定（image-orientation: from-image）でこの向きを反映して表示する。
 * FFprobe は -show_streams ではこの向きを返さない（計画作成時の実測: ffmpeg 9.0.1）ので自前で読む。
 */
export function jpegExifOrientation(bytes: Buffer): number {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) { offset++; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { offset += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = bytes.readUInt16BE(offset + 2), start = offset + 4, end = offset + 2 + length;
    if (length < 2 || end > bytes.length) return 1;
    if (marker === 0xe1 && end - start >= 14 && bytes.toString('latin1', start, start + 6) === 'Exif\0\0') {
      const found = tiffOrientation(bytes.subarray(start + 6, end));
      if (found !== undefined) return found;
    }
    offset = end;
  }
  return 1;
}

/** WebP の拡張見出し（VP8X）のアニメーション旗（0x02）。FFmpeg の版によらず見出しだけで判定する。 */
export function isAnimatedWebp(bytes: Buffer): boolean {
  return bytes.length >= 21 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP'
    && bytes.toString('latin1', 12, 16) === 'VP8X' && (bytes[20]! & 0x02) !== 0;
}

/** AVIF（ISOBMFF）の ftyp メジャーブランドが `avis`（動く AVIF）かどうか。配布版・開発機のどちらでも見出しだけで判定する（M-8）。 */
export function isAnimatedAvif(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp' && bytes.toString('latin1', 8, 12) === 'avis';
}

/** 向き 5〜8 は縦横が入れ替わる（90° 回転を含む）。 */
export function imageDisplaySize(width: number, height: number, orientation: number): ImageDisplaySize {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/**
 * FFprobe の画像ストリーム（-count_frames 付き）と先頭のバイト列から、表示寸法とコマ数を決める。
 * 見出しの旗（WebP・AVIF のアニメーション判定）を先に見る。動く WebP は、`webp_anim` の無い古い
 * ffmpeg では `nb_read_frames` が復号できないことがあるため、見出しで先に救う。
 * 例外がもう1つある: 配布版ビルド（desktop/build-media.mjs --disable-autodetect）は AV1 のソフト復号器が
 * 無いため、正常な AVIF でも `nb_read_frames` が出ない。`codec_name==='av1'` で寸法があるときは
 * 寸法だけで受け付ける（下記 undecodableAv1）。
 * 1コマも復号できず、動く WebP の見出しでも undecodableAv1 でもない画像だけ「壊れていて読めない」として断る。
 * 拡張子では絞り込まない（`jpegExifOrientation`・`isAnimatedWebp`・`isAnimatedAvif` は先頭バイトを自分で確かめる
 * ため、拡張子と中身が食い違っていても正しく判定できる）。`file` は呼び出し側の計画で固定の
 * 引数のため残す（現状は未使用）。
 */
export function inspectImageStream(stream: { codec_name?: string; width?: number; height?: number; nb_read_frames?: string }, head: Buffer, _file: string): ImageInspection {
  const parsed = Number(stream.nb_read_frames);
  const decoded = Number.isSafeInteger(parsed) && parsed >= 1;
  const animatedWebp = isAnimatedWebp(head);
  // 配布版（desktop/build-media.mjs --disable-autodetect）は外部ライブラリを自動検出しないため AV1 のソフト復号器が
  // 無い。正常な AVIF でも 0 コマになるが、寸法は ffprobe が返すので寸法だけで受け付ける（表示はブラウザーが担う）。
  // frames はここでは実際に復号したコマ数ではなく、受け付けたことを示す既定値 1（M-7）。
  const undecodableAv1 = !decoded && !animatedWebp && stream.codec_name === 'av1' && (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0;
  if (!decoded && !animatedWebp && !undecodableAv1) throw new Error('画像を読み取れません');
  const frames = decoded ? parsed : undecodableAv1 ? 1 : 0;
  const orientation = jpegExifOrientation(head);
  // 動く AVIF（ftyp の主ブランドが avis）は WebP と同じく見出しだけで判定する（M-8）。frames はここでは 0（実数不明）でも animated:true になる。
  const animated = animatedWebp || isAnimatedAvif(head) || frames > 1;
  const hasDimensions = (decoded || undecodableAv1) && stream.width && stream.height;
  const displaySize = hasDimensions ? imageDisplaySize(stream.width!, stream.height!, orientation) : undefined;
  return { ...(displaySize ? { displaySize } : {}), orientation, frames, animated };
}
