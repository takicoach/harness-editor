import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * この環境・この場所でシンボリックリンクを作れるかを実際に試して確かめる。
 *
 * Windows は Developer Mode が無効だと通常ユーザーがファイルリンクを作れず、
 * ExFAT/FAT 上でも作れない。取り込みの途中で失敗して中途半端なプロジェクトを
 * 残すより、開始前に試して理由を出す方が親切なので事前診断に使う。
 *
 * 失敗時は例外をそのまま投げる（呼び出し側の canCreateSymlink がメッセージへ変換する）。
 */
export function probeSymlinkSupport(tmpDir: string): void {
  mkdirSync(tmpDir, { recursive: true });
  const linkPath = join(tmpDir, `.symlink-probe-${process.pid}`);
  rmSync(linkPath, { force: true });
  try {
    // リンク先は存在しなくてよい（作成可否だけを見る）。
    symlinkSync(join(tmpDir, '.symlink-probe-target'), linkPath);
  } finally {
    rmSync(linkPath, { force: true });
  }
}
