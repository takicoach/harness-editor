import { computeJoins, resolveSceneTransitions } from '../../core/joinEngine';
import { applyCuts } from '../../core/cutEngine';
import { buildOverlaps } from '../../core/transitionEngine';
import type { PlaybackOverlap } from '../../core/transitionEngine';
import type { CutOrdering, SceneTransition, CutRegion } from '../../core/types';

/**
 * タイムライン定規（再生座標）と Remotion プレイヤー（最終座標）を橋渡しする
 * overlaps を構築する純関数。
 *
 * - sceneTransitions: at=原本フレームで保存された転換情報
 * - totalFrames: 原本総尺（baseProject.videoConfig.durationFrames）
 * - cutRegions: カット削除区間
 *
 * overlaps 空（カット無し or 重なる系なし）なら finalToPlayback/playbackToFinal は恒等
 * → 既存の再生ヘッド・シーク挙動と完全一致。
 */
export function timelineOverlaps(
  sceneTransitions: SceneTransition[],
  totalFrames: number,
  cutRegions: CutRegion[],
  ordering?: CutOrdering,
): PlaybackOverlap[] {
  const joins = computeJoins(totalFrames, cutRegions, ordering);
  const segs = ordering ? ordering.segments : applyCuts(totalFrames, cutRegions);
  const resolved = resolveSceneTransitions(sceneTransitions, joins);
  const playbackTransitions = resolved.map((r) => ({ ...r.transition, at: r.playbackFrame }));
  return buildOverlaps(playbackTransitions, segs);
}
