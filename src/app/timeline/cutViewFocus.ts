import type { CutRegion } from '../../core/types';
import { normalizeCutRegions } from '../../core/cutEngine';

/** カット内の原本frameを、完成順へ戻せる最も近い表示frameへ寄せる。 */
export function nearestKeptOriginalFrame(frame: number, totalFrames: number, regions: readonly CutRegion[]): number {
  const last = Math.max(0, totalFrames - 1);
  const clamped = Math.max(0, Math.min(last, Math.round(frame)));
  const cut = normalizeCutRegions([...regions]).find((region) => clamped >= region.start && clamped < region.end);
  if (cut === undefined) return clamped;
  const before = cut.start > 0 ? cut.start - 1 : null;
  const after = cut.end < totalFrames ? cut.end : null;
  if (before === null) return after ?? 0;
  if (after === null) return before;
  return clamped - before <= after - clamped ? before : after;
}
