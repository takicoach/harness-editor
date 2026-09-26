import {forwardRef,useEffect,useLayoutEffect,useImperativeHandle,useMemo,useRef,useState,type PointerEvent as ReactPointerEvent,type RefObject} from 'react';
import type {ClipVisual,SequenceDocument} from '../../core/sequence/model';
import type {RenderedSceneGeometry} from '../../preview/native/renderGeometry';
import {previewVideoCorners,resizePreviewVideo,type PreviewCorner,type PreviewPlacement,type PreviewPoint,type PreviewRect,type PreviewVideoGeometry} from './previewManipulation';
import {previewKeysActive,previewPlacementInRange,previewPlacementVisual} from './previewGesture';
import {textGeometryIssue} from '../../preview/native/textGeometry';
import {titleGeometryIssue} from '../../preview/native/titleGeometry';
import {isEndpointShape,moveShapeHandle,shapeHandlePoints,shapeHandleViewport,type ShapeHandleId} from './shapeHandles';
import type {ShapeData} from './shapeDraft';
import {sampleVisualTransform} from '../../core/sequence/visualTransform';
import {applyGroupMove,applyGroupScale,type GroupMember} from './multiSelectDrag';
import {snapPlacement,PREVIEW_SNAP_LINES,type PlacementSnap} from './previewSnapGuides';
import {MAX_SEQUENCE_COMMAND_LEAVES} from '../../core/sequence/commandTypes';

/** 配置の確定。複数選択のまとめドラッグも 1 コマンド・1 Undo で書くため、常に変更の配列で渡す。 */
export interface PreviewPlacementCommit {documentId:string;revision:number;frame:number;changes:Array<{clipId:string;visual:ClipVisual}>}
/** 端点ハンドルの確定。配置（visual）ではなく図形そのもの（content.data）を書き換える。 */
export interface PreviewShapeCommit {documentId:string;revision:number;clipId:string;data:ShapeData}
export interface NativeManipulationHandle {flush():Promise<boolean>;restore():Promise<boolean>;cancel(reason?:string):void}
export interface NativeManipulationBindings {
  selected:string[];disabled:boolean;externalBusy:boolean;
  /** 吸着の可否。タイムラインのスナップ（S）と同じ規則に揃える（OSS `PreviewOverlay.tsx:362`・監査 interaction-7）。
   * 未配線（undefined）は従来どおり吸着あり。ドラッグ中に Alt を押している間はどちらでも吸着しない。 */
  snapEnabled?:boolean;
  readDocument():SequenceDocument|null;
  prepare():Promise<boolean>;
  commit(change:PreviewPlacementCommit):Promise<boolean>;
  /** 図形の端点確定。visual ではなく content.data を 1 コマンドで書き換える。 */
  commitShape(change:PreviewShapeCommit):Promise<boolean>;
  onBusy(value:boolean):void;
}
interface Props extends NativeManipulationBindings {
  document:SequenceDocument;frame:number;geometry:RenderedSceneGeometry|null;
  /** 合成面そのもの（縮尺は transform で掛かる要素）。px 指定で丸められた外枠を渡すと換算がずれる。 */
  stage:RefObject<HTMLDivElement>;pause():void;
  render(document:SequenceDocument|null,temporary:boolean):Promise<RenderedSceneGeometry|undefined>;
}
interface Gesture {
  phase:'preparing'|'dragging'|'committing'|'restoring';pointerId:number;clipId:string;frame:number;
  start:PreviewPoint;last:PreviewPoint;corner?:PreviewCorner;
  document?:SequenceDocument;geometry?:PreviewVideoGeometry;placement?:PreviewPlacement;candidate?:PreviewPlacement;
  viewport?:PreviewRect;
  /** まとめドラッグ。corners は合成面ローカル原点で持つ（multiSelectDrag の契約）。 */
  members?:GroupMember[];placements?:Map<string,PreviewPlacement>;
  /** 開始時の選択そのまま。途中で選択が変わったら取り消す判定に使う。 */
  selection?:string[];
  /** 直接操作できず、このドラッグから外した件数。 */
  excluded?:number;
  /** 直近の吸着結果（ガイド線の強調用）。 */
  snap?:PlacementSnap;
  /** ポインタが開始位置から実際に動いたか。begin は move(active,active.last) を呼ぶため、
   * これが立つまでは吸着を評価しない（クリックだけで配置が吸着線へ書き換わるのを防ぐ）。 */
  moved?:boolean;
  /** 端点ジェスチャー。掴んだ点・開始時の図形・配置を畳んだ実効ビューポート・途中の候補。 */
  handle?:ShapeHandleId;shape?:ShapeData;shapeViewport?:PreviewRect;shapeCandidate?:ShapeData;
  /** 掴んだ位置と端点そのものの差。ヒット領域の端をクリックしても端点をカーソルへ吸い付かせない。 */
  grabOffset?:PreviewPoint;
}
const point=(event:{clientX:number;clientY:number})=>({x:event.clientX,y:event.clientY});
const rect=(stage:HTMLElement):PreviewRect=>{const value=stage.getBoundingClientRect();return {x:value.left,y:value.top,width:value.width,height:value.height};};
const sameRect=(a:PreviewRect,b:PreviewRect)=>a.x===b.x&&a.y===b.y&&a.width===b.width&&a.height===b.height;

// Keep corner handles on the measured content. Small content gets a separate
// move grip, outside both its border and the four unchanged 12px hit targets.
function smallMoveGrip(points:Record<PreviewCorner,PreviewPoint>,viewport:PreviewRect):PreviewPoint|null {
  const corners=[points.nw,points.ne,points.se,points.sw];
  if(Math.min(Math.hypot(points.ne.x-points.nw.x,points.ne.y-points.nw.y),Math.hypot(points.sw.x-points.nw.x,points.sw.y-points.nw.y))>=32)return null;
  // Both rectangles have stroke-width=2. Include the painted 1px outside their
  // layout boxes when keeping the grip inside the viewport and away from hits.
  const radius=11,cornerRadius=7,gap=2;
  if(viewport.width<radius*2||viewport.height<radius*2)return null;
  const xs=corners.map(p=>p.x),ys=corners.map(p=>p.y),left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  const center={x:(left+right)/2,y:(top+bottom)/2};
  const clamp=(value:number,size:number)=>Math.max(radius,Math.min(size-radius,value));
  const candidates=[{x:center.x,y:top-22},{x:center.x,y:bottom+22},{x:left-22,y:center.y},{x:right+22,y:center.y},
    {x:radius,y:radius},{x:viewport.width-radius,y:radius},{x:radius,y:viewport.height-radius},{x:viewport.width-radius,y:viewport.height-radius}]
    .map(p=>({x:clamp(p.x,viewport.width),y:clamp(p.y,viewport.height)}))
    .sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y));
  const axes=[{x:1,y:0},{x:0,y:1},...corners.map((p,i)=>{const next=corners[(i+1)%4]!,dx=next.x-p.x,dy=next.y-p.y,length=Math.hypot(dx,dy);return {x:-dy/length,y:dx/length};})];
  return candidates.find(p=>{
    if(corners.some(c=>Math.abs(p.x-c.x)<=radius+cornerRadius+gap&&Math.abs(p.y-c.y)<=radius+cornerRadius+gap))return false;
    // Separating axes of the real rotated rectangle and the axis-aligned grip.
    // AABB-only exclusion would reject safe grips near long diagonal content.
    return axes.some(axis=>{
      const projected=corners.map(c=>c.x*axis.x+c.y*axis.y),value=p.x*axis.x+p.y*axis.y,extent=radius*(Math.abs(axis.x)+Math.abs(axis.y));
      return value+extent+gap<Math.min(...projected)||value-extent-gap>Math.max(...projected);
    });
  })??null;
}

export const NativePreviewManipulation=forwardRef<NativeManipulationHandle,Props>(function NativePreviewManipulation(props,ref){
  const latest=useRef(props);latest.current=props;
  const gesture=useRef<Gesture|null>(null),pending=useRef<Promise<boolean>>(Promise.resolve(true));
  const pixels=useRef<Promise<boolean>>(Promise.resolve(true));
  const failedRestore=useRef<Gesture|null>(null),drawVersion=useRef(0);
  // Alt を押している間だけ吸着を切る（精密配置の逃げ道）。押しっぱなしのまま画面を離れた時は解除する。
  const altHeld=useRef(false);
  const [phase,setPhase]=useState<Gesture['phase']|null>(null),[notice,setNotice]=useState('');
  // ハンドルを指に追随させるための下書き。document へは入れず、確定時に 1 コマンドで書く。
  const [draftShape,setDraftShape]=useState<ShapeData|null>(null);
  // ガイド線の強調はドラッグ中だけ。gesture.current は ref なので再描画を起こさない値を state へ写す。
  const [snap,setSnap]=useState<PlacementSnap|null>(null);
  const [viewport,setViewport]=useState<PreviewRect|null>(null),measured=useRef<PreviewRect|null>(null);
  const redraw=(document:SequenceDocument|null,temporary=true)=>{
    const active=gesture.current,request=++drawVersion.current;
    void latest.current.render(document,temporary).catch(error=>{if(gesture.current===active&&request===drawVersion.current)setNotice(error instanceof Error?error.message:'プレビューを更新できませんでした。');});
  };
  const register=(result:Promise<boolean>)=>{
    pending.current=result;
    void result.then(()=>{if(pending.current===result)pending.current=Promise.resolve(true);});
    return result;
  };
  const restore=async(active:Gesture,reason:string)=>{
    active.phase='restoring';gesture.current=active;drawVersion.current++;
    setPhase('restoring');setNotice('確定済みの配置を復元しています…');latest.current.onBusy(true);
    try{
      // The renderer resolves canonical requests only after the latest actual
      // draw, including a seek/revision draw that supersedes this request.
      await latest.current.render(null,true);
      if(gesture.current!==active)return false;
      failedRestore.current=null;setNotice(reason);return true;
    }catch(error){
      if(gesture.current===active){failedRestore.current=active;setNotice(error instanceof Error?error.message:'確定済みの配置を復元できませんでした。');}
      return false;
    }finally{
      if(gesture.current===active){gesture.current=null;setPhase(null);setDraftShape(null);setSnap(null);latest.current.onBusy(false);}
    }
  };
  const cancel=(reason='操作を取り消しました。')=>{
    const active=gesture.current;
    if(!active||active.phase==='committing'||active.phase==='restoring')return;
    pixels.current=restore(active,reason);
  };
  const flush=async()=>{
    // Saving data must not depend on fonts, image decoding or drawing health.
    // Cancellation starts restoration, while submitted commands still settle.
    cancel(gesture.current?.handle?'端点の移動を取り消し、確定済みの図形へ戻しました。':'移動・拡縮を取り消し、確定済みの配置へ戻しました。');
    return pending.current;
  };
  const restorePixels=async()=>{
    if(!gesture.current&&failedRestore.current)pixels.current=restore(failedRestore.current,'確定済みの配置へ戻しました。');
    await flush();
    return pixels.current;
  };
  useImperativeHandle(ref,()=>({flush,restore:restorePixels,cancel}));
  const measure=()=>{
    const stage=latest.current.stage.current;if(!stage)return;
    const next=rect(stage),active=gesture.current;
    if(active?.viewport&&!sameRect(next,active.viewport))cancel('表示サイズが変わったため、操作を取り消しました。');
    if(!measured.current||!sameRect(next,measured.current)){measured.current=next;setViewport(next);}
  };
  const measureRef=useRef(measure);measureRef.current=measure;
  // Measure after parent styles reach the DOM, never during render. ResizeObserver
  // also covers banner/panel changes without a React render of this component.
  useLayoutEffect(()=>measureRef.current());
  useLayoutEffect(()=>{
    const update=()=>measureRef.current(),observer=new ResizeObserver(update),stage=props.stage.current;
    // 合成面自身の寸法は解像度で固定され縮尺変更では変わらないため、寸法を持つ外枠も観測する。
    if(stage){observer.observe(stage);if(stage.parentElement)observer.observe(stage.parentElement);}
    window.addEventListener('resize',update);window.addEventListener('scroll',update,true);
    return()=>{observer.disconnect();window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);};
  },[props.stage,viewport!==null]);
  const valid=(active:Gesture)=>{
    const current=latest.current,document=current.readDocument();
    // 箱ドラッグは開始時の選択集合そのままを要求する（除外した要素も選択には残るので件数比較では足りない）。
    // 端点ジェスチャーは選択集合を持たないので、従来どおり 1 件選択の一致で判定する。
    const same=active.selection
      ?active.selection.length===current.selected.length&&active.selection.every((id,index)=>current.selected[index]===id)
      :current.selected.length===1&&current.selected[0]===active.clipId;
    return document?.id===active.document?.id&&document?.revision===active.document?.revision&&same&&current.frame===active.frame&&!current.externalBusy;
  };
  const moveHandle=(active:Gesture,at:PreviewPoint)=>{
    active.last=at;
    if(active.phase!=='dragging'||!active.handle||!active.shape||!active.shapeViewport)return;
    if(!valid(active)||!latest.current.stage.current||!sameRect(rect(latest.current.stage.current),active.viewport!)){cancel('表示や編集内容が変わったため、操作を取り消しました。');return;}
    // 掴んだ点だけを、開始時の図形から作り直す（積み上げないので往復しても歪まない）。
    // grabOffset を加えるので、ヒット領域の端をつまんでも端点がカーソルへスナップしない。
    const offset=active.grabOffset??{x:0,y:0};
    const candidate=moveShapeHandle(active.shape,active.handle,{x:at.x+offset.x,y:at.y+offset.y},active.shapeViewport,active.document!.resolution);
    setNotice('');
    active.shapeCandidate=candidate;setDraftShape(candidate);
    const document=structuredClone(active.document!),clip=document.clips.find(item=>item.id===active.clipId)!;
    if(clip.content.kind!=='shape')return;
    clip.content.data=candidate;redraw(document);
  };
  const move=(active:Gesture,at:PreviewPoint)=>{
    if(active.handle){moveHandle(active,at);return;}
    active.last=at;
    if(active.phase!=='dragging')return;
    if(!valid(active)||!latest.current.stage.current||!sameRect(rect(latest.current.stage.current),active.viewport!)){cancel('表示や編集内容が変わったため、操作を取り消しました。');return;}
    const limit='これ以上は拡縮・移動できません。操作範囲内へ戻してください。';
    // corners と同じ原点（合成面ローカル）で渡す。viewport.x/y を混ぜると外接矩形の中心がずれる。
    const members=active.members!,local={...active.viewport!,x:0,y:0};
    let placements:Map<string,PreviewPlacement>;
    if(active.corner){
      const single=resizePreviewVideo(active.geometry!,active.placement!,active.corner,active.start,at);
      if(!single){setNotice(limit);return;}
      // 1 件は従来どおり「掴んだ四隅の対角を固定」。複数件は外接矩形の中心を基準に同じ倍率（設計 G）。
      placements=members.length===1?new Map([[active.clipId,single]]):applyGroupScale(members,local,single.scale/active.placement!.scale);
      active.snap=undefined;
    }else{
      const moved=applyGroupMove(members,local,{x:at.x-active.start.x,y:at.y-active.start.y});
      // begin は move(active,active.last) を無条件で呼ぶ（at===start）。実移動が一度もないうちは
      // 吸着を評価しない。線から許容内だが線ちょうどではない配置が、クリックだけで吸い付いてしまう事故を防ぐ。
      active.moved=active.moved||at.x!==active.start.x||at.y!==active.start.y;
      if(!active.moved||latest.current.snapEnabled===false||altHeld.current){placements=moved;active.snap=undefined;}
      else{
        // 吸着は「基準の 1 件」の位置で判定し、その補正量を全員へ同じだけ足す（相対位置を崩さない）。
        const primary=moved.get(active.clipId)!,value=snapPlacement(primary.x,primary.y);
        const shift={x:value.x-primary.x,y:value.y-primary.y};
        placements=shift.x===0&&shift.y===0?moved
          :new Map([...moved].map(([id,item])=>[id,{...item,x:item.x+shift.x,y:item.y+shift.y}]));
        active.snap=value;
      }
    }
    if(!placements.size){setNotice(limit);return;}
    const document=structuredClone(active.document!);
    for(const [id,value] of placements){
      const clip=document.clips.find(item=>item.id===id)!;
      if(!previewPlacementInRange(value,clip)){setNotice(limit);return;}
      clip.visual=previewPlacementVisual(clip,active.frame,value);
    }
    setNotice(excludedNotice(active.excluded));setSnap(active.snap??null);
    active.candidate=placements.get(active.clipId)!;active.placements=placements;redraw(document);
  };
  const begin=async(event:ReactPointerEvent<SVGElement>,corner?:PreviewCorner)=>{
    if(event.button!==0||latest.current.disabled||gesture.current)return;
    // Overlapping 12px corner targets must not let SVG paint order choose the
    // opposite corner of tiny content. Resolve against the real pointer point.
    if(corner&&points&&viewport){
      const at={x:event.clientX-viewport.x,y:event.clientY-viewport.y};
      corner=([corner,...(['nw','ne','se','sw'] as const).filter(value=>value!==corner)])
        .sort((a,b)=>Math.hypot(points[a].x-at.x,points[a].y-at.y)-Math.hypot(points[b].x-at.x,points[b].y-at.y))[0]!;
    }
    event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);
    const clipId=latest.current.selected[0];if(!clipId)return;
    const active:Gesture={phase:'preparing',pointerId:event.pointerId,clipId,frame:latest.current.frame,start:point(event),last:point(event),corner,
      viewport:latest.current.stage.current?rect(latest.current.stage.current):undefined};
    gesture.current=active;failedRestore.current=null;pixels.current=Promise.resolve(true);drawVersion.current++;setPhase('preparing');setNotice('');setSnap(null);latest.current.onBusy(true);latest.current.pause();
    try{
      const prepared=await latest.current.prepare();
      if(gesture.current!==active||active.phase!=='preparing')return;
      if(!prepared){cancel('入力を確定できなかったため、操作を開始しませんでした。');return;}
      const current=latest.current,document=current.readDocument();
      if(!document||current.selected[0]!==clipId||current.frame!==active.frame||current.externalBusy){cancel('表示や編集内容が変わったため、操作を開始しませんでした。');return;}
      active.document=structuredClone(document);
      const geometry=await current.render(document,false);
      if(gesture.current!==active||active.phase!=='preparing')return;
      const stage=latest.current.stage.current,selection=[...latest.current.selected];
      if(!stage||geometry?.revision!==document.revision||geometry.frame!==active.frame)throw new Error('プレビューの更新後に、もう一度操作してください。');
      // 直接操作できない要素は「拒否」ではなく「除外」。動かせる要素が 1 つでもあれば始める。
      const {ids,excluded}=manipulableSelection(document,active.frame,selection,geometry);
      // 端点図形は実測の外接箱（geometry.elements）を持たないので、箱ドラッグからも外す。
      const boxIds=ids.filter(id=>renderedItem(document,geometry,id));
      if(!boxIds.length)throw new Error(restriction(document,active.frame,selection,geometry)||'プレビューの更新後に、もう一度操作してください。');
      active.viewport=rect(stage);active.selection=selection;active.excluded=excluded+(ids.length-boxIds.length);
      const local={...active.viewport,x:0,y:0};
      active.members=boxIds.map(id=>{
        const item=renderedItem(document,geometry,id)!;
        return {clipId:id,placement:{...item.transform},
          corners:previewVideoCorners({resolution:geometry.resolution,viewport:local,source:item.source,fittedSize:item.fittedSize,localBounds:item.localBounds},item.transform)};
      });
      const primary=active.members[0]!,video=renderedItem(document,geometry,primary.clipId)!;
      if(!valid(active))throw new Error('プレビューの更新後に、もう一度操作してください。');
      active.geometry={resolution:geometry.resolution,viewport:active.viewport,source:video.source,fittedSize:video.fittedSize,localBounds:video.localBounds};
      active.placement={...primary.placement};active.candidate=active.placement;active.clipId=primary.clipId;
      // Check key clock admission before displaying any provisional change.
      for(const member of active.members)previewPlacementVisual(document.clips.find(item=>item.id===member.clipId)!,active.frame,member.placement);
      active.phase='dragging';setPhase('dragging');
      if(active.excluded>0)setNotice(excludedNotice(active.excluded));
      move(active,active.last);
    }catch(error){if(gesture.current===active)cancel(error instanceof Error?error.message:'操作を開始できませんでした。');}
  };
  const beginHandle=async(event:ReactPointerEvent<SVGElement>,handle:ShapeHandleId)=>{
    if(event.button!==0||latest.current.disabled||gesture.current)return;
    // 重なった端点で SVG の描画順に選ばせない。実際のポインタ位置で決める（四隅と同じ規約）。
    if(viewport&&handleIds.length>1){
      const at={x:event.clientX-viewport.x,y:event.clientY-viewport.y};
      handle=[handle,...handleIds.filter(id=>id!==handle)]
        .sort((a,b)=>Math.hypot(handles[a]!.x-at.x,handles[a]!.y-at.y)-Math.hypot(handles[b]!.x-at.x,handles[b]!.y-at.y))[0]!;
    }
    event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);
    const clipId=latest.current.selected[0];if(!clipId)return;
    const active:Gesture={phase:'preparing',pointerId:event.pointerId,clipId,frame:latest.current.frame,start:point(event),last:point(event),handle,
      viewport:latest.current.stage.current?rect(latest.current.stage.current):undefined};
    gesture.current=active;failedRestore.current=null;pixels.current=Promise.resolve(true);drawVersion.current++;setPhase('preparing');setNotice('');setDraftShape(null);latest.current.onBusy(true);latest.current.pause();
    try{
      const prepared=await latest.current.prepare();
      if(gesture.current!==active||active.phase!=='preparing')return;
      if(!prepared){cancel('入力を確定できなかったため、操作を開始しませんでした。');return;}
      const current=latest.current,document=current.readDocument();
      if(!document||current.selected.length!==1||current.selected[0]!==clipId||current.frame!==active.frame||current.externalBusy){cancel('表示や編集内容が変わったため、操作を開始しませんでした。');return;}
      active.document=structuredClone(document);
      const clip=active.document.clips.find(item=>item.id===clipId);
      if(clip?.content.kind!=='shape')throw new Error('図形を選び直してください。');
      const reason=restriction(active.document,active.frame,[clipId],latest.current.geometry);if(reason)throw new Error(reason);
      const stage=latest.current.stage.current;if(!stage)throw new Error('プレビューの更新後に、もう一度操作してください。');
      active.viewport=rect(stage);
      // 端点は実測の外接箱を使わない。正規化座標をレイヤー配置ごと client 座標へ写す。
      const shapeViewport=shapeHandleViewport(active.viewport,sampleVisualTransform(clip,active.frame));
      if(!shapeViewport)throw new Error('回転・反転を設定した図形の端点は、プロパティで調整してください。');
      active.shapeViewport=shapeViewport;active.shape=structuredClone(clip.content.data);
      // 実際に掴んだ点と端点そのものの差を保持する。クリック（移動なし）では
      // 候補＝元の値に戻るので、moveHandle の JSON 比較が cancel('') に落ちる。
      const grabbed=shapeHandlePoints(active.shape,shapeViewport)[handle];
      active.grabOffset=grabbed?{x:grabbed.x-active.start.x,y:grabbed.y-active.start.y}:{x:0,y:0};
      active.phase='dragging';setPhase('dragging');moveHandle(active,active.last);
    }catch(error){if(gesture.current===active)cancel(error instanceof Error?error.message:'操作を開始できませんでした。');}
  };
  const unchanged=(a:ShapeData,b:ShapeData)=>(['x1','y1','x2','y2','x3','y3'] as const).every(k=>Math.abs((a[k]??0)-(b[k]??0))<1e-9);
  const finish=(event:PointerEvent)=>{
    const active=gesture.current;if(!active||event.pointerId!==active.pointerId)return;
    if(active.phase==='preparing'){cancel('ボタンを離したため、操作を開始しませんでした。');return;}
    if(active.phase!=='dragging')return;
    if(active.handle){
      moveHandle(active,point(event));if(gesture.current!==active||active.phase!=='dragging')return;
      const value=active.shapeCandidate;
      // 退化で据え置かれた（値が変わらない）場合は保存せず取り消す。
      if(!value||unchanged(value,active.shape!)){cancel('');return;}
      active.phase='committing';setPhase('committing');
      register((async()=>{
        let ok=false,reason='';
        try{
          if(!valid(active))throw new Error('別の編集が入ったため、図形を保存できませんでした。');
          ok=await latest.current.commitShape({documentId:active.document!.id,revision:active.document!.revision,clipId:active.clipId,data:value});
          reason=ok?'':'図形を保存できませんでした。確定済みの形へ戻しました。';
        }catch(error){reason=error instanceof Error?error.message:'図形を保存できませんでした。';}
        if(gesture.current!==active)return false;
        pixels.current=restore(active,reason);return ok;
      })());
      return;
    }
    move(active,point(event));if(gesture.current!==active||active.phase!=='dragging')return;
    const placements=active.placements,initial=(id:string)=>active.members!.find(member=>member.clipId===id)!.placement;
    // 全員が開始時と同じなら保存しない（クリックだけ・吸着で戻った場合も含む）。
    if(!placements?.size||[...placements].every(([id,value])=>{const before=initial(id);return value.x===before.x&&value.y===before.y&&value.scale===before.scale;})){cancel('');return;}
    active.phase='committing';setPhase('committing');
    const work=async()=>{
      let ok=false,reason='';
      try{
        if(!valid(active))throw new Error('別の編集が入ったため、配置を保存できませんでした。');
        const document=active.document!;
        // 複数件でも 1 コマンド・1 Undo。要素ごとに execute すると取り消しが件数ぶん要る。
        ok=await latest.current.commit({documentId:document.id,revision:document.revision,frame:active.frame,
          changes:[...placements].map(([clipId,value])=>{const clip=document.clips.find(item=>item.id===clipId)!;return {clipId,visual:previewPlacementVisual(clip,active.frame,value)};})});
        reason=ok?'': '配置を保存できませんでした。確定済みの配置へ戻しました。';
      }catch(error){reason=error instanceof Error?error.message:'配置を保存できませんでした。';}
      if(gesture.current!==active)return false;
      pixels.current=restore(active,reason);
      return ok;
    };
    register(work());
  };
  const handlers=useRef({move,finish,cancel});handlers.current={move,finish,cancel};
  useEffect(()=>{
    const onMove=(event:PointerEvent)=>{const active=gesture.current;if(active&&event.pointerId===active.pointerId)handlers.current.move(active,point(event));};
    const onUp=(event:PointerEvent)=>handlers.current.finish(event);
    const onCancel=(event:PointerEvent)=>{if(event.pointerId===gesture.current?.pointerId)handlers.current.cancel();};
    const onBlur=()=>handlers.current.cancel('画面から離れたため、操作を取り消しました。');
    const onKey=(event:KeyboardEvent)=>{
      if(event.key==='Alt')altHeld.current=true;
      if(event.key==='Escape'&&gesture.current&&(gesture.current.phase==='preparing'||gesture.current.phase==='dragging')){event.preventDefault();event.stopImmediatePropagation();handlers.current.cancel();}
    };
    const onKeyUp=(event:KeyboardEvent)=>{if(event.key==='Alt')altHeld.current=false;};
    const onWindowBlur=()=>{altHeld.current=false;onBlur();};
    window.addEventListener('pointermove',onMove);window.addEventListener('pointerup',onUp);window.addEventListener('pointercancel',onCancel);window.addEventListener('keydown',onKey,true);window.addEventListener('keyup',onKeyUp,true);window.addEventListener('blur',onWindowBlur);
    return()=>{window.removeEventListener('pointermove',onMove);window.removeEventListener('pointerup',onUp);window.removeEventListener('pointercancel',onCancel);window.removeEventListener('keydown',onKey,true);window.removeEventListener('keyup',onKeyUp,true);window.removeEventListener('blur',onWindowBlur);gesture.current=null;};
  },[]);
  useEffect(()=>{const active=gesture.current;if(active&&active.phase==='dragging'&&!valid(active))cancel('表示や編集内容が変わったため、操作を取り消しました。');},[props.document,props.frame,props.selected,props.externalBusy]);
  const reason=useMemo(()=>restriction(props.document,props.frame,props.selected,props.geometry),[props.document,props.frame,props.selected,props.geometry]);
  // 箱はジェスチャーの基準になる 1 件目（除外されない・実測の外接箱を持つ最初の要素）へ出す。
  // 1 件選択では従来どおり selected[0]。除外した先頭に箱を出すと掴んだ箱と動く要素が食い違う。
  const manipulable=useMemo(()=>manipulableSelection(props.document,props.frame,props.selected,props.geometry),[props.document,props.frame,props.selected,props.geometry]);
  const primaryId=manipulable.ids.find(id=>renderedItem(props.document,props.geometry,id))??props.selected[0];
  const video=renderedItem(props.document,props.geometry,primaryId);
  const points=!reason&&video&&viewport&&viewport.width>0&&viewport.height>0?previewVideoCorners({resolution:props.geometry!.resolution,viewport:{...viewport,x:0,y:0},source:video.source,fittedSize:video.fittedSize,localBounds:video.localBounds},video.transform):null;
  const selected=props.document.clips.find(item=>item.id===primaryId),keyActive=selected?previewKeysActive(selected,props.frame):false;
  const label=contentLabel(selected?.content.kind);
  const grip=points&&viewport?smallMoveGrip(points,viewport):null;
  const shapeContent=selected?.content.kind==='shape'?selected.content:null;
  const shapeData=shapeContent?(draftShape??shapeContent.data):null;
  // 端点は実測の外接箱を持たない。レイヤー配置を畳んだ実効ビューポートへ正規化座標を写す。
  // 端点ハンドルは 1 件選択のときだけ。複数選択のまとめドラッグは箱（移動・四隅拡縮）のみ。
  const handleViewport=!reason&&props.selected.length===1&&shapeData&&isEndpointShape(shapeData.kind)&&viewport&&viewport.width>0&&viewport.height>0
    ?shapeHandleViewport({...viewport,x:0,y:0},sampleVisualTransform(selected!,props.frame)):null;
  const handles=handleViewport&&shapeData?shapeHandlePoints(shapeData,handleViewport):{};
  const handleIds=Object.keys(handles) as ShapeHandleId[];
  const handleLabel:Record<ShapeHandleId,string>=shapeData?.kind==='angle'
    ?{p1:'角の頂点',p2:'角の一辺の先',p3:'角のもう一辺の先'}
    :shapeData?.kind==='arrow'?{p1:'矢印の根元',p2:'矢印の先端',p3:''}
    :{p1:'線の始点',p2:'線の終点',p3:''};
  // M4/M5: 選択に端点図形（線・矢印・角）だけ、または端点図形が混ざって箱を出せる要素が
  // 1つも無いとき（=複数選択で端点ハンドルも出さない）、掴める操作枠が無いのに
  // 「ドラッグで移動・四隅で拡縮」と案内してしまう。
  // T20 Minor: points はビューポート未測定（幅 0）でも null になる。測れていないだけの状態で
  // 「端点で動かす図形は1つだけ選ぶと操作できます。」と案内すると誤情報になるので、
  // 実測済みのときだけ ungrabbable と判定する。
  const measuredViewport=!!viewport&&viewport.width>0&&viewport.height>0;
  const ungrabbable=props.selected.length>0&&handleIds.length===0&&!points&&!reason&&measuredViewport;
  return <>
    {handleIds.length>0&&viewport&&<svg data-native-manipulation={phase??'idle'} className="native-manipulation" width={viewport.width} height={viewport.height} aria-label="図形の端点操作">
      {shapeData?.kind==='angle'&&<path className="native-shape-guide" d={`M ${handles.p2!.x} ${handles.p2!.y} L ${handles.p1!.x} ${handles.p1!.y} L ${handles.p3!.x} ${handles.p3!.y}`} aria-hidden="true"/>}
      {handleIds.map(id=><rect key={id} className="native-shape-handle" role="button" tabIndex={0} aria-label={handleLabel[id]} aria-disabled={props.disabled}
        x={handles[id]!.x-7} y={handles[id]!.y-7} width={14} height={14} rx={7} onPointerDown={event=>void beginHandle(event,id)}/>)}
    </svg>}
    {points&&viewport&&handleIds.length===0&&<svg data-native-manipulation={phase??'idle'} className="native-manipulation" width={viewport.width} height={viewport.height} aria-label={`${label}の配置操作`}>
      {phase==='dragging'&&snap&&PREVIEW_SNAP_LINES.map(line=><g key={line} aria-hidden="true">
        <line data-native-snap-guide="x" className={`native-preview-guide${snap.guideX===line?' is-hit':''}`} x1={(1+line)*viewport.width/2} y1={0} x2={(1+line)*viewport.width/2} y2={viewport.height}/>
        <line data-native-snap-guide="y" className={`native-preview-guide${snap.guideY===line?' is-hit':''}`} x1={0} y1={(1+line)*viewport.height/2} x2={viewport.width} y2={(1+line)*viewport.height/2}/>
      </g>)}
      <polygon points={(['nw','ne','se','sw'] as const).map(corner=>`${points[corner].x},${points[corner].y}`).join(' ')} role={grip?undefined:'button'} tabIndex={grip?undefined:0} aria-label={grip?undefined:`選択した${label}を移動`} aria-disabled={props.disabled} onPointerDown={event=>void begin(event)}/>
      {(['nw','ne','se','sw'] as const).map(corner=><rect key={corner} role="button" tabIndex={0} aria-label={`${label}の${{nw:'左上',ne:'右上',se:'右下',sw:'左下'}[corner]}を拡縮`} aria-disabled={props.disabled} x={points[corner].x-6} y={points[corner].y-6} width={12} height={12} onPointerDown={event=>void begin(event,corner)}/>)}
      {grip&&<>
        <path className="native-move-guide" d={`M ${(points.nw.x+points.se.x)/2} ${(points.nw.y+points.se.y)/2} L ${grip.x} ${grip.y}`} aria-hidden="true"/>
        <rect className="native-move-grip" data-native-move-grip="" role="button" tabIndex={0} aria-label={`選択した${label}を移動`} aria-disabled={props.disabled} x={grip.x-10} y={grip.y-10} width={20} height={20} rx={4} onPointerDown={event=>void begin(event)}/>
        <path className="native-move-symbol" d={`M ${grip.x-6} ${grip.y} h 12 m -3 -3 l 3 3 -3 3 M ${grip.x-3} ${grip.y-3} l -3 3 3 3 M ${grip.x} ${grip.y-6} v 12 m -3 -3 l 3 3 3 -3 M ${grip.x-3} ${grip.y-3} l 3 -3 3 3`} aria-hidden="true"/>
      </>}
    </svg>}
    {(props.selected.length>0||notice)&&<div className="native-manipulation-note" role={notice?'status':undefined}>{notice||reason||(phase==='preparing'?'入力の確定を待っています…':phase==='committing'?(handleIds.length>0?'図形を保存しています…':'配置を保存しています…'):handleIds.length>0?'端点をドラッグして形を変えます。離すと確定、Esc・保存・画面切替で取消。レイヤー全体の移動はプロパティで調整します。'
      :ungrabbable?'端点で動かす図形は1つだけ選ぶと操作できます。'
      :manipulable.ids.length>1?`${manipulable.ids.length}件をまとめて操作 · ドラッグで移動・四隅で拡縮。離すと確定、Esc・保存・画面切替で取消。`
      :`${keyActive?'現在の位置キー':'基本配置'} · ドラッグで移動・四隅で拡縮。離すと確定、Esc・保存・画面切替で取消。`)}</div>}
  </>;
});

function renderedItem(document:SequenceDocument,geometry:RenderedSceneGeometry|null|undefined,clipId:string|undefined){
  const clip=document.clips.find(item=>item.id===clipId);
  return (clip?.content.kind==='image'?geometry?.images:clip?.content.kind==='video'?geometry?.videos:geometry?.elements)?.find(item=>item.clipId===clipId);
}

const contentLabel=(kind:string|undefined)=>kind==='telop'?'テキスト':kind==='title'?'タイトル':kind==='shape'?'図形':kind==='image'?'画像':'映像';

const excludedNotice=(excluded:number|undefined)=>excluded?`${excluded}件は直接操作できないため、この操作から外しました。プロパティで調整してください。`:'';

/**
 * 選択全体の案内。1 件なら従来どおりその理由、複数なら「1 件でも動かせるなら操作できる」。
 * 動かせない要素は begin で除外して件数を通知する（拒否ではない）。
 */
function restriction(document:SequenceDocument,frame:number,selected:string[],geometry:RenderedSceneGeometry|null):string {
  if(!selected.length)return '';
  // M-6: サーバーは 1 リクエストあたり MAX_SEQUENCE_COMMAND_LEAVES 件までしか受けない。
  // 51 件以上のまとめドラッグは最後に「まとめる編集操作が多すぎます」という文脈外の
  // 文言で落ちるので、掴む前にここで断る（文書は何も変えない）。
  if(selected.length>MAX_SEQUENCE_COMMAND_LEAVES)return `一度に動かせるのは ${MAX_SEQUENCE_COMMAND_LEAVES} 件までです。選ぶ数を減らしてから操作してください。`;
  const reasons=selected.map(id=>clipRestriction(document,frame,id,geometry));
  if(selected.length===1)return reasons[0]!;
  return reasons.every(value=>value!=='')?reasons.find(value=>value!=='')!:'';
}

/** 選択のうち直接操作できる clipId と、除外した件数。 */
export function manipulableSelection(document:SequenceDocument,frame:number,selected:string[],geometry:RenderedSceneGeometry|null):{ids:string[];excluded:number}{
  const ids=selected.filter(id=>clipRestriction(document,frame,id,geometry)==='');
  return {ids,excluded:selected.length-ids.length};
}

function clipRestriction(document:SequenceDocument,frame:number,clipId:string|undefined,geometry:RenderedSceneGeometry|null):string {
  const clip=document.clips.find(item=>item.id===clipId);
  if(!clip||!['video','image','telop','title','shape'].includes(clip.content.kind))return 'この種類の直接操作にはまだ対応していません。プロパティで配置を調整してください。';
  const label=contentLabel(clip.content.kind);
  if(frame<clip.startFrame||frame>=clip.startFrame+clip.durationFrames)return `選択した${label}の表示時間外です。タイムラインで表示時間内へ移動してください。`;
  if(clip.content.kind==='title'){
    const issue=titleGeometryIssue(clip.visual);
    if(issue==='inner-animation')return '内側のアニメーションを使うタイトルは直接操作できません。プロパティで登場・退場を「なし」にすると操作できます。';
    if(issue==='animation')return '登場・退場を設定したタイトルは、プロパティで配置を調整してください。';
  }
  if(clip.content.kind==='telop'){
    const issue=textGeometryIssue(clip.content);
    if(issue==='component')return '部品の字幕は、プロパティで配置を調整してください。直接操作は自由書式に対応しています。';
    if(issue)return '内側の動きを設定したテキストは、プロパティで配置を調整してください。';
    if([clip.visual?.enter,clip.visual?.exit].some(item=>item&&item.kind!=='none'))return '登場・退場を設定したテキストは、プロパティで配置を調整してください。';
  }
  if(clip.content.kind==='shape'){
    const kind=clip.content.data.kind;
    if(!['rect','ellipse','triangle','line','arrow','angle'].includes(kind))
      return '図形の直接操作にはまだ対応していません。プロパティで調整してください。';
    if(isEndpointShape(kind)){
      // 端点は実測の外接箱（geometry.elements）を持たないので、箱操作と別の条件で判定する。
      if([clip.visual?.enter,clip.visual?.exit].some(item=>item&&item.kind!=='none'))
        return `登場・退場を設定した${label}は、プロパティで調整してください。`;
      if(document.transitions.some(item=>(item.outClipId===clip.id||item.inClipId===clip.id)&&item.startFrame<=frame&&frame<item.startFrame+item.durationFrames))
        return `転換中の${label}は直接操作できません。転換の外へ移動してください。`;
      // 鮮度ゲートは箱操作と共通。端点は geometry.elements を引かないが、古い revision/frame の
      // geometry のまま操作を始めてよいことにはならない（他経路と同じ判定を通す）。
      if(!geometry||geometry.documentId!==document.id||geometry.revision!==document.revision||geometry.frame!==frame)return `${label}の更新を待っています…`;
      // 画面外案内（geometry.elements 由来の localBounds）は端点型には意味がない。端点は正規化座標を
      // レイヤー配置ごと畳んだ矩形へ写すだけで、実測の描画位置に依存しないため案内する対象がない。
      if(!shapeHandleViewport({x:0,y:0,width:1,height:1},sampleVisualTransform(clip,frame)))
        return `回転・反転を設定した${label}の端点は、プロパティで調整してください。`;
      return '';
    }
  }
  if(clip.content.kind==='image'){
    if(document.rendering?.imageComponentAssetId)return '持ち込み部品の画像は、プロパティで配置を調整してください。';
    if((clip.content.style??'plain')!=='plain')return '画像の直接操作は、見せ方「そのまま」に対応しています。';
    if(clip.visual?.layout.flipH||clip.visual?.layout.flipV)return '反転を設定した画像は、直接操作に対応していません。';
  }
  if(!geometry||geometry.documentId!==document.id||geometry.revision!==document.revision||geometry.frame!==frame)return `${label}の更新を待っています…`;
  const video=renderedItem(document,geometry,clip.id);
  if(!video)return clip.content.kind==='telop'||clip.content.kind==='title'||clip.content.kind==='shape'?`${label}の操作範囲を取得できません。画面外の場合はプロパティのレイヤー位置で戻せます。`:`選択した${label}が表示される位置へ移動してください。`;
  if(clip.content.kind==='image'&&(video.transform.flipH||video.transform.flipV))return '反転を設定した画像は、直接操作に対応していません。';
  if(video.transition)return `転換中の${label}は直接操作できません。転換の外へ移動してください。`;
  if(video.animated)return `登場・退場を設定した${label}は、プロパティで配置を調整してください。`;
  if(clip.visual?.motion&&!previewKeysActive(clip,frame))return `動きを設定した${label}は、プロパティで配置を調整してください。`;
  return '';
}
