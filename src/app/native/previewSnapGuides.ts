import {SNAP_LINES,snapAxis} from '../preview/previewSnap';

/**
 * 吸着候補（正規化座標）。OSS `src/app/preview/previewSnap.ts:6` をそのまま再輸出する。
 * legacy も native も端〜端が 2 の正規化座標なので座標変換は挟まない（`previewSnapGuides.test.ts` で固定）。
 * 端（±1）は構図上の意味が薄いので対象外。
 */
export const PREVIEW_SNAP_LINES=SNAP_LINES;
/** 合成面は非等方 scale なので許容は px ではなく正規化差分で持つ（裁定 P1-5・設計 G）。 */
export const PREVIEW_SNAP_TOLERANCE=.02;
export interface PlacementSnap {x:number;y:number;guideX:number|null;guideY:number|null}

/** 配置（正規化中心）の x/y を独立に吸着する。判定そのものは legacy の `snapAxis` に委ねる。 */
export function snapPlacement(x:number,y:number,tolerance=PREVIEW_SNAP_TOLERANCE):PlacementSnap{
  const sx=snapAxis(x,tolerance),sy=snapAxis(y,tolerance);
  return {x:sx.value,y:sy.value,guideX:sx.line,guideY:sy.line};
}
