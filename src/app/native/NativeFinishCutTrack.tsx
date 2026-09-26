import {forwardRef,useEffect,useImperativeHandle,useLayoutEffect,useRef,useState,type PointerEvent,type RefObject} from 'react';
import {CutTrack,type CutHandleId} from '../timeline/CutTrack';
import type {CutRegion} from '../../core/types';
import {clipEnd,type SequenceDocument} from '../../core/sequence/model';
import {readCutBoundaryGroup,type ResizeCutBoundaryCommand} from '../../core/sequence/cutBoundary';
import {finishDisplayPoint,type FinishDisplayCut,type FinishDisplayMap} from './finishDisplayMap';
import {NATIVE_TIMELINE_GUTTER} from './useNativeTimelineViewport';
import type {RestoreCutCommand} from '../../core/sequence/cutArchive';

export interface NativeFinishCutTrackHandle {flush():Promise<boolean>;restore():Promise<boolean>}
export interface NativeFinishCutTrackProps {
  projectId:string;sessionId?:string;document:SequenceDocument;map:FinishDisplayMap;zoom:number;
  activeCutId:string|null;busy:boolean;mode?:string;scroller:RefObject<HTMLDivElement>;
  /** Explicit occurrence when overlapping, unlinked media make the edge ambiguous. */
  liveOwner?:Partial<Record<'start'|'end',string>>;
  onSelectCut(entryId:string):void;
  onCommand(command:ResizeCutBoundaryCommand|{type:'batch';commands:RestoreCutCommand[]},expected:{documentId:string;revision:number}):Promise<boolean>;
  onRestoreSelection?(selected:boolean):void;
  /** 親の共通端スクロールループが毎フレーム読む。pointer は値ではなく生きた参照を渡す関数。 */
  onDragStateChange?(state:{dragging:boolean;pointer:()=>{x:number;y:number;moved:boolean}|null}):void;
  prepare?():Promise<boolean>;readDocument?():SequenceDocument|null;onWorking?(working:boolean):void;
}
type Props=NativeFinishCutTrackProps;
type Edge='start'|'end';
function restoreSelectionKey(p:Props,cut:FinishDisplayCut|undefined):string{
  return cut?JSON.stringify([cut,cut.entryIds.map(id=>p.document.cutArchive?.entries.find(e=>e.id===id)),p.document.speed,p.document.insertOwnSpeed]):'';
}
interface Drag {index:number;edge:Edge|'range';pointerId:number;capture:HTMLElement;x:number;y:number;initialX:number;initialY:number;initialScroll:number;initialAt:number;at:number;moved:boolean;revision:number;zoom:number;identity:string}

/** Saved local frames come from the same display projection as the red bands.
 * Restore right to left so every earlier band's original seam stays stable. */
export function finishRestoreCommands(map:FinishDisplayMap,start:number,end:number):RestoreCutCommand[]{
  return map.blocks.filter(block=>block.kind==='archived'&&block.displayStart<end&&block.displayEnd>start).reverse().map(block=>{
    if(block.kind!=='archived')throw new Error('保存カットを選択してください');
    return {type:'restore-cut',entryId:block.entryId,range:{startFrame:Math.max(start,block.displayStart)-block.displayStart,endFrame:Math.min(end,block.displayEnd)-block.displayStart}};
  });
}

/** The video row may choose a representative of an explicitly linked AV pair.
 * Unlinked overlaps need an explicit owner; matching source seconds never prove
 * that two media clips are the same occurrence. Core rechecks every command. */
export function finishCutTarget(props:Pick<Props,'document'|'map'|'liveOwner'>,cut:FinishDisplayCut,edge:Edge,at:number):ResizeCutBoundaryCommand['target'] {
  const group=readCutBoundaryGroup(props.document,cut.cut);
  if(group.frame===null)throw new Error(group.reason);
  if(at>=cut.start&&at<=cut.end){
    // Prefer an archived endpoint at both outer edges, enabling full restoration.
    const point=finishDisplayPoint(props.map,at,at===cut.end?'before':'after');
    if(point?.kind==='archived'&&group.entryIds.includes(point.entryId))return point;
    throw new Error('選択したカット帯の範囲ではありません');
  }
  if(edge==='start'?at>cut.start:at<cut.end)throw new Error('反対側の生存区間へは広げられません');
  const point=finishDisplayPoint(props.map,at,edge==='start'?'after':'before');
  if(point?.kind!=='live')throw new Error('別の保存帯をまたいで広げられません');
  const adjacent=props.document.clips.filter(c=>group.adjacentLive[edge].includes(c.id));
  const media=adjacent.filter(c=>c.content.kind==='video'||c.content.kind==='audio');
  const candidates=media.length?media:adjacent;
  const explicit=props.liveOwner?.[edge];
  const selected=explicit?candidates.find(c=>c.id===explicit):candidates.length===1?candidates[0]:
    candidates.length&&candidates[0]!.linkGroupId&&candidates.every(c=>c.linkGroupId===candidates[0]!.linkGroupId&&c.startFrame===candidates[0]!.startFrame&&clipEnd(c)===clipEnd(candidates[0]!))?candidates[0]:undefined;
  if(!selected)throw new Error('境界に接する素材の使用箇所を一つ選択してください');
  if(point.frame<selected.startFrame||point.frame>clipEnd(selected))throw new Error('直接隣接する素材の範囲を越えています');
  return {kind:'live',clipId:selected.id,frame:point.frame};
}

/** Existing CutTrack DOM in one native timeline row, not another screen. No
 * media URL is supplied for this mixed axis: its frame units cannot honestly
 * drive one source video's filmstrip or waveform. NativeArchivedMedia in the
 * parent projects each saved occurrence beneath this interaction layer. */
export const NativeFinishCutTrack=forwardRef<NativeFinishCutTrackHandle,Props>(function NativeFinishCutTrack(props,ref){
  const latest=useRef(props);latest.current=props;
  const identity=`${props.projectId}:${props.sessionId??''}:${props.document.id}:${props.mode??'finish'}`;
  const currentIdentity=useRef(identity);currentIdentity.current=identity;
  const drag=useRef<Drag|null>(null),pending=useRef<Promise<boolean>|null>(null),owner=useRef({}),mounted=useRef(true);
  const [ghost,setGhost]=useState<{index:number;edge:Edge;at:number}|null>(null),[dragging,setDragging]=useState(false),[working,setWorking]=useState(false),[error,setError]=useState('');
  const [selectedEdge,setSelectedEdge]=useState<{id:string;edge:Edge}|null>(null);
  const suppressRegionClick=useRef(false);
  const [selection,setSelection]=useState<{start:number;end:number;revision:number;identity:string;key:string}|null>(null);
  const regions=props.map.cuts.map((c,index)=>({start:ghost?.index===index&&ghost.edge==='start'?ghost.at:c.start,end:ghost?.index===index&&ghost.edge==='end'?ghost.at:c.end}));
  const regionsRef=useRef(regions);regionsRef.current=regions;
  function cancel(keepSelection=false){const d=drag.current;drag.current=null;setGhost(null);setDragging(false);if(d&&!keepSelection)suppressRegionClick.current=true;if(d?.edge==='range'&&!keepSelection)setSelection({start:0,end:0,revision:d.revision,identity:d.identity,key:''});if(d)try{if(d.capture.hasPointerCapture(d.pointerId))d.capture.releasePointerCapture(d.pointerId);}catch{/* retired handle */}}
  function update(){
    const d=drag.current,p=latest.current;if(!d)return;
    if(p.busy||pending.current||d.identity!==currentIdentity.current||d.revision!==p.document.revision||d.zoom!==p.zoom){cancel();return;}
    if(!d.moved)return;
    const cut=p.map.cuts[d.index];if(!cut){cancel();return;}
    const raw=d.initialAt+(d.x-d.initialX+(p.scroller.current?.scrollLeft??0)-d.initialScroll)/p.zoom;
    d.at=Math.round(d.edge==='range'?Math.max(cut.start,Math.min(cut.end,raw)):d.edge==='start'?Math.max(0,Math.min(cut.end,raw)):Math.max(cut.start,Math.min(p.map.displayEnd,raw)));
    if(d.edge==='range'){setSelection({start:Math.min(d.initialAt,d.at),end:Math.max(d.initialAt,d.at),revision:d.revision,identity:d.identity,key:restoreSelectionKey(p,cut)});return;}
    setGhost(d.at===d.initialAt?null:{index:d.index,edge:d.edge,at:d.at});
  }
  function commit(index:number,edge:Edge,at:number):Promise<boolean>{
    const p=latest.current,cut=p.map.cuts[index];
    if(p.busy||pending.current||!cut)return Promise.resolve(false);
    if(at===(edge==='start'?cut.start:cut.end))return Promise.resolve(true);
    const expected={documentId:p.document.id,revision:p.document.revision},token=owner.current;
    // Validate before and after prepare; no stale target survives another input's save.
    let target:ResizeCutBoundaryCommand['target'];
    try{target=finishCutTarget(p,cut,edge,at);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));return Promise.resolve(false);}
    setWorking(true);setError('');p.onWorking?.(true);
    const operation=Promise.resolve().then(async()=>{
      if(p.prepare&&!await p.prepare())return false;
      const current=latest.current,d=current.readDocument?current.readDocument():current.document;
      if(!mounted.current||owner.current!==token||!d||d.id!==expected.documentId||d.revision!==expected.revision)return false;
      // busy can now include our own onWorking flag; the parent command enforces
      // the external lease/busy state and checks expected again after its flush.
      target=finishCutTarget({...p,document:d},cut,edge,at);
      return await p.onCommand({type:'resize-cut-boundary',cut:cut.cut,edge,target},expected);
    }).catch(cause=>{if(mounted.current&&owner.current===token)setError(cause instanceof Error?cause.message:String(cause));return false;})
      .then(ok=>{if(!ok&&mounted.current&&owner.current===token)setError(previous=>previous||'カット境界を変更できませんでした。範囲を確認して再試行してください。');return ok;})
      .finally(()=>{if(pending.current===operation)pending.current=null;if(mounted.current&&owner.current===token){setWorking(false);latest.current.onWorking?.(false);}});
    pending.current=operation;return operation;
  }
  function restore():Promise<boolean>{
    const p=latest.current,cut=p.map.cuts.find(c=>c.entryIds.includes(p.activeCutId??''));
    if(p.busy||pending.current||drag.current||!cut)return Promise.resolve(false);
    const chosen=selection;
    if(!chosen||chosen.revision!==p.document.revision||chosen.identity!==currentIdentity.current||chosen.key!==restoreSelectionKey(p,cut))return Promise.resolve(false);
    const {start,end}=chosen;
    if(end<=start)return Promise.resolve(false);
    const commands=finishRestoreCommands(p.map,start,end),expected={documentId:p.document.id,revision:p.document.revision},token=owner.current;
    if(!commands.length)return Promise.resolve(false);
    setWorking(true);setError('');p.onWorking?.(true);
    const operation=Promise.resolve().then(async()=>{
      if(p.prepare&&!await p.prepare())return false;
      const current=latest.current,d=current.readDocument?current.readDocument():current.document;
      if(!mounted.current||owner.current!==token||current.activeCutId!==p.activeCutId||!d||d.id!==expected.documentId||d.revision!==expected.revision)return false;
      return p.onCommand({type:'batch',commands},expected);
    }).catch(cause=>{if(mounted.current&&owner.current===token)setError(cause instanceof Error?cause.message:String(cause));return false;})
      .then(ok=>{if(mounted.current&&owner.current===token){if(ok)setSelection(null);else setError(previous=>previous||'カットを戻せませんでした。範囲を確認して再試行してください。');}return ok;})
      .finally(()=>{if(pending.current===operation)pending.current=null;if(mounted.current&&owner.current===token){setWorking(false);latest.current.onWorking?.(false);}});
    pending.current=operation;return operation;
  }
  const handlers=useRef({cancel,update,commit,restore});handlers.current={cancel,update,commit,restore};
  useImperativeHandle(ref,()=>({flush:()=>{handlers.current.cancel();return pending.current??Promise.resolve(true);},restore:()=>handlers.current.restore()}),[]);
  useLayoutEffect(()=>{setSelection(null);},[identity]);
  useLayoutEffect(()=>{
    const cut=props.map.cuts.find(c=>c.entryIds.includes(props.activeCutId??'')),key=restoreSelectionKey(props,cut);
    setSelection(previous=>{
      if(!previous)return previous;
      if(previous.identity===identity&&previous.key&&previous.key===key)return previous.revision===props.document.revision?previous:{...previous,revision:props.document.revision};
      // A changed target retires the partial choice. Never reinterpret a failed
      // partial operation as permission to restore the entire currently active band.
      return {...previous,start:0,end:0,revision:props.document.revision,key:''};
    });
  },[identity,props.document.revision,props.activeCutId]);
  useEffect(()=>{props.onRestoreSelection?.(!dragging&&!!selection&&selection.end>selection.start&&selection.identity===identity&&selection.revision===props.document.revision&&selection.key===restoreSelectionKey(props,props.map.cuts.find(c=>c.entryIds.includes(props.activeCutId??''))));return()=>props.onRestoreSelection?.(false);},[props.activeCutId,props.map,props.onRestoreSelection,selection,dragging,identity,props.document.revision]);
  useLayoutEffect(()=>{owner.current={};pending.current=null;setWorking(false);setError('');setSelectedEdge(null);latest.current.onWorking?.(false);},[identity]);
  useLayoutEffect(()=>{cancel();},[identity,props.document.revision,props.zoom,props.busy]);
  useEffect(()=>{
    mounted.current=true;
    const move=(e:globalThis.PointerEvent)=>{const d=drag.current;if(!d||e.pointerId!==d.pointerId)return;d.x=e.clientX;d.y=e.clientY;d.moved||=Math.hypot(d.x-d.initialX,d.y-d.initialY)>=3;handlers.current.update();};
    const up=(e:globalThis.PointerEvent)=>{const d=drag.current;if(!d||e.pointerId!==d.pointerId)return;move(e);if(drag.current!==d)return;suppressRegionClick.current=d.edge==='range'?d.moved:true;handlers.current.cancel(true);if(d.moved&&d.edge!=='range')void handlers.current.commit(d.index,d.edge,d.at);};
    const abort=(e:globalThis.PointerEvent)=>{if(e.pointerId===drag.current?.pointerId)handlers.current.cancel();};
    const blur=()=>handlers.current.cancel(),key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&drag.current){e.preventDefault();e.stopPropagation();handlers.current.cancel();}};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);window.addEventListener('pointercancel',abort);window.addEventListener('blur',blur);window.addEventListener('keydown',key,true);
    const scroller=props.scroller.current,scroll=()=>handlers.current.update();scroller?.addEventListener('scroll',scroll,{passive:true});
    return()=>{mounted.current=false;const d=drag.current;drag.current=null;if(d)try{if(d.capture.hasPointerCapture(d.pointerId))d.capture.releasePointerCapture(d.pointerId);}catch{/* retired */}window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',abort);window.removeEventListener('blur',blur);window.removeEventListener('keydown',key,true);scroller?.removeEventListener('scroll',scroll);};
  },[props.scroller]);
  // 親（useNativeTimelineViewport の共有ループ）は毎フレームこの関数を呼ぶ。開始時点の
  // スナップショットを渡すと moved:false のまま凍り、ドラッグ分岐の速度が常に 0 になる。
  const readPointer=useRef(()=>{const d=drag.current;return d?{x:d.x,y:d.y,moved:!!d.moved}:null;});
  const dragNotify=useRef(props.onDragStateChange);dragNotify.current=props.onDragStateChange;
  const notified=useRef(false);
  useEffect(()=>{
    if(!dragging&&!notified.current)return;   // マウント直後の false は送らない
    notified.current=true;
    dragNotify.current?.({dragging,pointer:readPointer.current});
  },[dragging]);
  // アンマウントでは state 更新が走らない。解除を送らないと親の cutDragging が true で
  // 固定され、仕上げモードを抜けた後のホバー端スクロールまで死ぬ。
  useEffect(()=>()=>{if(notified.current)dragNotify.current?.({dragging:false,pointer:()=>null});},[]);
  const indexOf=(region:CutRegion)=>regionsRef.current.findIndex(r=>r.start===region.start&&r.end===region.end);
  function select(index:number){const cut=latest.current.map.cuts[index];if(cut)latest.current.onSelectCut(cut.entryIds.includes(latest.current.activeCutId??'')?latest.current.activeCutId!:cut.entryIds[0]!);}
  function begin(handle:CutHandleId,e:PointerEvent){
    e.preventDefault();e.stopPropagation();const p=latest.current,index=indexOf(handle.region),cut=p.map.cuts[index];
    if(e.button!==0||p.busy||pending.current||drag.current||!cut)return;
    suppressRegionClick.current=false;select(index);setSelection(null);setSelectedEdge({id:cut.cut.id,edge:handle.edge});const at=handle.edge==='start'?cut.start:cut.end;
    try{e.currentTarget.setPointerCapture(e.pointerId);}catch{/* document listeners still own this pointer */}
    drag.current={index,edge:handle.edge,pointerId:e.pointerId,capture:e.currentTarget as HTMLElement,x:e.clientX,y:e.clientY,initialX:e.clientX,initialY:e.clientY,initialScroll:p.scroller.current?.scrollLeft??0,initialAt:at,at,moved:false,revision:p.document.revision,zoom:p.zoom,identity:currentIdentity.current};setDragging(true);
  }
  function beginRange(e:PointerEvent){
    const p=latest.current,s=p.scroller.current;
    if(e.button!==0||p.busy||pending.current||drag.current||!s||!(e.target as HTMLElement).closest('.tl-cut'))return;
    suppressRegionClick.current=false;
    const at=Math.round((e.clientX-s.getBoundingClientRect().left+s.scrollLeft-NATIVE_TIMELINE_GUTTER)/p.zoom),index=p.map.cuts.findIndex(c=>at>=c.start&&at<=c.end);
    if(index<0)return;const cut=p.map.cuts[index]!;
    e.preventDefault();e.stopPropagation();select(index);
    (e.currentTarget.closest('.native-finish-cut-track') as HTMLElement|null)?.focus({preventScroll:true});
    // Pointer capture can retarget the later click to the track. Record the
    // explicit whole-band choice now; any moved brush replaces these bounds.
    setSelection({start:cut.start,end:cut.end,revision:p.document.revision,identity:currentIdentity.current,key:restoreSelectionKey(p,cut)});setSelectedEdge(null);
    try{e.currentTarget.setPointerCapture(e.pointerId);}catch{/* document listeners own this pointer */}
    drag.current={index,edge:'range',pointerId:e.pointerId,capture:e.currentTarget as HTMLElement,x:e.clientX,y:e.clientY,initialX:e.clientX,initialY:e.clientY,initialScroll:s.scrollLeft,initialAt:at,at,moved:false,revision:p.document.revision,zoom:p.zoom,identity:currentIdentity.current};setDragging(true);
  }
  const activeIndex=props.map.cuts.findIndex(c=>c.entryIds.includes(props.activeCutId??'')||c.cut.id===props.activeCutId);
  const active=regions[activeIndex];
  const selectedHandle:CutHandleId|null=active&&selectedEdge&&selectedEdge.id===props.map.cuts[activeIndex]?.cut.id?{kind:'cut',region:active,edge:selectedEdge.edge}:null;
  return <div className="native-finish-cut-track" tabIndex={-1} aria-label="保存カットの境界" aria-busy={props.busy||working} style={{position:'relative'}}
    onLostPointerCapture={e=>{if(e.pointerId===drag.current?.pointerId)cancel();}}>
    {error&&<p role="alert">{error}</p>}
    <CutTrack totalFrames={props.map.displayEnd} pxPerFrame={props.zoom} gutterPx={NATIVE_TIMELINE_GUTTER} cutRegions={props.map.cuts} liveRegions={regions}
      selectedHandle={selectedHandle} onHandleDown={begin} pulseKeys={new Set()} videoUrl="" emptyHint={props.map.unresolved.length?'位置を確認するカットがあります':'保存されたカットはありません'}
      selectOnCut onTrackPointerDown={beginRange}
      regionHint={()=>'カット済み（クリックで全体を選択・なぞって一部を選択 → Deleteで戻す・両端で範囲調整）'} onRegionClick={r=>{if(props.busy||pending.current||suppressRegionClick.current)return;const index=indexOf(r),cut=props.map.cuts[index];if(cut){select(index);setSelection({start:cut.start,end:cut.end,revision:props.document.revision,identity,key:restoreSelectionKey(props,cut)});}}}
      getHandleProps={handle=>{
        const index=indexOf(handle.region),cut=props.map.cuts[index];
        return {role:'slider',tabIndex:props.busy||working?-1:0,'aria-disabled':props.busy||working,'aria-label':handle.edge==='start'?'カット左端':'カット右端','aria-valuemin':0,'aria-valuemax':props.map.displayEnd,'aria-valuenow':handle.edge==='start'?handle.region.start:handle.region.end,
          onFocus:()=>{if(cut){select(index);setSelection(null);setSelectedEdge({id:cut.cut.id,edge:handle.edge});}},
          onKeyDown:e=>{if(!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(e.key))return;e.preventDefault();e.stopPropagation();if(e.key==='Escape'){cancel();return;}if(!cut||props.busy||pending.current)return;
            const at=e.key==='Home'?cut.start:e.key==='End'?cut.end:(handle.edge==='start'?cut.start:cut.end)+(e.key==='ArrowLeft'?-1:1);
            void commit(index,handle.edge,at);}};
      }}/>
    {active&&<div className="tl-cut-selection" aria-hidden="true" style={{left:NATIVE_TIMELINE_GUTTER+active.start*props.zoom,width:(active.end-active.start)*props.zoom}}/>}
    {selection&&selection.end>selection.start&&<div className="native-cut-restore-selection" aria-label="戻すカット範囲" style={{position:'absolute',pointerEvents:'none',top:0,bottom:0,left:NATIVE_TIMELINE_GUTTER+selection.start*props.zoom,width:(selection.end-selection.start)*props.zoom,background:'rgba(30,140,110,.3)',border:'2px solid var(--accent)',boxSizing:'border-box',zIndex:5}}/>}
  </div>;
});
