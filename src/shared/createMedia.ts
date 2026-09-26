import { VIDEO_EXTENSIONS } from './videoExtensions';
import { formatSize } from './format';

/**
 * 「＋ 動画を作成する」で受け付ける素材の**単一の正本**（画面・サーバー・フォルダから選ぶ の共通）。
 * 動画は旧機能と共有の VIDEO_EXTENSIONS をそのまま使い、変えない（設計 M5）。
 * 音声・画像は素材パネルの取り込み（src/server/sequence/assets.ts の拡張子）と同じ集合。
 */
export const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'];
export const CREATE_MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS];

/** `<input type="file">` の accept。MIME 型と拡張子の両建て（videoExtensions.ts の VIDEO_ACCEPT と同じ考え方）。 */
export const CREATE_MEDIA_ACCEPT = [
  'video/mp4', 'video/quicktime', 'video/webm',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/flac', 'audio/ogg',
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp',
  ...CREATE_MEDIA_EXTENSIONS,
].join(',');

/** 複数画像の作成の上限（設計 M3b）。 */
export const MAX_CREATE_IMAGES = 200;
export const MAX_CREATE_IMAGE_BYTES = 2 * 1024 * 1024 * 1024;

/** 種類が混ざった選択・ドロップの案内（設計 M1）。 */
export const MIXED_MEDIA_MESSAGE = '動画・音声・画像のどれか1種類を選んでください';
export const UNSUPPORTED_MEDIA_MESSAGE = `動画・音声・画像のファイルを選んでください（対応: ${CREATE_MEDIA_EXTENSIONS.join(' ')}）`;

export type CreateMediaKind = 'video' | 'audio' | 'image';

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** ファイル名の拡張子から種類を決める。作成で受け付けない拡張子は null。 */
export function createMediaKind(name: string): CreateMediaKind | null {
  const extension = extensionOf(name);
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  return null;
}

export type CreateSelection =
  | { ok: true; kind: CreateMediaKind; count: number }
  | { ok: false; reason: 'empty' | 'unsupported' | 'mixed'; message: string };

/** 選んだ（ドロップした）ファイル名の並びを、1回の作成で扱う1種類に分類する（設計 M1）。 */
export function classifyCreateSelection(names: readonly string[]): CreateSelection {
  if (names.length === 0) return { ok: false, reason: 'empty', message: UNSUPPORTED_MEDIA_MESSAGE };
  const kinds = names.map(createMediaKind);
  if (kinds.some((kind) => kind === null)) return { ok: false, reason: 'unsupported', message: UNSUPPORTED_MEDIA_MESSAGE };
  if (new Set(kinds).size > 1) return { ok: false, reason: 'mixed', message: MIXED_MEDIA_MESSAGE };
  return { ok: true, kind: kinds[0]!, count: names.length };
}

/** 複数画像の上限を超えていれば理由、収まっていれば null（設計 M3b）。 */
export function imageLimitMessage(count: number, totalBytes: number): string | null {
  if (count <= MAX_CREATE_IMAGES && totalBytes <= MAX_CREATE_IMAGE_BYTES) return null;
  return `画像は1回に${MAX_CREATE_IMAGES}枚・合計2GBまで作成できます（選んだ画像: ${count} 枚・合計 ${formatSize(totalBytes)}）`;
}
