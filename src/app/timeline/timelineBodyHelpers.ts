import type { CutRegion } from '../../core/types';
import type { CutHandleId } from './CutTrack';

/**
 * resizeCutRegion 適用後の新 cutRegions から、動かした端 movedFrame を含む実区間を見つけ、
 * その区間を指す CutHandleId を返す。区間が潰れて消えていれば null。
 * edge='start' なら probe = movedFrame（区間の始点が movedFrame と一致 or マージ元より左）、
 * edge='end'   なら probe = movedFrame-1（区間の終点 > movedFrame-1 を確認）。
 */
export function resolveCutHandle(
  nextRegions: CutRegion[],
  edge: 'start' | 'end',
  movedFrame: number,
): CutHandleId | null {
  const probe = edge === 'start' ? movedFrame : movedFrame - 1;
  const region = nextRegions.find((r) => r.start <= probe && probe < r.end);
  return region === undefined ? null : { kind: 'cut', region, edge };
}
