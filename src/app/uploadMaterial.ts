import { VIDEO_EXTENSIONS } from '../shared/videoExtensions';
import type { MaterialKind } from './panels/materialList';

/** /api/upload-material の応答（ライブラリ差し替え用）。 */
export interface UploadMaterialResponse {
  file: string;
  seLibrary: string[];
  imageLibrary: string[];
  bgmLibrary: string[];
  videoLibrary: string[];
  assetVersions: Record<string, string>;
}

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
/** Keep the file chooser's filter aligned with drag-and-drop classification. */
export const MATERIAL_UPLOAD_ACCEPT = [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].join(',');
export { VIDEO_EXTENSIONS };

/**
 * ドロップされたファイルの保存先種別を拡張子から決める。
 * 音声は SE/BGM の両方があり得るため、素材タブが SE か BGM ならそのタブへ、
 * それ以外のタブなら SE へ入れる（未対応拡張子は null）。
 */
export function classifyUploadKind(fileName: string, activeKind: MaterialKind): MaterialKind | null {
  const lower = fileName.toLowerCase();
  const has = (exts: string[]): boolean => exts.some((e) => lower.endsWith(e));
  if (has(IMAGE_EXTENSIONS)) return 'image';
  if (has(VIDEO_EXTENSIONS)) return 'video';
  if (has(AUDIO_EXTENSIONS)) return activeKind === 'bgm' ? 'bgm' : 'se';
  return null;
}

/** 1ファイルをアップロードする。失敗時はサーバーのエラーメッセージで throw。 */
export async function uploadMaterial(
  projectId: string,
  kind: MaterialKind,
  file: File,
): Promise<UploadMaterialResponse> {
  const url = `/api/upload-material?id=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`;
  const res = await fetch(url, { method: 'POST', body: file });
  if (!res.ok) {
    let message = `アップロードに失敗しました (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // JSON でないエラー応答はステータスのみ
    }
    throw new Error(message);
  }
  return (await res.json()) as UploadMaterialResponse;
}
