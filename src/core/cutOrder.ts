import { applyCuts, monotoneToOrdered, orderedToMonotone } from './cutEngine';
import type { CutOrderAnchor, CutOrdering, CutRegion, CutSegment } from './types';

/**
 * カット並び替え（案A）の中核。
 *
 * cutData.ts は「残す区間の順序付きリスト」で、配列順＝再生順。
 * 再生順が原素材順と異なる（＝並び替え編集済み）プロジェクトが実在するが、
 * エディタ内部は「原素材−削除区間」の単調モデル（CutRegion[]）で編集するため、
 * そのままでは再生順が失われ、保存で並び替えが壊れる。
 *
 * 案A では順序を CutOrderAnchor[]（cutData.ts の配列順スナップショット）として別に保持し、
 * 単調モデルの再生座標へ「並び替え」段を 1 つ重ねる（速度スケール・トランジション重なりと
 * 同じ段構成）。恒等順列では全変換が恒等になり、従来プロジェクトの出力はバイト同値。
 */

/** cutData.ts の CutSegment[] を再生順（playbackStart 昇順・同値は配列順）のアンカー列へ写す。 */
export function cutOrderFromCutData(cutData: CutSegment[]): CutOrderAnchor[] {
  return [...cutData]
    .sort((a, b) => a.playbackStart - b.playbackStart)
    .map((s) => ({ originalStart: s.originalStart, originalEnd: s.originalEnd }));
}

/**
 * 各区間の「再生順位（rank）」をアンカーから求める。
 * - rank = 区間の**先頭フレーム**が属するアンカーの位置。カット解除で複数アンカーに
 *   跨って融合した区間は、先頭側の再生位置を継ぐ（中点で引くと 13 フレームのカット解除で
 *   冒頭ショットが中盤へ飛ぶ）。
 * - どのアンカーにも属さない新出区間（カット解除で現れた素材など）は、
 *   原素材順で直前（無ければ直後）の確定区間の隣へ 0.5 刻みで挿す。
 */
function ranksOf(segments: CutSegment[], anchors: CutOrderAnchor[]): number[] {
  const ranks = segments.map((seg) => {
    const head = seg.originalStart;
    return anchors.findIndex((a) => head >= a.originalStart && head < a.originalEnd);
  });
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i]! >= 0) continue;
    let prev = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (ranks[j]! >= 0) { prev = ranks[j]!; break; }
    }
    if (prev >= 0) { ranks[i] = prev + 0.5; continue; }
    let next = -1;
    for (let j = i + 1; j < ranks.length; j++) {
      if (ranks[j]! >= 0) { next = ranks[j]!; break; }
    }
    ranks[i] = next >= 0 ? next - 0.5 : i;
  }
  return ranks;
}

/**
 * 削除区間モデルから得た残す区間を、再生順アンカーの順序へ並べ替える。
 *
 * - playbackStart/End は並び順で累積再計算する。
 * - id は再生順に 1..n を振り直す（cutData.ts の慣習＝配列順に連番。恒等順列では
 *   applyCuts の付番と一致するため従来と同一）。
 * - 恒等順列なら入力配列をそのまま返す（同一参照＝以降の全変換が恒等）。
 */
export function orderCutSegments(
  segments: CutSegment[],
  anchors: CutOrderAnchor[] | undefined,
): CutSegment[] {
  if (anchors === undefined || anchors.length === 0 || segments.length === 0) return segments;
  const ranks = ranksOf(segments, anchors);
  const order = segments.map((_, i) => i);
  // rank 同値は原素材順を保つ（安定ソート）。
  order.sort((a, b) => (ranks[a]! - ranks[b]!) || (a - b));
  if (order.every((idx, i) => idx === i)) return segments;
  let cursor = 0;
  return order.map((idx, i) => {
    const s = segments[idx]!;
    const len = s.originalEnd - s.originalStart;
    const seg: CutSegment = {
      id: i + 1,
      originalStart: s.originalStart,
      originalEnd: s.originalEnd,
      playbackStart: cursor,
      playbackEnd: cursor + len,
    };
    cursor += len;
    return seg;
  });
}

/**
 * 原素材総尺・削除区間・再生順アンカーから CutOrdering（単調 ⇄ 再生順の対応表）を組む。
 * アンカー未指定（cutData.ts 不在）・恒等順列なら identity:true（従来経路と完全一致）。
 */
export function buildCutOrdering(
  originalTotalFrames: number,
  regions: CutRegion[],
  anchors: CutOrderAnchor[] | undefined,
): CutOrdering {
  const monotoneSegments = applyCuts(originalTotalFrames, regions);
  const segments = orderCutSegments(monotoneSegments, anchors);
  if (segments === monotoneSegments) {
    return {
      segments: monotoneSegments,
      monotone: monotoneSegments.map((s) => ({ start: s.playbackStart, end: s.playbackEnd })),
      identity: true,
    };
  }
  // segments[i] に対応する単調区間を原素材範囲で引き当てる（並び替えは originalStart を保つ）。
  const byOriginalStart = new Map(monotoneSegments.map((s) => [s.originalStart, s]));
  const monotone = segments.map((s) => {
    const m = byOriginalStart.get(s.originalStart)!;
    return { start: m.playbackStart, end: m.playbackEnd };
  });
  return { segments, monotone, identity: false };
}

/**
 * 変換元座標系で frame を含む区間の位置（ordered 配列上の index）。素材外なら -1。
 * toOrdered=true なら変換元は単調座標、false なら並び替え後の再生座標。
 */
function indexOfSpan(frame: number, ordering: CutOrdering, toOrdered: boolean): number {
  const ranges = toOrdered
    ? ordering.monotone
    : ordering.segments.map((s) => ({ start: s.playbackStart, end: s.playbackEnd }));
  return ranges.findIndex((r) => frame >= r.start && frame < r.end);
}

/**
 * index i から「両座標系で連続している」限り区間を伸ばした末尾（＝1 要素で表せる最大範囲）。
 * 並び替え後の再生座標は定義上つねに連続なので、単調側の連続性だけ見れば足りる。
 */
function contiguousRunCap(i: number, ordering: CutOrdering, toOrdered: boolean): number {
  let k = i;
  while (
    k + 1 < ordering.segments.length &&
    ordering.monotone[k]!.end === ordering.monotone[k + 1]!.start
  ) {
    k++;
  }
  return toOrdered ? ordering.segments[k]!.playbackEnd : ordering.monotone[k]!.end;
}

/**
 * 区間 [start, end) の写像。
 *
 * 並び替えでは両端が「変換先で連続しない区間」に属しうる。両端を独立に写すと、
 * end < start の逆転だけでなく **順方向のまま間の無関係な区間を丸呑みした巨大区間**
 * にもなる（例: 04 で先頭テロップの終端を数フレーム伸ばすと 12-883＝14.5 秒に化ける）。
 * そこで上限を「開始点が属する区間から連続している限り伸ばした末尾」に固定し、
 * そこを越える end は打ち切る。
 */
function mapSpan(
  start: number,
  end: number,
  ordering: CutOrdering,
  toOrdered: boolean,
): { start: number; end: number } {
  const s = toOrdered
    ? monotoneToOrdered(start, ordering, 'start')
    : orderedToMonotone(start, ordering, 'start');
  const e = toOrdered
    ? monotoneToOrdered(end, ordering, 'end')
    : orderedToMonotone(end, ordering, 'end');
  const i = indexOfSpan(start, ordering, toOrdered);
  // 素材外（区間に属さない開始点）は従来どおり逆転だけを潰す。
  if (i < 0) return e > s ? { start: s, end: e } : { start: s, end: s };
  const cap = contiguousRunCap(i, ordering, toOrdered);
  if (e > s && e <= cap) return { start: s, end: e };
  return { start: s, end: Math.max(s, cap) };
}

/** 単調再生座標の要素（startFrame/endFrame）を並び替え後の再生座標へ写す。 */
export function reorderStartEnd<T extends { startFrame: number; endFrame: number }>(
  items: T[],
  ordering: CutOrdering | undefined,
): T[] {
  if (ordering === undefined || ordering.identity) return items;
  return items.map((it) => {
    const { start, end } = mapSpan(it.startFrame, it.endFrame, ordering, true);
    return { ...it, startFrame: start, endFrame: end };
  });
}

/** reorderStartEnd の逆（並び替え後 → 単調）。 */
export function unreorderStartEnd<T extends { startFrame: number; endFrame: number }>(
  items: T[],
  ordering: CutOrdering | undefined,
): T[] {
  if (ordering === undefined || ordering.identity) return items;
  return items.map((it) => {
    const { start, end } = mapSpan(it.startFrame, it.endFrame, ordering, false);
    return { ...it, startFrame: start, endFrame: end };
  });
}

/** SE（endFrame 省略可能）版の reorderStartEnd。 */
export function reorderSe<T extends { startFrame: number; endFrame?: number }>(
  items: T[],
  ordering: CutOrdering | undefined,
): T[] {
  if (ordering === undefined || ordering.identity) return items;
  return items.map((it) => {
    if (it.endFrame === undefined) {
      return { ...it, startFrame: monotoneToOrdered(it.startFrame, ordering, 'start') };
    }
    const { start, end } = mapSpan(it.startFrame, it.endFrame, ordering, true);
    return { ...it, startFrame: start, endFrame: end };
  });
}

/** reorderSe の逆（並び替え後 → 単調）。 */
export function unreorderSe<T extends { startFrame: number; endFrame?: number }>(
  items: T[],
  ordering: CutOrdering | undefined,
): T[] {
  if (ordering === undefined || ordering.identity) return items;
  return items.map((it) => {
    if (it.endFrame === undefined) {
      return { ...it, startFrame: orderedToMonotone(it.startFrame, ordering, 'start') };
    }
    const { start, end } = mapSpan(it.startFrame, it.endFrame, ordering, false);
    return { ...it, startFrame: start, endFrame: end };
  });
}

/** cutOrderingOf のキャッシュ（cutRegions 配列の同一性で引く。編集のたびに新配列になる）。 */
const orderingCache = new WeakMap<
  CutRegion[],
  { total: number; anchors: CutOrderAnchor[] | undefined; ordering: CutOrdering }
>();

/**
 * 編集状態（EditState / EditorProject いずれも可）から CutOrdering を得る。
 * UI から高頻度で呼ばれるため cutRegions 配列の同一性でメモ化する。
 */
export function cutOrderingOf(state: {
  cutRegions: CutRegion[];
  cutOrder?: CutOrderAnchor[];
  originalTotalFrames?: number;
  videoConfig?: { durationFrames: number };
}): CutOrdering {
  const total = state.originalTotalFrames ?? state.videoConfig?.durationFrames ?? 0;
  const cached = orderingCache.get(state.cutRegions);
  if (cached && cached.total === total && cached.anchors === state.cutOrder) return cached.ordering;
  const ordering = buildCutOrdering(total, state.cutRegions, state.cutOrder);
  orderingCache.set(state.cutRegions, { total, anchors: state.cutOrder, ordering });
  return ordering;
}
