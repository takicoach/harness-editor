/**
 * ホームの「選択モード」の純ロジック。進行ボード／一覧のどちらからも同じ関数で
 * 選択集合を扱えるよう、UI コンポーネントから切り出してある（後で一覧側にも足せる形）。
 */

/** 選択集合に id を足す／外す。元の配列は破壊しない。 */
export function toggleSelection(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id];
}

/**
 * 一覧に存在しなくなったプロジェクトの id を選択集合から落とす
 * （削除・外部変更で消えたカードが「N 件選択中」に数え残るのを防ぐ）。
 * 落とすものが無ければ**同一参照**を返す — state に入れたときの無駄な再描画を作らない。
 */
export function pruneSelection(
  ids: readonly string[],
  present: ReadonlyArray<{ id: string }>,
): string[] {
  if (ids.length === 0) return ids as string[];
  const alive = new Set(present.map((p) => p.id));
  const next = ids.filter((id) => alive.has(id));
  return next.length === ids.length ? (ids as string[]) : next;
}
