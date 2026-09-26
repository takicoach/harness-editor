import type {ShapeKind} from '../../core/types';
import type {PreviewPoint,PreviewRect} from './previewManipulation';
import {nearlySamePoint,type ShapeData} from './shapeDraft';

export type ShapeHandleId='p1'|'p2'|'p3';
const clamp=(value:number)=>Math.max(0,Math.min(1,value));
const toClient=(x:number,y:number,viewport:PreviewRect):PreviewPoint=>({x:viewport.x+x*viewport.width,y:viewport.y+y*viewport.height});

/** 端点ハンドルで直接動かす図形。箱（四隅）で扱う rect/ellipse/triangle と排他。 */
export const isEndpointShape=(kind:ShapeKind):boolean=>kind==='line'||kind==='arrow'||kind==='angle';

/** 端点ハンドルを持つ図形だけ点を返す。箱で扱う rect/ellipse/triangle は空。 */
export function shapeHandlePoints(data:ShapeData,viewport:PreviewRect):Partial<Record<ShapeHandleId,PreviewPoint>>{
  if(!(viewport.width>0)||!(viewport.height>0))return {};
  if(data.kind==='line'||data.kind==='arrow')return {p1:toClient(data.x1,data.y1,viewport),p2:toClient(data.x2,data.y2,viewport)};
  if(data.kind==='angle')return {p1:toClient(data.x1,data.y1,viewport),p2:toClient(data.x2,data.y2,viewport),p3:toClient(data.x3??data.x1,data.y3??data.y1,viewport)};
  return {};
}

/**
 * 端点ハンドル用の実効ビューポート。図形の正規化座標は合成面の座標なので、
 * レイヤーの基本配置（位置・拡縮）を畳んだ矩形へ写してから client 座標にする。
 * 回転・反転は矩形で表せないため null を返す（＝端点操作を出さない）。
 */
export function shapeHandleViewport(viewport:PreviewRect,placement:{x:number;y:number;scale:number;rotation:number;flipH:boolean;flipV:boolean}):PreviewRect|null{
  if(!(viewport.width>0)||!(viewport.height>0))return null;
  if(!(placement.scale>0)||!Number.isFinite(placement.x)||!Number.isFinite(placement.y))return null;
  // 実質ゼロ回転（丸め誤差由来の極小値）は矩形として扱う。反転は真偽値なので厳密判定のままでよい。
  if(Math.abs(placement.rotation)>1e-6||placement.flipH||placement.flipV)return null;
  return {x:viewport.x+viewport.width*(1+placement.x-placement.scale)/2,
    y:viewport.y+viewport.height*(1+placement.y-placement.scale)/2,
    width:viewport.width*placement.scale,height:viewport.height*placement.scale};
}

/** 辺の長さ 0（＝validate が弾く形）。resolution を渡すと実寸 px の退化ガードになる。 */
const degenerate=(data:ShapeData,resolution?:{width:number;height:number}):boolean=>{
  const same=(ax:number,ay:number,bx:number,by:number)=>nearlySamePoint(ax,ay,bx,by,resolution);
  if(data.kind==='angle')return same(data.x1,data.y1,data.x2,data.y2)||same(data.x1,data.y1,data.x3??data.x1,data.y3??data.y1);
  return same(data.x1,data.y1,data.x2,data.y2);
};

/** 掴んだ 1 点だけを動かす。0..1 へ丸め、辺長 0 になる結果は拒否して元を返す。 */
export function moveShapeHandle(data:ShapeData,id:ShapeHandleId,at:PreviewPoint,viewport:PreviewRect,resolution?:{width:number;height:number}):ShapeData{
  if(!(viewport.width>0)||!(viewport.height>0))return data;
  const x=clamp((at.x-viewport.x)/viewport.width),y=clamp((at.y-viewport.y)/viewport.height);
  if(!Number.isFinite(x)||!Number.isFinite(y))return data;
  const next:ShapeData=id==='p1'?{...data,x1:x,y1:y}:id==='p2'?{...data,x2:x,y2:y}:{...data,x3:x,y3:y};
  return degenerate(next,resolution)?data:next;
}

/** 分度器化したときの端点 B。頂点と重ならない向きを選ぶ（重なると validate が弾く）。 */
function initialVertexB(x1:number,y1:number,length:number):{x3:number;y3:number}{
  const span=length>0?length:.25;
  for(const candidate of [{x3:clamp(x1+span),y3:y1},{x3:clamp(x1-span),y3:y1}])if(candidate.x3!==x1)return candidate;
  return {x3:x1,y3:clamp(y1+span)!==y1?clamp(y1+span):clamp(y1-span)};
}

/** 「形」セレクトの変更規則。angle 化＝端点 B を水平右へ初期化、angle 離脱＝x3,y3 を捨てる。 */
export function shapeKindChange(data:ShapeData,next:ShapeKind):ShapeData{
  if(next==='angle'&&data.kind!=='angle')
    return {...data,kind:next,...initialVertexB(data.x1,data.y1,Math.hypot(data.x2-data.x1,data.y2-data.y1))};
  if(next!=='angle'&&data.kind==='angle'){
    const {x3:_x3,y3:_y3,...rest}=data;return {...rest,kind:next};
  }
  return {...data,kind:next};
}
