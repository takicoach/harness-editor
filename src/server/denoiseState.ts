import {
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, extname, basename } from 'node:path';
import type { DenoiseStrength } from './buildDenoiseArgs';

/**
 * ノイズ除去の適用状態を示すマーカーファイル（denoise.json）の型。
 *
 * applied: true  = ノイズ除去済みファイルが main.mp4 に配置されている
 * applied: false = 復元済み（バックアップは残るが main.mp4 は原本）
 * strength: 適用した強度
 * backupRel: バックアップファイル名（ディレクトリ相対）
 */
export interface DenoiseMarker {
  applied: boolean;
  strength: DenoiseStrength;
  backupRel: string;
}

/** マーカーファイル名。 */
const MARKER_FILE = 'denoise.json';

/**
 * バックアップのファイル名を算出する。
 * `main.mp4` → `main.denoise-backup.mp4`
 */
export function backupName(fileName: string): string {
  const ext = extname(fileName);
  const base = basename(fileName, ext);
  return `${base}.denoise-backup${ext}`;
}

/**
 * バックアップの絶対パスを返す。
 * `<dir>/<base>.denoise-backup.<ext>`
 */
function backupPath(dir: string, fileName: string): string {
  return join(dir, backupName(fileName));
}

/**
 * バックアップが無ければ原本をコピーしてバックアップを作成する（冪等）。
 * 既にバックアップが存在する場合は上書きしない（初回コピーを保護）。
 *
 * @returns バックアップの絶対パス。原本が存在しなければ null。
 */
export function ensureBackup(dir: string, fileName: string): string | null {
  const src = join(dir, fileName);
  if (!existsSync(src)) return null;
  const bak = backupPath(dir, fileName);
  if (!existsSync(bak)) {
    copyFileSync(src, bak);
  }
  return bak;
}

/**
 * 常に原本（バックアップ）を入力として解決する。
 * バックアップが存在すればバックアップを返し、なければ元ファイルを返す。
 * 再実行時に「既に処理済みの出力」を入力にしてしまうのを防ぐ。
 */
export function resolveInputFromBackup(dir: string, fileName: string): string {
  const bak = backupPath(dir, fileName);
  if (existsSync(bak)) return bak;
  return join(dir, fileName);
}

/**
 * マーカーファイル（denoise.json）を読み込む。
 * 存在しない・読み込めない場合は null を返す。
 */
export function readDenoiseMarker(dir: string): DenoiseMarker | null {
  const path = join(dir, MARKER_FILE);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as DenoiseMarker;
  } catch {
    return null;
  }
}

/**
 * マーカーファイル（denoise.json）を書き込む。
 */
export function writeDenoiseMarker(dir: string, marker: DenoiseMarker): void {
  const path = join(dir, MARKER_FILE);
  writeFileSync(path, JSON.stringify(marker, null, 2) + '\n', 'utf8');
}

/**
 * ノイズ除去が適用済みかどうかを返す。
 * マーカーが無い・applied=false の場合は false。
 */
export function isDenoiseApplied(dir: string): boolean {
  const marker = readDenoiseMarker(dir);
  return marker?.applied === true;
}

/**
 * バックアップから原本ファイルを復元する（マーカー更新は呼び出し側の責務）。
 * 動画ファイル（public/ 配下）とマーカー（denoise.json・プロジェクト直下）は
 * 別ディレクトリに置くため、ここではファイル復元だけを行う。
 * @returns 復元したら true、バックアップが無ければ false。
 */
export function restoreFromBackup(dir: string, fileName: string): boolean {
  const bak = backupPath(dir, fileName);
  if (!existsSync(bak)) return false;
  const dest = join(dir, fileName);
  copyFileSync(bak, dest);
  return true;
}
