/** 選んだ動画ファイルから新規プロジェクト名の初期値を作る（例: 2026-07-10-DJI_0688）。 */
export function defaultProjectName(fileName: string, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const stem = fileName.replace(/\.[^.]+$/, '').normalize('NFC').trim();
  return `${y}-${m}-${d}${stem === '' ? '' : `-${stem}`}`;
}
