/** 選んだ動画ファイルから新規プロジェクト名の初期値を作る（例: 2026-07-10-DJI_0688）。 */
export function defaultProjectName(fileName: string, now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const stem = fileName.replace(/\.[^.]+$/, '').normalize('NFC').trim();
  return `${y}-${m}-${d}${stem === '' ? '' : `-${stem}`}`;
}

/** Mac と Windows の標準のフォルダは大文字と小文字を区別しないので、名前の重なりはそれを無視して比べる。 */
const nameKey = (name: string) => name.normalize('NFC').toLowerCase();

/** サーバが断る文字を避け、上限 80 文字に収め、既存・同じ回の名前と重なれば「 (2)」から付ける（設計 3-3）。 */
function uniqueNames(bases: readonly string[], taken: Iterable<string>): string[] {
  const used = new Set([...taken].map(nameKey)), names: string[] = [];
  for (const raw of bases) {
    const base = raw.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '.');
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? '' : ` (${n})`, name = base.slice(0, 80 - suffix.length).trimEnd() + suffix;
      if (!used.has(nameKey(name))) { used.add(nameKey(name)); names.push(name); break; }
    }
  }
  return names;
}

/** 複数の動画を別々のプロジェクトにする時の名前（日付-ファイル名）。 */
export function uniqueProjectNames(fileNames: readonly string[], taken: Iterable<string>, now: Date = new Date()): string[] {
  return uniqueNames(fileNames.map((fileName) => defaultProjectName(fileName, now)), taken);
}

/** 複数のフォルダを別々のプロジェクトにする時の名前。フォルダ名をそのまま使う（1 つのドロップと同じ）。 */
export function uniqueFolderProjectNames(folderNames: readonly string[], taken: Iterable<string>): string[] {
  return uniqueNames(folderNames.map((name) => name.normalize('NFC').trim()), taken);
}
