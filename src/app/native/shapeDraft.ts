import {angleDegrees} from '../../core/shapeGeometry';
import type {ShapeKind} from '../../core/types';
import type {ClipContent} from '../../core/sequence/model';

/** 図形クリップの中身（`model.ts` の ElementData<EditorShape>）。model は名前付きで公開していない。 */
export type ShapeData=Extract<ClipContent,{kind:'shape'}>['data'];

/** これ未満のドラッグは「置くだけ」とみなし、既定サイズを使う。 */
export const SHAPE_MIN_SPAN=.01;
/** 従来の図形追加（NativeWorkspace の addElement）と同じ既定サイズ。 */
export const DEFAULT_SHAPE_BOX={x1:.25,y1:.25,x2:.75,y2:.75} as const;
export interface ShapeDraft {kind:ShapeKind;x1:number;y1:number;x2:number;y2:number;x3?:number;y3?:number;stage:'drag'|'vertexB'}

const clamp=(value:number)=>Math.max(0,Math.min(1,value));

/** 画面座標 → 合成面の正規化座標。x は幅、y は高さで割る（合成面は非等方 scale）。 */
export function normalizeStagePoint(client:{x:number;y:number},rect:{left:number;top:number;width:number;height:number}):{x:number;y:number}{
  if(!(rect.width>0)||!(rect.height>0))throw new RangeError('合成面の実測矩形が取得できていません');
  return {x:clamp((client.x-rect.left)/rect.width),y:clamp((client.y-rect.top)/rect.height)};
}

export function beginShapeDraft(kind:ShapeKind,at:{x:number;y:number}):ShapeDraft{
  return {kind,x1:at.x,y1:at.y,x2:at.x,y2:at.y,stage:'drag'};
}

export function updateShapeDraft(draft:ShapeDraft,at:{x:number;y:number}):ShapeDraft{
  return draft.stage==='drag'?{...draft,x2:at.x,y2:at.y}:{...draft,x3:at.x,y3:at.y};
}

const tiny=(draft:ShapeDraft)=>Math.abs(draft.x2-draft.x1)<SHAPE_MIN_SPAN&&Math.abs(draft.y2-draft.y1)<SHAPE_MIN_SPAN;

/** レビュー Minor 2: 分度器の端点 B を確定させない実寸しきい値（px）。頂点・A と一致すると validate が弾くため、その手前で据え置く。 */
const PROTRACTOR_MIN_PX=4;
/** resolution が無ければ正規化座標での厳密一致のみ弾く（従来挙動を保つ）。 */
export const nearlySamePoint=(ax:number,ay:number,bx:number,by:number,resolution?:{width:number;height:number}):boolean=>{
  if(!resolution)return ax===bx&&ay===by;
  return Math.hypot((ax-bx)*resolution.width,(ay-by)*resolution.height)<PROTRACTOR_MIN_PX;
};

/** done=false のときは下書きを続ける（angle の端点 B 待ち）。document へは入れない。 */
export function releaseShapeDraft(draft:ShapeDraft,at:{x:number;y:number},resolution?:{width:number;height:number}):{draft:ShapeDraft;done:boolean}{
  const moved=updateShapeDraft(draft,at);
  if(moved.stage==='drag'&&tiny(moved)){
    const box={...moved,...DEFAULT_SHAPE_BOX,stage:'drag' as const};
    return {draft:moved.kind==='angle'?{...box,x3:DEFAULT_SHAPE_BOX.x2,y3:DEFAULT_SHAPE_BOX.y1}:box,done:true};
  }
  if(moved.kind!=='angle')return {draft:moved,done:true};
  if(moved.stage==='drag'){
    // 既定の端点 B は水平右。長さを頂点→A と揃えて、置いた瞬間から角度が読める形にする。
    const length=Math.hypot(moved.x2-moved.x1,moved.y2-moved.y1);
    return {draft:{...moved,stage:'vertexB',x3:clamp(moved.x1+length),y3:moved.y1},done:false};
  }
  // stage==='vertexB': 端点 B が頂点または A と実質一致していたら（validate が弾く形なので）
  // 確定させず、直前の下書きのまま据え置いて再入力を待つ。
  if(nearlySamePoint(moved.x3!,moved.y3!,moved.x1,moved.y1,resolution)||nearlySamePoint(moved.x3!,moved.y3!,moved.x2,moved.y2,resolution))
    return {draft,done:false};
  return {draft:moved,done:true};
}

export function shapeDraftChip(draft:ShapeDraft,resolution:{width:number;height:number}):string{
  if(draft.kind==='angle'&&draft.x3!==undefined&&draft.y3!==undefined){
    // 角度は正規化座標ではなく実寸 px で計算する（横長・縦長で値が狂わないため・裁定 P1-5）。
    const px=(x:number,y:number)=>({x:x*resolution.width,y:y*resolution.height});
    return `${angleDegrees(px(draft.x1,draft.y1),px(draft.x2,draft.y2),px(draft.x3,draft.y3)).toFixed(1)}°`;
  }
  const w=Math.round(Math.abs(draft.x2-draft.x1)*resolution.width),h=Math.round(Math.abs(draft.y2-draft.y1)*resolution.height);
  if(draft.kind==='line'||draft.kind==='arrow')return `${Math.round(Math.hypot(w,h))} px`;
  return `${w} × ${h} px`;
}

export function shapeDraftData(draft:ShapeDraft,color:string):ShapeData{
  const base={kind:draft.kind,x1:draft.x1,y1:draft.y1,x2:draft.x2,y2:draft.y2,color,thickness:'medium' as const,opacity:1};
  return draft.kind==='angle'?{...base,x3:draft.x3??draft.x1,y3:draft.y3??draft.y1}:base;
}
