/**
 * buildTransitionSeriesChildren — EditorComposition から切り出した純関数。
 *
 * @remotion/transitions を import しないため、ユニットテストで
 * Remotion バージョン衝突エラーが起きない（DOM 不要・純データ操作のみ）。
 */
import { buildOverlaps, isOverlapKind } from '../core/transitionEngine';
import type { Join } from '../core/joinEngine';
import type { CutSegment, SceneTransition, SceneTransitionKind, SlideDirection } from '../core/types';

// ─────────────────────────────────────────────────────────
// TransitionSeries 子要素記述子（純データ・DOM 非依存）
// ─────────────────────────────────────────────────────────

/** TransitionSeries の Sequence 要素。seg は元の CutSegment。 */
export interface TSCSequenceItem {
  type: 'sequence';
  seg: CutSegment;
}

/** TransitionSeries の Transition 要素。overlap はクランプ済みフレーム数。 */
export interface TSCTransitionItem {
  type: 'transition';
  kind: SceneTransitionKind;
  direction?: SlideDirection;
  overlap: number;
}

export type TSCItem = TSCSequenceItem | TSCTransitionItem;

/**
 * keptSegments・sceneTransitions・joins から TransitionSeries の子要素記述子リストを組む純関数。
 *
 * 戻り値は `[sequence, transition?, sequence, transition?, ..., sequence]` のパターン。
 * 境界 i（前区間 playbackEnd）に対応する sceneTransition を joins 経由で引き、
 * 重なる系（crossfade/slide/wipe）なら間に transition を差し込む。
 * overlap 量は buildOverlaps と同じクランプ（隣接区間の短い方の半分）を使う。
 *
 * overlaps 空（重なる系なし）のとき、Transition は 1 つも含まれない
 * ＝TransitionSeries が連続 Sequence を前詰めで描く＝従来の keptSegments map と同一描画。
 *
 * @param keptSegments  カット後の区間リスト（at=再生フレーム）
 * @param sceneTransitions  シーン転換リスト（at=原本フレーム）
 * @param joins  atOriginal→playbackFrame 対応表
 */
export function buildTransitionSeriesChildren(
  keptSegments: CutSegment[],
  sceneTransitions: SceneTransition[],
  joins: Join[],
): TSCItem[] {
  // buildOverlaps は at=再生フレームの transitions を期待するが、
  // sceneTransitions の at は原本フレーム。joins 経由で at=再生へ変換した
  // 一時 transitions を作って buildOverlaps に渡し、クランプ済み overlap を取得する。
  const playbackTransitions: SceneTransition[] = sceneTransitions.flatMap((t) => {
    if (typeof t.at !== 'number') return [];
    const join = joins.find((j) => j.atOriginal === t.at);
    if (join === undefined) return [];
    return [{ ...t, at: join.playbackFrame }];
  });
  const overlaps = buildOverlaps(playbackTransitions, keptSegments);
  // boundary → overlap の Map（クランプ済み）
  const overlapMap = new Map<number, number>(overlaps.map((o) => [o.boundary, o.overlap]));

  const items: TSCItem[] = [];
  for (let i = 0; i < keptSegments.length; i++) {
    const seg = keptSegments[i]!;
    if (i > 0) {
      // 前区間の playbackEnd がこの区間の「境界」。
      const prevEnd = keptSegments[i - 1]!.playbackEnd;
      // この境界に重なる系の転換があるか。
      // joins を逆引きして atOriginal を取得し、sceneTransitions.at と突き合わせる。
      const join = joins.find((j) => j.playbackFrame === prevEnd);
      if (join !== undefined) {
        const st = sceneTransitions.find((t) => t.at === join.atOriginal);
        if (st !== undefined && isOverlapKind(st.kind)) {
          const overlap = overlapMap.get(prevEnd) ?? 0;
          if (overlap > 0) {
            items.push({ type: 'transition', kind: st.kind, direction: st.direction, overlap });
          }
        }
      }
    }
    items.push({ type: 'sequence', seg });
  }
  return items;
}
