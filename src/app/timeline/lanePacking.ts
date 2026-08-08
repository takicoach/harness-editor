/** レーン割り当ての入力アイテム。半開区間 [start, end)。 */
export interface LaneItem {
  start: number;
  end: number;
}

/** assignLanes の結果。lanes は入力順に整列したレーン番号（0 始まり）。 */
export interface LaneAssignment {
  lanes: number[];
  laneCount: number;
}

/**
 * 区間アイテムを最小数のレーンへ貪欲法で割り当てる（カレンダーの段組みと同じ）。
 * 半開区間なので端が接するだけ（laneEnd <= item.start）なら同一レーンに同居できる。
 * 結果は決定的: start 昇順 → 元インデックス昇順で安定ソートして処理する。
 * 各アイテムは「最後の end が start 以下になる最小番号のレーン」へ置き、無ければ新レーンを開く。
 */
export function assignLanes(items: LaneItem[]): LaneAssignment {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.start - b.item.start || a.index - b.index);

  const laneEnds: number[] = []; // laneEnds[l] = レーン l に最後に置いたアイテムの end
  const lanes: number[] = new Array<number>(items.length).fill(0); // 0 は仮初期値。全要素が order ループで必ず上書きされる

  for (const { item, index } of order) {
    let placed = -1;
    for (let l = 0; l < laneEnds.length; l++) {
      const laneEnd = laneEnds[l];
      if (laneEnd !== undefined && laneEnd <= item.start) {
        placed = l;
        break;
      }
    }
    if (placed === -1) {
      placed = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[placed] = item.end;
    }
    lanes[index] = placed;
  }

  return { lanes, laneCount: laneEnds.length };
}
