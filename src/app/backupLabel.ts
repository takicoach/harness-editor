/**
 * 退避先（`.sme/backup/<日時>/`）を、利用者が読める現地時刻の言い換えにする。
 *
 * フォルダ名は UTC の ISO 8601（`backupStamp`）で作られている。ファイル名として
 * 安全でソートも効くのでそのまま使うが、利用者への案内でこれをそのまま見せると
 * 「日本時間の何時なのか」が分からない（サイクル 2 Minor）。
 * 画面には「9月7日 01:12 の控え」と出し、フォルダ名は場所の手がかりとして併記する。
 */

/** `2026-09-07T01-12-00-000Z` 形式のフォルダ名を Date に戻す。読めなければ null。 */
export function parseBackupStamp(backupDir: string): Date | null {
  const name = backupDir.split('/').filter((s) => s !== '').pop() ?? '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(name);
  if (m === null) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 「9月7日 01:12 の控え」（現地時刻）。読めないフォルダ名なら null を返し、
 * 呼び出し側はフォルダ名だけを出す。
 */
export function backupTimeLabel(backupDir: string): string | null {
  const d = parseBackupStamp(backupDir);
  if (d === null) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())} の控え`;
}
