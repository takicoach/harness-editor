import { normalizeCutRegions } from '../../core/cutEngine';
import type { CutRegion, WordChip } from '../../core/types';

/**
 * 単語チップがカット済みか判定する。
 * 「カット済み」= チップ区間 [originalStart, originalEnd] が、ある 1 つのカット区間へ
 * 完全に含まれること。単語削除カットは必ず単語区間ぴったりを cutRegions へ入れるため、
 * 完全包含で判定すれば「この単語が削除済みか」が一意に決まる。
 */
export function chipCutState(chip: WordChip, regions: CutRegion[]): boolean {
  for (const r of normalizeCutRegions(regions)) {
    if (chip.originalStart >= r.start && chip.originalEnd <= r.end) {
      return true;
    }
  }
  return false;
}
