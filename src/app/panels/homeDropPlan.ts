/**
 * ホーム画面へのドロップの振り分け（画面から切り出した純関数）。
 * - フォルダ: 1つにつき作品を1つ（中身は全部その作品の素材）
 * - ファイル: 1件につき作品を1つ
 * 混ざっていたらフォルダを先に、そのあとファイルを作る。
 */

/** 振り分けに必要な最低限（File そのものでなくても判定できるようにしておく）。 */
export interface DropCandidate {
  name: string;
  /** ブラウザが判定した MIME。フォルダは空になる。 */
  type: string;
  /**
   * `DataTransferItem.webkitGetAsEntry()` の判定。
   * 使えない環境では null で、その時だけ名前と MIME から推定する。
   */
  isDirectory: boolean | null;
}

/**
 * フォルダかどうか。`webkitGetAsEntry()` の判定があればそれに従う。
 * 無い時は「MIME が空で拡張子が無い」をフォルダと見なす — 最終判定はサーバの stat が行い、
 * フォルダでなければ not-a-directory が返るので、その時はファイルとして作り直せる。
 */
export function isFolderCandidate(candidate: DropCandidate): boolean {
  return candidate.isDirectory ?? (candidate.type === '' && !/\.[A-Za-z0-9]{1,6}$/.test(candidate.name));
}

/** ドロップされたものをフォルダとファイルに分ける（順序は受け取ったまま）。 */
export function planHomeDrop<T extends DropCandidate>(items: readonly T[]): { folders: T[]; files: T[] } {
  const folders: T[] = [];
  const files: T[] = [];
  for (const item of items) (isFolderCandidate(item) ? folders : files).push(item);
  return { folders, files };
}

/**
 * 既にある作品名とぶつからない名前にする（`名前 2`、`名前 3`…）。
 * 1回のドロップで作る分も taken に足していくので、同名のファイルを同時に渡しても衝突しない。
 */
export function uniqueProjectName(base: string, taken: Set<string>): string {
  let name = base;
  for (let suffix = 2; taken.has(name); suffix += 1) name = `${base} ${suffix}`;
  taken.add(name);
  return name;
}

/** まとめて作ったあとの通知文（成功と失敗を1行に）。 */
export function importSummary(label: string, made: readonly string[], failed: readonly string[]): string {
  const head = made.length > 0
    ? `${label}から ${made.length} 件作成しました: ${made.join('、')}`
    : `${label}から作成できませんでした`;
  return failed.length > 0 ? `${head}（失敗 ${failed.length} 件 — ${failed.join(' / ')}）` : head;
}
