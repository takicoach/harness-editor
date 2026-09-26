import {movePreviewPlacement,type PreviewCorner,type PreviewPlacement,type PreviewPoint,type PreviewRect} from './previewManipulation';

/**
 * まとめドラッグの 1 要素。`corners` と、各関数へ渡す `viewport` は**同じ原点**で揃えること
 * （合成面ローカルなら両方ローカル）。原点がずれると外接矩形の中心が正規化で狂う。
 */
export interface GroupMember {clipId:string;corners:Record<PreviewCorner,PreviewPoint>;placement:PreviewPlacement}
const CORNERS=['nw','ne','se','sw'] as const;

/** 選択全体の外接矩形（corners と同じ座標系）。拡縮の基準中心はこの矩形の中心。 */
export function groupBounds(members:readonly GroupMember[]):PreviewRect{
  if(!members.length)throw new RangeError('選択が空です');
  const xs=members.flatMap(m=>CORNERS.map(c=>m.corners[c].x)),ys=members.flatMap(m=>CORNERS.map(c=>m.corners[c].y));
  const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  return {x:left,y:top,width:right-left,height:bottom-top};
}

/** 全員へ同じ画面移動量を適用する（OSS `PreviewOverlay.tsx:322-340` の setTelopsPosition 相当）。 */
export function applyGroupMove(members:readonly GroupMember[],viewport:PreviewRect,delta:PreviewPoint):Map<string,PreviewPlacement>{
  const result=new Map<string,PreviewPlacement>();
  for(const member of members)result.set(member.clipId,movePreviewPlacement(member.placement,viewport,delta));
  return result;
}

/**
 * 外接矩形の中心を固定して同じ倍率を掛ける（設計 G：基準は選択の 1 件目ではない）。
 * 中心からの正規化オフセットも同じ倍率で伸ばすので、選択内の相対位置は保たれる。
 * 倍率が非正・非有限のとき、および 1 件でも scale が壊れるときは空を返して拡縮を拒否する。
 */
export function applyGroupScale(members:readonly GroupMember[],viewport:PreviewRect,ratio:number):Map<string,PreviewPlacement>{
  const result=new Map<string,PreviewPlacement>();
  if(!(ratio>0)||!Number.isFinite(ratio)||!members.length)return result;
  const bounds=groupBounds(members);
  const center={x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
  const cx=(center.x-viewport.x)/viewport.width*2-1,cy=(center.y-viewport.y)/viewport.height*2-1;
  if(!Number.isFinite(cx)||!Number.isFinite(cy))return new Map();
  for(const member of members){
    const scale=member.placement.scale*ratio;
    if(!(scale>0)||!Number.isFinite(scale))return new Map();
    result.set(member.clipId,{...member.placement,scale,x:cx+(member.placement.x-cx)*ratio,y:cy+(member.placement.y-cy)*ratio});
  }
  return result;
}
