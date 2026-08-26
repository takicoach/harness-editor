import { useEffect, useState } from 'react';
import { isFeatureSeen, isNewGeneration, markFeatureSeen, type FeatureScope } from './featureSeen';

// 既読キーの名前空間。図鑑（helpTopics）と id が重なるため必ず分ける。
const SCOPE: FeatureScope = 'tutorial';

/**
 * 「表示したら既読」型の NEW バッジ判定。
 * チュートリアルのように**項目を開くこと自体が確認**になる画面で使う
 * （一覧から選ぶ図鑑側は HelpModal が既読集合を持つ）。
 *
 * 初回表示のときだけ true を返し、同じ描画のうちに既読を書き込む
 * （＝次に同じステップを見た時はもう出ない）。localStorage が使えない環境では
 * 既読が残らないため常に NEW 表示になるが、これは意図した縮退（featureSeen.ts）。
 *
 * 既読は **`tutorial` スコープ固定**。id は図鑑（helpTopics）と 9 個重なっており、
 * スコープを分けないとチュートリアルを見ただけで図鑑側の NEW が消える。
 */
export function useFeatureBadge(id: string | null, addedIn: string | undefined): boolean {
  const [badgeFor, setBadgeFor] = useState<string | null>(null);

  useEffect(() => {
    if (id === null || !isNewGeneration(addedIn)) {
      setBadgeFor(null);
      return;
    }
    setBadgeFor(isFeatureSeen(SCOPE, id) ? null : id);
    markFeatureSeen(SCOPE, id);
  }, [id, addedIn]);

  return badgeFor !== null && badgeFor === id;
}
