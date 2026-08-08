import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { NormalizeStrength } from './buildNormalizeArgs';

/**
 * 音量正規化の適用状態マーカー（normalize.json）。
 * applied: true  = 正規化済みファイルがメイン動画に配置されている
 * applied: false = 復元済み（バックアップは残る）
 */
export interface NormalizeMarker {
  applied: boolean;
  strength: NormalizeStrength;
  backupRel: string;
}

const MARKER_FILE = 'normalize.json';

/** `main.mp4` → `main.normalize-backup.mp4` */
export function backupName(fileName: string): string {
  const ext = extname(fileName);
  const base = basename(fileName, ext);
  return `${base}.normalize-backup${ext}`;
}

function backupPath(dir: string, fileName: string): string {
  return join(dir, backupName(fileName));
}

/** バックアップが無ければ原本をコピー（冪等・既存は保護）。原本が無ければ null。 */
export function ensureBackup(dir: string, fileName: string): string | null {
  const src = join(dir, fileName);
  if (!existsSync(src)) return null;
  const bak = backupPath(dir, fileName);
  if (!existsSync(bak)) copyFileSync(src, bak);
  return bak;
}

/** 常に原本（バックアップ）を入力解決。再実行で処理済み出力を入力にしない。 */
export function resolveInputFromBackup(dir: string, fileName: string): string {
  const bak = backupPath(dir, fileName);
  if (existsSync(bak)) return bak;
  return join(dir, fileName);
}

export function readNormalizeMarker(dir: string): NormalizeMarker | null {
  const path = join(dir, MARKER_FILE);
  if (!existsSync(path)) return null;
  try {
    const obj = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as NormalizeMarker;
  } catch {
    return null;
  }
}

export function writeNormalizeMarker(dir: string, marker: NormalizeMarker): void {
  writeFileSync(join(dir, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n', 'utf8');
}

export function isNormalizeApplied(dir: string): boolean {
  return readNormalizeMarker(dir)?.applied === true;
}

/** バックアップから原本ファイルを復元（マーカー更新は呼び出し側）。 */
export function restoreFromBackup(dir: string, fileName: string): boolean {
  const bak = backupPath(dir, fileName);
  if (!existsSync(bak)) return false;
  copyFileSync(bak, join(dir, fileName));
  return true;
}
