/**
 * 新機能の「NEW」バッジ機構。
 *
 * 方針は2つだけ:
 * 1. **どれが新しいかは各エントリの `addedIn`（機能世代タグ）で表す**。チュートリアル
 *    （tutorialSteps.ts）とヘルプ図鑑（helpTopics.ts）のデータに 1 行足すだけで NEW になり、
 *    次の世代へ進めるときは下の `CURRENT_FEATURE_GENERATION` を書き換えれば全項目が一斉に
 *    「もう新しくない」へ落ちる（個別の真偽値を各所へバラ撒かない）。
 * 2. **既読はブラウザの localStorage**（キー `sme.featureSeen.<scope>.<id>`）。読めない・書けない環境
 *    （プライベートウィンドウ・ストレージ無効）でも例外を投げず、常に未読＝NEW 表示で動く。
 *    バッジの見せすぎより、クラッシュや保存失敗の握り潰しのほうが害が大きいため。
 * 3. **scope でキーの名前空間を分ける**。tutorialSteps と helpTopics は id を 9 個共有しており
 *    （`board`/`create` は両方 `addedIn: '2026-08'`）、id だけをキーにすると初回チュートリアルで
 *    board ステップを見ただけで、開いてもいない図鑑側の NEW が消える（逆向きも起きる）。
 * 4. **保存する値は「既読になった世代」**で、判定は現行世代との一致。存在有無で判定すると、
 *    既存 id の `addedIn` を次の世代へ貼り替えても旧世代の既読が残って再 NEW 化できない。
 */

/** 既読キーの名前空間。図鑑（helpTopics）とチュートリアル（tutorialSteps）は id を共有する。 */
export type FeatureScope = 'help' | 'tutorial';

/** 現行の機能世代。ここに一致する `addedIn` を持つ項目だけが NEW 候補になる。 */
export const CURRENT_FEATURE_GENERATION = '2026-08';

const KEY_PREFIX = 'sme.featureSeen.';

/** 既読フラグの localStorage キー。 */
export function featureSeenKey(scope: FeatureScope, id: string): string {
  return `${KEY_PREFIX}${scope}.${id}`;
}

/** その `addedIn` が現行世代（＝新機能扱い）か。タグ無しは常に false。 */
export function isNewGeneration(addedIn: string | undefined): boolean {
  return addedIn !== undefined && addedIn === CURRENT_FEATURE_GENERATION;
}

/** NEW バッジを出すか（新機能かつ未読）。表示側はこの純関数だけを見る。 */
export function showNewBadge(
  addedIn: string | undefined,
  id: string,
  seen: ReadonlySet<string>,
): boolean {
  return isNewGeneration(addedIn) && !seen.has(id);
}

/**
 * 既読か。**現行世代で既読になったものだけ**を既読とみなす（旧世代の値は未読＝再 NEW 化）。
 * localStorage が読めない環境では未読扱い。
 */
export function isFeatureSeen(scope: FeatureScope, id: string): boolean {
  try {
    return localStorage.getItem(featureSeenKey(scope, id)) === CURRENT_FEATURE_GENERATION;
  } catch {
    return false;
  }
}

/** 既読にする（書けない環境では何もしない）。 */
export function markFeatureSeen(scope: FeatureScope, id: string): void {
  try {
    localStorage.setItem(featureSeenKey(scope, id), CURRENT_FEATURE_GENERATION);
  } catch {
    /* 保存できない環境では NEW のままでよい */
  }
}

/** 指定 id 群のうち既読のものの集合。 */
export function loadSeenFeatures(scope: FeatureScope, ids: readonly string[]): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (isFeatureSeen(scope, id)) seen.add(id);
  }
  return seen;
}
