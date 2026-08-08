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
 */
export function fingerprintFile(absPath: string, relPath: string): FileFingerprint | null {
  if (!existsSync(absPath)) return null;
  const st = statSync(absPath);
  return { relPath, size: st.size, mtimeMs: st.mtimeMs };
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
