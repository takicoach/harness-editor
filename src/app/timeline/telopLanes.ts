import { assignLanes } from './lanePacking';

/** テロップのレーン割り当て入力。manual=true は装飾テロップ。 */
export interface TelopLaneItem {
  start: number;
  end: number;
  manual: boolean;
}

/**
 * 字幕（manual=false）は全て lane 0 に固定し、装飾（manual=true）は
 * その下段（字幕がある時は lane 1 以降）で assignLanes により段組みする。
 * 字幕が1つも無ければ装飾は lane 0 から積む（上段を空けない）。
 * lanes は入力順、laneCount は最大 lane+1（空入力は 0）。
 */
export function assignTelopLanes(items: TelopLaneItem[]): { lanes: number[]; laneCount: number } {
  const lanes = new Array<number>(items.length).fill(0); // 字幕は 0 のまま
  const hasSubtitle = items.some((it) => !it.manual);
  const manualOffset = hasSubtitle ? 1 : 0;

  const manualIdx: number[] = [];
  const manualItems: { start: number; end: number }[] = [];
  items.forEach((it, i) => {
    if (it.manual) {
      manualIdx.push(i);
      manualItems.push({ start: it.start, end: it.end });
    }
  });
  const manualAssign = assignLanes(manualItems);
  manualIdx.forEach((origIdx, k) => {
    // assignLanes は入力（manualItems）と同数の lanes を必ず返すため lane は常に定義済み。
    // `?? 0` は noUncheckedIndexedAccess 対策の型ガードで、実行時には選ばれない。
    const lane = manualAssign.lanes[k];
    lanes[origIdx] = manualOffset + (lane ?? 0);
  });

  if (items.length === 0) return { lanes, laneCount: 0 };
  let maxLane = 0;
  for (const l of lanes) maxLane = Math.max(maxLane, l);
  return { lanes, laneCount: maxLane + 1 };
}
