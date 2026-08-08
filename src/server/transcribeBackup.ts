import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `<dir>/<fileName>` が存在すれば `<dir>/<fileBase>.backup-YYYY-MM-DD-HHMMSS.<ext>` へコピーする。
 * 既存ファイルが無ければ null を返す。`now` はテスト用に注入可能。
 */
export function writeTimestampedBackup(
  dir: string,
  fileName: string,
  now: Date = new Date(),
): string | null {
  const src = join(dir, fileName);
  if (!existsSync(src)) return null;
  const stamp = formatStamp(now);
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const bak = join(dir, `${base}.backup-${stamp}${ext}`);
  copyFileSync(src, bak);
  return bak;
}

function formatStamp(d: Date): string {
  // UTC ベースで安定したテストが書けるよう、UTC を採用する。
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}
