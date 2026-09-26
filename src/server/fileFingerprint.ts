import { existsSync, statSync } from 'node:fs';
import type { FileFingerprint } from '../shared/types';

/**
 * size + mtime のキャッシュバスト用トークン。videoVersion と assetVersions が
 * 同一形式を共有する（片側だけ形式変更して /api/video と /api/asset が乖離するのを防ぐ）。
 * /api/video の「?v= 版ピン」（previewProxy.resolveVideoPathForVersion）も同形式で比較する。
 */
export function versionToken(size: number, mtimeMs: number): string {
  return `${size}-${Math.round(mtimeMs)}`;
}

/**
 * ファイルの指紋（size + mtimeMs）を算出する。
 * ファイルが存在しなければ null（cutData.ts 不在を表現する）。
 * relPath はクライアントへ返す相対パス（プロジェクトディレクトリ基準）。
 * existsSync 通過後に対象が消える/権限エラーになるレースが起きても statSync の
 * 例外で呼び出し元（loadProjectFromDir 等）を巻き込んで落とさない。フォールバックは
 * 「不在」と同じ扱い＝ null（呼び出し側は versionToken を付けず従来 URL のまま配信する）。
 */
export function fingerprintFile(absPath: string, relPath: string): FileFingerprint | null {
  if (!existsSync(absPath)) return null;
  try {
    const st = statSync(absPath);
    return { relPath, size: st.size, mtimeMs: st.mtimeMs };
  } catch (err) {
    console.warn('[sme] ファイル指紋の取得に失敗:', absPath, err);
    return null;
  }
}

/**
 * 2 つの指紋が一致するか（= 外部変更が無いか）を判定する。
 * 両方 null（ファイルが元から無く今も無い）は一致。片方だけ null は不一致。
 */
export function fingerprintsMatch(
  a: FileFingerprint | null,
  b: FileFingerprint | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}
