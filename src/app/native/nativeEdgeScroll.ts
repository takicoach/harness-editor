import {edgeScrollFrameScale,edgeScrollSpeed} from '../timeline/timelineScroll';

export interface HoverEdgeInput {
  pointerX:number;pointerY:number;
  rect:{left:number;right:number;top:number;bottom:number};
  /** トラック見出しの固定幅。ここより左では発動しない。 */
  gutter:number;
  /** rAF の前フレームからの経過（ms）。初回は null。 */
  dtMs:number|null;
}

/**
 * ドラッグしていないときの端ホバー自動スクロール量（px / このフレーム）を返す。
 *
 * 速度そのものは legacy と同じ `edgeScrollSpeed`（px/秒・食い込みの 2 乗）を使い、
 * ここでは実時間へ落とすだけにする。ドラッグ中の `edgeScrollVelocity` とは
 * 別系統（ドラッグ中は端に張り付いた時 20px/フレーム固定、ホバーは 1600px/秒）。
 *
 * 発動域の幅も別系統であることに注意（意図的・legacy の挙動をそのまま保つ）:
 * - ホバー: `edgeScrollZone(inner)` ＝可視幅の 4%、28px 以上 64px 以下（広い画面ほど広い）
 * - ドラッグ: `EDGE_ZONE_PX` ＝ 40px 固定
 * つまり幅 700px 未満の可視域ではホバーの方が狭く、1600px 超では広い。
 */
export function hoverEdgeScrollDelta({pointerX,pointerY,rect,gutter,dtMs}:HoverEdgeInput):number {
  const perSecond=edgeScrollSpeed({pointerX,pointerY,rect,gutter});
  if(perSecond===0)return 0;
  return perSecond*(edgeScrollFrameScale(dtMs)/60);
}
