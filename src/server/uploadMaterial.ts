import { existsSync, mkdirSync } from 'node:fs';
import { moveIntoPlace } from './streamUpload';
import { basename, extname, join } from 'node:path';
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from './loadProjectFiles';
import { HttpError } from './http';

/** アップロード素材の4種別（クライアント materialList.ts の MaterialKind と一致必須）。 */
export type UploadKind = 'se' | 'image' | 'bgm' | 'video';

/** 種別 → 保存先サブディレクトリ（public/ 起点。video はルート直下）と許可拡張子。 */
const KIND_CONFIG: Record<UploadKind, { subdir: string; extensions: string[] }> = {
  se: { subdir: 'se', extensions: AUDIO_EXTENSIONS },
  image: { subdir: 'images', extensions: IMAGE_EXTENSIONS },
  bgm: { subdir: 'BGM', extensions: AUDIO_EXTENSIONS },
  video: { subdir: '', extensions: VIDEO_EXTENSIONS },
};

export function isUploadKind(v: string): v is UploadKind {
  return v === 'se' || v === 'image' || v === 'bgm' || v === 'video';
}

/**
 * アップロードされたファイル名を保存用に整える。
 * - パス区切りを含む場合はベース名だけ使う（ブラウザによってはフルパスが来る）
 * - macOS の濁点分解（NFD）を NFC へ正規化
 * - 隠しファイル・空名・種別に合わない拡張子は 400
 */
export function sanitizeUploadName(kind: UploadKind, rawName: string): string {
  const base = basename(rawName.replaceAll('\\', '/')).normalize('NFC').trim();
  if (base === '' || base.startsWith('.') || base.includes('..')) {
    throw new HttpError(400, `不正なファイル名です: ${rawName}`);
  }
  const ext = extname(base).toLowerCase();
  const allowed = KIND_CONFIG[kind].extensions;
  if (!allowed.includes(ext)) {
    throw new HttpError(400, `この種別（${kind}）では扱えない拡張子です: ${ext || '(なし)'}（対応: ${allowed.join(' ')}）`);
  }
  return base;
}

/** 同名ファイルがある場合に「name-2.ext」「name-3.ext」…と衝突しない名前を選ぶ。 */
function uniqueName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  throw new HttpError(409, `同名ファイルが多すぎて保存できません: ${name}`);
}

/**
 * 素材ファイルをプロジェクトの public 配下へ保存し、保存されたファイル名を返す。
 * 同名衝突時は上書きせず連番を付ける（既存素材を使っている編集を壊さないため）。
 */
export function saveMaterialFile(
  projectDir: string,
  kind: UploadKind,
  rawName: string,
  dataTmpPath: string,
): { file: string } {
  const name = sanitizeUploadName(kind, rawName);
  const targetDir = join(projectDir, 'public', KIND_CONFIG[kind].subdir);
  mkdirSync(targetDir, { recursive: true });
  const file = uniqueName(targetDir, name);
  moveIntoPlace(dataTmpPath, join(targetDir, file));
  return { file };
}
