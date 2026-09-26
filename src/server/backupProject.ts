/**
 * 上書き保存の前の退避（監査 data-safety-4）。
 *
 * 衝突時の「この画面の内容で上書き保存」は、相手（別の画面や AI）がディスクへ書いた内容を
 * そのまま消していた。ゴミ箱にも残らず復元手段がゼロだったため、上書きの直前に
 * 現在のファイル群を `.sme/backup/<日時>/` へ複写する。`.sme/` は既存の
 * プロジェクト内メタ置き場（status.json / videoLink.json）と同じ慣行。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * `.sme/backup/` に残す世代の上限（サイクル 2 Minor）。
 *
 * 上書き保存のたびに丸ごと複写するため、無制限だと案件フォルダが際限なく太る。
 * 古い順に削り、直近 10 世代だけ残す（復元は「直前の内容」を戻す用途がほとんど）。
 */
export const BACKUP_KEEP = 10;

/** 退避フォルダ名に使える日時（コロン・ピリオドはファイル名に不向きなので置換）。 */
export function backupStamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * 対象の相対パス群のうち実在するものを `.sme/backup/<日時>/` へ複写する。
 * 戻り値はプロジェクトからの相対パス（利用者への案内・SaveResponse.backupDir 用）。
 * 複写対象が 1 つも無ければ null（空フォルダを作らない）。
 */
export function backupProjectFiles(
  dir: string,
  relPaths: readonly string[],
  now: Date = new Date(),
  keep: number = BACKUP_KEEP,
): string | null {
  const existing = relPaths.filter((rel) => existsSync(join(dir, rel)));
  if (existing.length === 0) return null;
  const relBackupDir = join('.sme', 'backup', backupStamp(now));
  const absBackupDir = join(dir, relBackupDir);
  for (const rel of existing) {
    const dest = join(absBackupDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(dir, rel), dest);
  }
  pruneBackups(join(dir, '.sme', 'backup'), keep);
  return relBackupDir;
}

/**
 * 退避フォルダを新しい順に `keep` 件だけ残し、古い世代を削る。
 *
 * フォルダ名は `backupStamp`（ISO 8601 のコロン・ピリオドを `-` にしたもの）なので
 * 辞書順＝時系列順。削除に失敗しても保存自体は止めない（退避は保険であり、
 * 掃除の失敗で本来の保存を落とすほうが害が大きい）。
 */
export function pruneBackups(backupRoot: string, keep: number = BACKUP_KEEP): void {
  if (keep < 0) return;
  let names: string[];
  try {
    names = readdirSync(backupRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      rmSync(join(backupRoot, name), { recursive: true, force: true });
    } catch {
      // 消せなくても保存は成功として扱う。次回の保存で再度試みる。
    }
  }
}
