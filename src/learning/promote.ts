import type { StoreSnapshot, WordReplacement } from './types';

/**
 * 語句ルール候補を「昇格可能」と「競合（あいまい）」に分ける。
 * 同じ before が既存ストア、または同一バッチ内の先行ルールで別の after に
 * マップ済みなら競合とみなす（先勝ち）。競合ルールは自動辞書へ入れない。
 */
export function partitionByConflict(
  store: StoreSnapshot,
  rules: WordReplacement[],
): { promotable: WordReplacement[]; conflicts: WordReplacement[] } {
  const effective: Record<string, string> = { ...store.typoDict.replace };
  const promotable: WordReplacement[] = [];
  const conflicts: WordReplacement[] = [];
  for (const rule of rules) {
    const existing = effective[rule.before];
    if (existing !== undefined && existing !== rule.after) {
      conflicts.push(rule);
    } else {
      promotable.push(rule);
      effective[rule.before] = rule.after;
    }
  }
  return { promotable, conflicts };
}

/**
 * 語句ルール候補をストアスナップショットへマージする（明確なルールは自動昇格）。
 * 既存ルールの再観測は観測回数を加算する。入力は破壊せず新しいスナップショットを返す。
 */
export function promoteWordRules(
  store: StoreSnapshot,
  rules: WordReplacement[],
  videoId: string,
): StoreSnapshot {
  const replace = { ...store.typoDict.replace };
  const observations = { ...store.typoDictMeta.observations };
  const lastSeen = { ...store.typoDictMeta.lastSeen };

  for (const rule of rules) {
    replace[rule.before] = rule.after;
    observations[rule.before] = (observations[rule.before] ?? 0) + 1;
    lastSeen[rule.before] = videoId;
  }

  return {
    typoDict: { ...store.typoDict, replace },
    typoDictMeta: { observations, lastSeen },
  };
}

/** 語句ルールを replace とメタから取り除く（誤学習の個別取り消し）。 */
export function unlearnWord(store: StoreSnapshot, before: string): StoreSnapshot {
  const replace = { ...store.typoDict.replace };
  const observations = { ...store.typoDictMeta.observations };
  const lastSeen = { ...store.typoDictMeta.lastSeen };
  delete replace[before];
  delete observations[before];
  delete lastSeen[before];
  return {
    typoDict: { ...store.typoDict, replace },
    typoDictMeta: { observations, lastSeen },
  };
}
