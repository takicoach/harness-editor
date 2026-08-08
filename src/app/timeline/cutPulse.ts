import type { CutRegion } from '../../core/types';

/** カット区間を一意に表すキー（start-end）。 */
export function regionKey(r: CutRegion): string {
  return `${r.start}-${r.end}`;
}

/** prev には無く next にだけ存在する区間のキー一覧（＝新規追加されたカット）。 */
export function newRegionKeys(prev: CutRegion[], next: CutRegion[]): string[] {
  const prevKeys = new Set(prev.map(regionKey));
  return next.map(regionKey).filter((k) => !prevKeys.has(k));
}

/**
 * cutRegions の変化からパルスすべき新規カットのキーを返す。
 * カット区間の「本数が増えたとき」だけを新規追加とみなす。カット端の調整
 * （resizeCutRegion）は remove+add で本数が変わらないためパルス対象外。
 */
export function pulseKeysForChange(prev: CutRegion[], next: CutRegion[]): string[] {
  if (next.length <= prev.length) return [];
  return newRegionKeys(prev, next);
}
