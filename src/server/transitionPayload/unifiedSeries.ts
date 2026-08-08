import { buildOverlaps, isOverlapKind } from './transitionEngine';
import { scaleSegments, scaleTransitions } from './speedScale';
import type { CutSegment, SceneTransition, SceneTransitionKind, SlideDirection } from './types';

/** TransitionSeries.Sequence の記述子。mainSpeed===1 は endAt、それ以外は playbackRate。 */
export interface UnifiedSequenceItem {
  type: 'sequence';
  id: number;
  durationInFrames: number;
  startFrom: number;
  endAt?: number;
  playbackRate?: number;
}

/** TransitionSeries.Transition の記述子。overlap はクランプ済みフレーム数。 */
export interface UnifiedTransitionItem {
  type: 'transition';
  kind: SceneTransitionKind;
  direction?: SlideDirection;
  overlap: number;
  boundary: number;
}

export type UnifiedItem = UnifiedSequenceItem | UnifiedTransitionItem;

/**
 * cutData(再生座標)+transitions(再生座標 at)+mainSpeed から TransitionSeries 子要素の記述子列を作る。
 * EditorComposition の path 2 と同一: 区間・転換 at・durationFrames を speedScale してから
 * buildOverlaps を再計算する。mainSpeed===1 は scale 恒等＝現行 CutPlayerWithTransitions と同値。
 */
export function planUnifiedSeries(
  cutData: CutSegment[],
  transitions: SceneTransition[],
  mainSpeed: number,
): UnifiedItem[] {
  const segs = scaleSegments(cutData, mainSpeed);
  const trans = scaleTransitions(transitions, mainSpeed);

  const overlaps = buildOverlaps(
    trans.filter((t): t is SceneTransition & { at: number } => typeof t.at === 'number'),
    segs,
  );
  const overlapMap = new Map<number, number>(overlaps.map((o) => [o.boundary, o.overlap]));

  const items: UnifiedItem[] = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!;
    if (i > 0) {
      const prevEnd = segs[i - 1]!.playbackEnd;
      const st = trans.find((t) => typeof t.at === 'number' && t.at === prevEnd && isOverlapKind(t.kind));
      if (st !== undefined) {
        const overlap = overlapMap.get(prevEnd) ?? 0;
        if (overlap > 0) {
          items.push({ type: 'transition', kind: st.kind, direction: st.direction, overlap, boundary: prevEnd });
        }
      }
    }
    items.push({
      type: 'sequence',
      id: seg.id,
      durationInFrames: Math.max(1, seg.playbackEnd - seg.playbackStart),
      startFrom: seg.originalStart,
      ...(mainSpeed === 1 ? { endAt: seg.originalEnd } : { playbackRate: mainSpeed }),
    });
  }
  return items;
}
