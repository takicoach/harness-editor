import {clampZoom,MAX_PX_PER_FRAME} from '../timeline/timelineGeometry';
import {NATIVE_TIMELINE_GUTTER} from './useNativeTimelineViewport';

/**
 * 表示総フレームがガターの右側にちょうど収まる pxPerFrame を返す。
 *
 * 共有の `fitPxPerFrame`（timelineGeometry.ts:98）は legacy のガター 88px を前提にしているため
 * native からは使えない。native の見出し幅は 132px（NATIVE_TIMELINE_GUTTER）で、ここだけが違う。
 * 算出できない（幅 0・フレーム 0・非有限）ときは null を返し、呼び出し側は今の倍率を保つ。
 */
export function nativeFitZoom(totalFrames:number,clientWidth:number):number|null {
  if(!Number.isFinite(totalFrames)||totalFrames<=0)return null;
  const usable=clientWidth-NATIVE_TIMELINE_GUTTER;
  if(!Number.isFinite(usable)||usable<=0)return null;
  return clampZoom(usable/totalFrames);
}

/**
 * ズームスライダーの `min` 用の床。
 *
 * 短い案件（総フレーム数が少ない、または幅が広い）では fit 倍率が上限 MAX_PX_PER_FRAME に
 * 張り付くことがある。それをそのままスライダーの min にすると min===max となり操作不能になる
 * （T5 で全体表示の床をそのまま min にした際の回帰）。床には MAX の半分を上限として残し、
 * 「左端＝全体表示」の意図は保ちつつ、そこからさらに拡大できる余地を確保する。
 */
export function nativeMinZoom(totalFrames:number,clientWidth:number):number|null {
  const fit=nativeFitZoom(totalFrames,clientWidth);
  if(fit===null)return null;
  return Math.min(fit,MAX_PX_PER_FRAME/2);
}
