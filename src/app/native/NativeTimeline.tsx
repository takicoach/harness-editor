import {trackHeights,DEFAULT_TRACK_HEIGHT,MIN_TRACK_HEIGHT,MAX_INDIVIDUAL_TRACK_HEIGHT,individualTrackHeight,CAPTION_TRACK_HEIGHT} from './trackHeight';
import {useTrackHeights} from './useTrackHeights';
import {usePanelResize} from './usePanelResize';
import { forwardRef, useImperativeHandle, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type CSSProperties } from 'react';
import { clipEnd, type SequenceClip, type SequenceDocument } from '../../core/sequence/model';
import { timeNumber } from '../../core/sequence/time';
import type { NativeCommand } from './api';
import {ScenePlan} from '../../core/sequence/scenePlan';
import {hasSceneFade,sceneFadeJoins,sceneFadeTargetKey,type SceneFadeTarget} from '../../core/sequence/sceneFadeEdits';
import {NativeWaveform} from './NativeWaveform';
import {NativeArchivedMedia} from './NativeArchivedMedia';
import {NativeFilmstrip} from './NativeFilmstrip';
import {waveformViewport} from './waveformViewport';
import {waveformGain,type WaveformPref} from '../layout/waveformPref';
import {clipHandleWidth} from '../timeline/clipHandles';
import {CLICK_MOVE_THRESHOLD_PX} from '../timeline/timelineGeometry';
import {useNativeTimelineViewport} from './useNativeTimelineViewport';
import {useNativeAssetDrop} from './useNativeAssetDrop';
import {resolveCutBoundary} from '../../core/sequence/cutArchive';
import {buildFinishDisplayMap,finishArchivedToDisplay,finishDisplayPoint,finishLiveToDisplay,projectFinishLiveRange} from './finishDisplayMap';
import {NativeFinishCutTrack,type NativeFinishCutTrackHandle,type NativeFinishCutTrackProps} from './NativeFinishCutTrack';
import { Icon } from '../Icon';
import { trackAccent, trackKindAccent, TRACK_ACCENTS } from './trackAccent';
import { useTrackColors } from './useTrackColors';
import {NativeDragTooltip} from './NativeDragTooltip';
import {buildSnapIndex,snapFrame as snapToTarget,targetDisplayBias,type SnapTarget} from './snapIndex';
import {scrubFrame} from './scrubTarget';
import {rulerLabelFromSeconds,rulerStep} from './rulerStep';
import {clipSeekTarget} from './clipSeek';
import {laneMode,medianClipWidth,NARROW_CLIP_BELOW} from './densityLane';
import {NativeDensityLane} from './NativeDensityLane';
import {rippleTrimPlan,type RippleTrimPlan} from '../../core/sequence/rippleTrim';
import './native-timeline-interaction.css';
import {isEscape} from './keyboard';

/**
 * rippleTrimPlan が「詰める」を最後までやらなかった理由 → 画面に出す文言。`reject` も `clamp` も持つので
 * 名前は RIPPLE_NOTICE（拒否だけの表ではない）。
 * `reject` は ripple を外した従来トリムに落ちたことを、`clamp` の `linked-overhang` は
 * 文書が 1 バイトも変わらない no-op になることを伝える（T4 レビュー Minor 7）。
 * `Record` なので、理由コードを増やしたらここも足さないと型検査が止める。
 */
export const RIPPLE_NOTICE: Record<Extract<RippleTrimPlan,{kind:'reject'}>['reason']
  |NonNullable<Extract<RippleTrimPlan,{kind:'clamp'}>['reason']>, string> = {
  transition: '転換・フェードが掛かっている範囲は「詰める」ができません。通常のトリムで端だけを動かしました（隙間が残ります）。先に転換を解除してください。',
  speed: '速度を登録したクリップと固定挿入は「詰める」ができません。通常のトリムで端だけを動かしました。',
  invalid: 'クリップには 1 フレーム以上必要です。',
  'linked-overhang': '一緒に動くクリップが押し出す位置をまたいでいるため、隣の手前で止まります。先にリンクを外すか、隣のクリップを動かしてください。',
  'fixed-insert-length': '固定挿入がある案件では末尾の長さを保てないため押し出しません。隣の手前で止まります。',
};

/**
 * ドラッグ中の clamp ゴースト（止まりの理由を出す）。`reason` ごとに文言が異なるので、
 * 理由を追加したら型検査で漏れが止まる。`reason` が undefined の場合は別途で 'ここで止まる' に。
 */
export const RIPPLE_CLAMP_GHOST: Record<
  NonNullable<Extract<RippleTrimPlan, {kind:'clamp'}>['reason']>,
  string
> = {
  'linked-overhang': '一緒に動くクリップが重なるのでここで止まる',
  'fixed-insert-length': '固定挿入があるためここで止まる',
};

/**
 * 開始端の結合は必ず左隣の先頭へ着地する（左への押し出しは提供しない・設計 §3）。要求した端が
 * それより左だった分は文書に反映されないので、無言で捨てずに伝える（最終広域レビュー M-4）。
 */
export const RIPPLE_JOIN_START_NOTICE='左隣より先へは戻せません。2 本を 1 本に戻し、左隣の先頭で止めました。';

export type NativeTool = 'select' | 'razor' | 'range';
export const TRACK_LABEL_WIDTH = 132;
/** 色点メニューの高さ（余白 16＋22px の点 2 段＋隙間 5＋「自動に戻す」26＋隙間 5）。下端で上開きへ切り替える判定に使う（M-7）。 */
const COLOR_MENU_HEIGHT = 104;
export interface NativeRange { startFrame: number; endFrame: number; /** なぞり始めたトラック。定規からのなぞりは null。 */ trackId: string | null }
// Rec 3: NativeWorkspace の各テストは NativeTimeline を vi.mock で差し替える。モックのハンドルが
// このキー集合とずれると flush() 等が「is not a function」で Unhandled Rejection になる（I-1）。
// 型からは実行時にキーを取れないので、定数を export してテスト側（NativeTimeline.handleKeys.test.ts）
// が各モックの返り値キー集合と突合する。
export const TIMELINE_HANDLE_KEYS = ['flush', 'restoreCut', 'fitZoom'] as const;
export interface NativeTimelineHandle {flush():Promise<boolean>;restoreCut():Promise<boolean>;fitZoom():void}
interface Props {
  projectId:string;waveform:WaveformPref;trackHeight?:number;
  document: SequenceDocument; frame: number; selected: string[]; range: NativeRange | null; tool: NativeTool; zoom: number; snap: boolean;
  /** 「詰める」トグル。既定 true（製品の既定と一致。RT6: 呼び出し元が prop を省略しても無言で OFF にならないよう昇格）。OFF では `ripple` キー自体を送らない。 */
  ripple?: boolean;
  onSelect(ids: string[]): void; onRange(range: NativeRange | null): void; onSeek(frame: number): void;
  /** Read-only cut-inclusive review: seek on the displayed axis, including archived bands. */
  onDisplaySeek?(frame:number):void;
  onCommand(command: NativeCommand): Promise<boolean>; onDrop(assetId: string, frame: number, trackId: string): void;
  onSceneFade?(target:SceneFadeTarget):void;
  onOpenCut?(entryId:string):void;
  activeCutId?:string|null;
  archivedPlayhead?:{entryId:string;localFrame:number}|null;
  /** カット前を確認中か。設計 3-H の共通ガードはこれを見る（marker の有無で代用しない。M-8）。 */
  cutSourceActive?:boolean;
  sessionId?:string;
  onSelectCut?(entryId:string):void;
  onCutCommand?:NativeFinishCutTrackProps['onCommand'];
  prepareCut?:NativeFinishCutTrackProps['prepare'];
  readDocument?:NativeFinishCutTrackProps['readDocument'];
  onCutWorking?:NativeFinishCutTrackProps['onWorking'];
  onRestoreSelection?:NativeFinishCutTrackProps['onRestoreSelection'];
  onZoomChange?(zoom:number):void;
  /** ジェスチャー状態の唯一の源。true の間だけ、上位がプレビューの当たり判定を止める。 */
  onDragStateChange?(dragging:boolean):void;
  onMinZoom?(value:number):void;
  playing?:boolean;busy?:boolean;mode?:string;
}
interface Gesture { type: 'range' | 'move' | 'start' | 'end' | 'scrub'; x: number; y:number; pointerX:number;pointerY:number;scrollLeft:number;pointerId:number;capture:HTMLElement;grabDisplayFrame:number;
  frame: number; revision: number; documentId:string;projectId:string;zoom:number;mode:string|undefined;
  clip?: SequenceClip; ids?: string[]; delta: number; targetTrack?: string; moved?: boolean;altKey:boolean;
  /** 吸着が効いた先。効かなければ undefined（T9 が書き込む）。 */
  snapFrame?: number; snapLabel?: string;
  /** クリック確定（移動なし）のときだけ `end()` が使う送り先。ドラッグでは使わない。 */
  seekTarget?: number;
  /**
   * ジェスチャ開始時の「詰める」トグル。評価（updateDrag）も確定（end）もこの値だけを読む
   * ので、ドラッグ中に R を押しても進行中の操作は変わらない（設計 §3 の注記・Codex P2-9）。
   * live な `rippleOn` を確定側で読むと、古い計画の frame と新しいフラグが混ざって
   * TRACK_COLLISION になる（最終広域レビュー I-1）。
   */
  ripple?: boolean;
  /** ドラッグごとに再評価した計画。確定時の値で submit する（ドラッグ中の R では変えない）。 */
  ripplePlan?: RippleTrimPlan;
  /** `ripplePlan` を問い合わせたときの端位置と文書 revision。両方同じ場合だけ評価し直さない（RT6: 文書が差し替わった時に古い計画を出さない）。 */
  ripplePlanFrame?: number; ripplePlanRevision?: number }
function kindName(clip: SequenceClip): string { return clip.content.kind === 'audio' ? clip.content.role : clip.content.kind; }
export const NativeTimeline=forwardRef<NativeTimelineHandle,Props>(function NativeTimeline({ projectId,waveform,trackHeight=DEFAULT_TRACK_HEIGHT,document: doc, frame, selected, range, tool, zoom, snap, ripple: rippleOn = true, onSelect, onRange, onSeek, onDisplaySeek, onCommand, onDrop,onSceneFade,onOpenCut,activeCutId,archivedPlayhead,cutSourceActive=false,onZoomChange,onDragStateChange,onMinZoom,playing=false,busy=false,mode,sessionId,onSelectCut,onCutCommand,prepareCut,readDocument,onCutWorking,onRestoreSelection },ref) {
  const heights=trackHeights(trackHeight,waveform);
  const {scales,setScale}=useTrackHeights(projectId,doc.id);
  const {colors:trackColors,setColor:setTrackColor}=useTrackColors(projectId,doc.id);
  const [colorMenu,setColorMenu]=useState<string|null>(null),[colorMenuUp,setColorMenuUp]=useState(false);
  // T6: 外側判定はクラス名ではなく実体で見る（同名クラスの別要素や、後からクラスを変えた時に破れないため）。
  const colorMenuHost=useRef<HTMLDivElement|null>(null),colorMenuDot=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{
    if(!colorMenu)return;
    document.querySelector<HTMLButtonElement>('.native-track-color-menu [role=menuitemradio]')?.focus();
  },[colorMenu]);
  useEffect(()=>{
    if(!colorMenu)return;
    function onPointerDown(event:globalThis.PointerEvent):void{
      if(!(event.target instanceof Node))return;
      // 起点の色点も除外する（ここで閉じると、続く click がもう一度開いてトグルが効かない）。
      if(colorMenuHost.current?.contains(event.target)||colorMenuDot.current?.contains(event.target))return;
      setColorMenu(null);
    }
    document.addEventListener('pointerdown',onPointerDown);
    return()=>document.removeEventListener('pointerdown',onPointerDown);
  },[colorMenu]);
  const trackResize=usePanelResize();
  const cutTrack=useRef<NativeFinishCutTrackHandle>(null),viewportRef=useRef<{fitZoom():void}|null>(null);
  const cutDrag=useRef<{dragging:boolean;pointer:()=>{x:number;y:number;moved:boolean}|null}>({dragging:false,pointer:()=>null});
  const [cutDragging,setCutDragging]=useState(false);
  useImperativeHandle(ref,()=>({flush:async()=>{cancel();return !cutTrack.current||await cutTrack.current.flush();},
    restoreCut:()=>cutTrack.current?.restore()??Promise.resolve(false),
    fitZoom:()=>viewportRef.current?.fitZoom()}));
  const finishMap=useMemo(()=>mode==='finish'?buildFinishDisplayMap(doc):null,[doc,mode]);
  const displayFrame=(at:number,bias:'before'|'after'='after')=>finishMap?(finishLiveToDisplay(finishMap,at,bias)??finishMap.displayEnd+Math.max(0,at-finishMap.completionEnd)):at;
  const playhead=archivedPlayhead===undefined?displayFrame(frame):archivedPlayhead&&finishMap?finishArchivedToDisplay(finishMap,archivedPlayhead.entryId,archivedPlayhead.localFrame):null;
  const completionFrame=(at:number,bias:'before'|'after'='after')=>{
    if(at<=0)return 0;
    if(!finishMap)return at;
    const point=finishDisplayPoint(finishMap,at,bias);
    if(!point)return finishMap.completionEnd+Math.max(0,at-finishMap.displayEnd);
    if(point.kind==='live')return point.frame;
    const cut=finishMap.cuts.find(cut=>cut.entryIds.includes(point.entryId));
    if(!cut)throw new Error('カット帯の表示位置を確認できませんでした');
    return cut.atFrame;
  };
  const displayPieces=(start:number,end:number)=>{
    if(!finishMap)return [{startFrame:start,endFrame:end,displayStart:start,displayEnd:end}];
    const pieces=projectFinishLiveRange(finishMap,Math.max(0,start),Math.min(end,finishMap.completionEnd));
    if(end>finishMap.completionEnd){const from=Math.max(start,finishMap.completionEnd);pieces.push({startFrame:from,endFrame:end,displayStart:displayFrame(from),displayEnd:displayFrame(end)});}
    return pieces;
  };
  const fps = timeNumber(doc.fps), pixels = zoom;
  // dense は映像クリップの幅の中央値で決まる（トラック単位ではない）。隠す対象は各トラックの印なので、
  // 太いクリップのトラックでも印が消えることがある — 画面全体の密度で切り替える意図（M-3）。
  const dense = useMemo(()=>medianClipWidth(doc.clips.filter(c=>c.content.kind==='video'),pixels)<NARROW_CLIP_BELOW,[doc.clips,pixels]);
  const contentFrames = Math.max(finishMap?.displayEnd??doc.sequenceEndFrame, ...doc.clips.map(c=>displayFrame(clipEnd(c),'before')));
  const width = Math.max(800, (contentFrames + fps * 5) * pixels);
  const scroller = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null), [ghost, setGhost] = useState<Gesture | null>(null);
  useLayoutEffect(()=>{
    const element=scroller.current,cut=finishMap?.cuts.find(item=>item.entryIds.includes(activeCutId??''));
    if(!element||!cut)return;
    const start=TRACK_LABEL_WIDTH+cut.start*pixels,end=TRACK_LABEL_WIDTH+cut.end*pixels,available=element.clientWidth-TRACK_LABEL_WIDTH;
    let target=element.scrollLeft;
    if(start<target+TRACK_LABEL_WIDTH||end-start>available&&start>target+element.clientWidth)target=start-TRACK_LABEL_WIDTH;
    else if(end-start<=available&&end>target+element.clientWidth)target=end-element.clientWidth;
    element.scrollLeft=Math.max(0,Math.min(Math.max(0,element.scrollWidth-element.clientWidth),target));
    // Reveal on entering the tab, not on pointer selection during a drag.
  },[mode,projectId,doc.id]);
  const [view,setView]=useState({left:0,top:0,width:0,height:0});
  const audioPlan=useMemo(()=>doc.clips.some(clip=>clip.content.kind==='audio')?new ScenePlan(doc):null,[doc]);
  useEffect(()=>{
    const element=scroller.current;if(!element)return;
    let animation=0;
    const measure=()=>{animation=0;const next={left:element.scrollLeft,top:element.scrollTop,width:element.clientWidth,height:element.clientHeight};setView(previous=>previous.left===next.left&&previous.top===next.top&&previous.width===next.width&&previous.height===next.height?previous:next);};
    const schedule=()=>{if(!animation)animation=requestAnimationFrame(measure);};
    const observer=new ResizeObserver(schedule);observer.observe(element);element.addEventListener('scroll',schedule,{passive:true});measure();
    return()=>{observer.disconnect();element.removeEventListener('scroll',schedule);cancelAnimationFrame(animation);};
  },[]);
  const [draftRange, setDraftRange] = useState<NativeRange | null>(null), shownRange = draftRange ?? range;
  const [moveNotice,setMoveNotice]=useState('');
  const [dragging,setDragging]=useState(false),[pending,setPending]=useState(false);
  const dragNotify=useRef(onDragStateChange);dragNotify.current=onDragStateChange;
  // 上位が止めるのはプレビューの当たり判定。仕上げのカット行のドラッグも同じ扱いにする。
  useEffect(()=>{dragNotify.current?.(dragging||cutDragging);},[dragging,cutDragging]);
  // アンマウント時は state 更新が走らないので、最後に必ず false を送る。
  useEffect(()=>()=>dragNotify.current?.(false),[]);
  const committing=useRef(false),mounted=useRef(false);
  const readOnly=!!onDisplaySeek,seekBlocked=busy||pending;
  const blocked=seekBlocked||readOnly;
  const currentOwner=useRef({projectId,documentId:doc.id});
  // Replace the token on every context transition, including A -> B -> A.
  useLayoutEffect(()=>{currentOwner.current={projectId,documentId:doc.id};},[projectId,doc.id,mode]);
  const tracks = [...doc.tracks.filter(t => t.kind === 'visual').reverse(), ...doc.tracks.filter(t => t.kind === 'audio')];
  const cutTrackId=finishMap?tracks.find(track=>doc.clips.some(clip=>clip.trackId===track.id&&clip.content.kind==='video'))?.id:undefined;
  const cuts=useMemo(()=>{
    const groups=new Map<number,{ids:string[];ambiguous:boolean}>();
    for(const entry of doc.cutArchive?.entries??[]){const boundary=resolveCutBoundary(doc,entry),at=boundary.frame??Math.min(doc.sequenceEndFrame,entry.boundary.hintFrame),group=groups.get(at)??{ids:[],ambiguous:false};group.ids.push(entry.id);group.ambiguous||=boundary.frame===null;groups.set(at,group);}
    return [...groups].sort(([a],[b])=>a-b);
  },[doc]);
  const showCuts=!!onOpenCut&&cuts.length>0&&!finishMap;
  const visibleTracks=new Set<string>();const trackTops=new Map<string,number>();
  const rowHeights=new Map<string,number>();
  // I-6: 再生中は frame ごとに再描画される。種別色・トラック色・密度帯の判定は文書とトラック色だけで
  // 決まるので、描画ごとに O(トラック数² × クリップ数) を走らせず 1 回だけ辞書を作って引く。
  const kindAccents=useMemo(()=>new Map(doc.tracks.map(t=>[t.id,trackKindAccent(t,doc.clips)])),[doc.tracks,doc.clips]);
  // M-4': `tracks` と `kindAccents` を deps に書かない理由 — `tracks` は doc.tracks からの純粋導出（毎描画で
  // 新しい配列になるが値として同値）、`kindAccents` は同じ [doc.tracks,doc.clips] のメモなので、この 3 つが
  // 同じなら結果も同じ。deps にそのまま書くと毎描画でメモが壊れる（再生中に O(トラック数²×クリップ数)）。
  const accents=useMemo(()=>new Map(tracks.map(t=>[t.id,trackAccent(t,doc.clips,tracks,trackColors,kindAccents)])),[doc.tracks,doc.clips,trackColors]);   // eslint-disable-line react-hooks/exhaustive-deps
  // M-4': doc.tracks を deps に含める（写している以上、偶然の無害さに頼らない。追加コストはトラック数ぶんの filter 1 回）。
  const laneModes=useMemo(()=>new Map(doc.tracks.map(t=>[t.id,laneMode(doc.clips.filter(c=>c.trackId===t.id),pixels)])),[doc.tracks,doc.clips,pixels]);
  const captionTrack=(track:SequenceDocument['tracks'][number])=>track.kind==='visual'&&['--track-telop','--track-jimaku','--track-title'].includes(kindAccents.get(track.id)??trackKindAccent(track,doc.clips));
  const baseHeight=(track:SequenceDocument['tracks'][number])=>track.id===cutTrackId?heights.cut:track.kind==='audio'?heights.audio:captionTrack(track)?Math.min(heights.visual,CAPTION_TRACK_HEIGHT):heights.visual;
  let trackTop=36+(showCuts?34:0)+(finishMap&&!cutTrackId?heights.cut:0)+(finishMap?.unresolved.length?34:0);
  for(const track of tracks){
    trackTops.set(track.id,trackTop);
    const height=individualTrackHeight(baseHeight(track),scales[track.id]);
    rowHeights.set(track.id,height);
    if(trackTop+height>view.top-96&&trackTop<view.top+view.height+96)visibleTracks.add(track.id);
    trackTop+=height;
  }
  const displayPosition=(clientX:number)=>(clientX-scroller.current!.getBoundingClientRect().left+scroller.current!.scrollLeft-TRACK_LABEL_WIDTH)/pixels;
  const scrubPosition=(x:number)=>scrubFrame(onDisplaySeek?Math.round(displayPosition(x)):position(x),onDisplaySeek&&finishMap?finishMap.displayEnd:doc.sequenceEndFrame);
  const seekScrub=(x:number)=>(onDisplaySeek??onSeek)(scrubPosition(x));
  const position = (clientX: number) => {
    const bounds = scroller.current!.getBoundingClientRect();
    return Math.max(0,Math.round(completionFrame((clientX - bounds.left + scroller.current!.scrollLeft - TRACK_LABEL_WIDTH) / pixels)));
  };
  const owns=(action:Gesture)=>!(action.type==='scrub'?seekBlocked:blocked)&&!committing.current&&action.revision===doc.revision&&action.documentId===doc.id&&action.projectId===projectId&&action.zoom===zoom&&action.mode===mode;
  const assetDrop=useNativeAssetDrop({scroller,ownerKey:JSON.stringify([projectId,sessionId,doc.id,doc.revision,zoom,mode,tool]),disabled:blocked||dragging||mode==='review',position,
    valid:(assetId,trackId)=>!committing.current&&doc.assets.some(asset=>asset.id===assetId&&asset.kind!=='lut'&&asset.kind!=='component')&&doc.tracks.some(track=>track.id===trackId),drop:onDrop});
  const cancel=()=>{
    assetDrop.cancel();
    const action=gesture.current;gesture.current=null;
    if(mounted.current){setDragging(false);setGhost(null);setDraftRange(null);}
    // Clear ownership before release: lostpointercapture must never commit.
    if(action){try{if(action.capture.hasPointerCapture(action.pointerId))action.capture.releasePointerCapture(action.pointerId);}catch{/* The captured node may already be detached. */}}
  };
  const submit=async(command:NativeCommand):Promise<boolean>=>{
    if(blocked||committing.current)return false;
    const owner=currentOwner.current;
    committing.current=true;setPending(true);
    try{const ok=await onCommand(command);return ok&&mounted.current&&owner===currentOwner.current;}
    catch(error){if(mounted.current&&owner===currentOwner.current)setMoveNotice(error instanceof Error?error.message:'編集を確定できませんでした');return false;}
    finally{committing.current=false;if(mounted.current)setPending(false);}
  };
  const begin=(event:PointerEvent<HTMLElement>,type:Gesture['type'],at:number,clip?:SequenceClip,ids?:string[])=>{
    if((type==='scrub'?seekBlocked:blocked)||committing.current||gesture.current)return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current={type,x:event.clientX,y:event.clientY,pointerX:event.clientX,pointerY:event.clientY,scrollLeft:scroller.current!.scrollLeft,
      pointerId:event.pointerId,capture:event.currentTarget,grabDisplayFrame:(event.clientX-scroller.current!.getBoundingClientRect().left+scroller.current!.scrollLeft-TRACK_LABEL_WIDTH)/pixels,
      frame:at,revision:doc.revision,documentId:doc.id,projectId,zoom,mode,clip,ids,delta:0,altKey:event.altKey,ripple:rippleOn};
    setDragging(true);
  };
  /** 1・2 番目の門（ボタン判定と操作可能性）。操作できないときは選択解除もシークもしない。 */
  const canGesture=(event:PointerEvent<HTMLElement>,scrub=false)=>event.button===0&&!(scrub?seekBlocked:blocked)&&!committing.current&&!gesture.current;
  const startRange = (event: PointerEvent<HTMLElement>) => {
    if (!canGesture(event)) return;
    const at = Math.min(doc.sequenceEndFrame, position(event.clientX));
    begin(event,'range',at);
    const row=(event.target as HTMLElement).closest<HTMLElement>('[data-native-track]');
    gesture.current!.targetTrack=row?.dataset.nativeTrack;
    setDraftRange(null); onRange(null); onSeek(scrubFrame(at, doc.sequenceEndFrame));
  };
  /**
   * なぞらずに再生位置だけを動かす。順番が意味を持つ（P1-7）:
   * ボタン判定 → 操作可能性 → クランプ → pointerdown で seek → begin。
   * `updateDrag` は `!action.moved` で早期 return するため、ここで呼ばないと単クリックがシークしない。
   */
  const startScrub = (event: PointerEvent<HTMLElement>) => {
    if (!canGesture(event,true)) return;
    const at = scrubPosition(event.clientX);
    seekScrub(event.clientX);
    begin(event,'scrub',at);
  };
  const startClip = (event: PointerEvent<HTMLElement>, clip: SequenceClip, edge?: 'start' | 'end') => {
    event.stopPropagation(); if (event.button !== 0||blocked||committing.current||gesture.current) return;
    setMoveNotice('');
    if (tool === 'range' && !edge) { startRange(event); return; }
    if (tool === 'razor' && !edge) {
      const at = position(event.clientX);
      if (at > clip.startFrame && at < clipEnd(clip)) void submit({ type: 'split', clipIds: [clip.id], frame: at });
      return;
    }
    let ids = selected.includes(clip.id) ? selected : [clip.id];
    if (event.shiftKey) ids = selected.includes(clip.id) ? selected.filter(id => id !== clip.id) : [...selected, clip.id];
    onSelect(ids); onRange(null);
    if (event.shiftKey && !ids.includes(clip.id)) return;
    // クリックとドラッグの共通入口なので pointerdown では送らない。送り先だけ持たせて end() が使う。
    const seekBlocked = playing || activeCutId != null || cutSourceActive || tool !== 'select'
      || !!edge || event.shiftKey || ids.length !== 1;
    const target = seekBlocked ? null : clipSeekTarget(clip, frame, mode === 'finish' ? displayPieces(clip.startFrame, clipEnd(clip)) : null);
    begin(event,edge??'move',edge==='end'?clipEnd(clip):clip.startFrame,clip,ids);
    // TS narrows `gesture.current` to null from the early-return guard above and doesn't see
    // `begin()` populate it; read it back through a cast to avoid a stale `never` narrowing.
    const active = gesture.current as Gesture | null, targetFrame = target?.frame;
    if (active && targetFrame != null) active.seekTarget = targetFrame;
  };
  const updateDrag = () => {
    const action = gesture.current; if (!action) return;
    if(!owns(action)){cancel();return;}
    if(!action.moved)return;
    if (action.type === 'scrub') { seekScrub(action.pointerX); return; }
    if (action.type === 'range') {
      const at = Math.min(doc.sequenceEndFrame, position(action.pointerX));
      action.delta = at - action.frame;
      const row = window.document.elementFromPoint(action.pointerX, action.pointerY)?.closest<HTMLElement>('[data-native-track]');
      if(row?.dataset.nativeTrack)action.targetTrack=row.dataset.nativeTrack;
      setDraftRange({ startFrame: Math.min(at, action.frame), endFrame: Math.max(at, action.frame), trackId: action.targetTrack ?? null });
      return;
    }
    const displayDelta=(action.pointerX-action.x+scroller.current!.scrollLeft-action.scrollLeft)/pixels;
    let delta = action.type==='move'
      ?Math.round(completionFrame(action.grabDisplayFrame+displayDelta)-completionFrame(action.grabDisplayFrame))
      :Math.round(completionFrame(displayFrame(action.frame,action.type==='end'?'before':'after')+displayDelta,action.type==='end'?'before':'after')-action.frame);
    action.snapFrame=undefined;action.snapLabel=undefined;
    if (snap&&!action.altKey) {
      // index は document 由来（語境界・語間・他クリップ端・0）。再生ヘッドと自分自身の除外はここで足す・引く。
      // 自分自身の除外は id（clipId）で判定する — 値一致（startFrame/clipEnd）だと、同じフレームに
      // 隣接する別クリップの端まで誤って除外してしまう。
      const excluded=new Set(action.ids??[]);
      const targets:SnapTarget[]=[{frame,kind:'playhead',label:'再生ヘッド'},
        ...snapTargets.filter(target=>target.kind!=='clip'||!target.clipId||!excluded.has(target.clipId))];
      const ends = action.type === 'move' ? [{frame:action.clip!.startFrame,side:'after' as const},{frame:clipEnd(action.clip!),side:'before' as const}]
        : [{frame:action.frame,side:action.type==='end'?'before' as const:'after' as const}];
      // クリップ端は自分の side（'start'/'end'）に応じた向きで displayFrame を評価する（カット境界
      // 前後で表示位置が不連続なため、逆側で評価すると数十フレームずれる）。foldDuplicates で生き残った
      // ターゲット自身の side を見るので、隣接クリップの順序に依存しない。それ以外（word・gap・0・
      // 再生ヘッド）は常に 'after'（targetDisplayBias, snapIndex.ts）。
      let smallest=6/pixels,adjustment=0,hit:SnapTarget|null=null;
      for(const end of ends){
        const result=snapToTarget(targets,end.frame+delta,smallest);
        if(!result.target)continue;
        const distance=Math.abs(displayFrame(result.target.frame,targetDisplayBias(result.target))-displayFrame(end.frame+delta,end.side));
        if(distance<smallest){smallest=distance;adjustment=result.target.frame-(end.frame+delta);hit=result.target;}
      }
      delta+=adjustment;
      if(hit){action.snapFrame=hit.frame;action.snapLabel=hit.label;}
    }
    if (action.type === 'move') delta = Math.max(-Math.min(...doc.clips.filter(c => action.ids?.includes(c.id)).map(c => c.startFrame)), delta);
    else if (action.type === 'start') delta = Math.max(-action.frame, Math.min(action.clip!.durationFrames - 1, delta));
    else delta = Math.max(1 - action.clip!.durationFrames, delta);
    if (action.type === 'start' || action.type === 'end') {
      const edge = action.type, asked = action.frame + delta;
      // 同じ端位置・同じ文書での問い合わせはポインタ移動のたびに繰り返される。直前の答えを使い回す。
      // revision も見るのは、ドラッグ中に文書が差し替わっても古い計画を出さないため（RT5 レビュー Minor 送り）。
      const plan = action.ripplePlanFrame === asked && action.ripplePlanRevision === doc.revision && action.ripplePlan
        ? action.ripplePlan
        : rippleTrimPlan(doc, {type:'trim', clipId: action.clip!.id, edge, frame: asked, ...(action.ripple ? {ripple: true} : {})});
      action.ripplePlanFrame = asked; action.ripplePlanRevision = doc.revision;
      // clamp は端そのものを止める。reject は計画を破棄せずゴースト側で理由を出し、確定時に ripple を外す。
      // 止めた先で計画を取り直さない — 取り直すと「止まる位置」も `linked-overhang` の理由も
      // `plain` に潰れ、ゴーストも通知も消える（T4 レビュー Minor 7 の no-op が無言になる）。
      if (plan.kind === 'clamp') {
        delta = plan.frame - action.frame;
        // 止めた位置と吸着先は別の場所になりうる。線を 2 本出さないため吸着表示は捨てる。
        action.snapFrame = undefined; action.snapLabel = undefined;
      }
      action.ripplePlan = plan;
    }
    action.delta = delta;
    const row = window.document.elementFromPoint(action.pointerX, action.pointerY)?.closest<HTMLElement>('[data-native-track]');
    const track = doc.tracks.find(t => t.id === row?.dataset.nativeTrack);
    action.targetTrack=track&&(track.kind==='audio')===(action.clip!.content.kind==='audio')?track.id:undefined;
    setGhost({ ...action });
  };
  // updateAlt=false（pointerup 経由の最終呼び出し）では altKey を上書きしない。離す瞬間の
  // イベントは修飾キー状態を保証しないため、直前の実移動で捉えた Alt 状態を確定に使う。
  const move=(event:globalThis.PointerEvent,updateAlt=true)=>{
    const action=gesture.current;if(!action||action.pointerId!==event.pointerId)return;
    action.pointerX=event.clientX;action.pointerY=event.clientY;if(updateAlt)action.altKey=event.altKey;
    action.moved ||= Math.hypot(event.clientX-action.x,event.clientY-action.y)>=CLICK_MOVE_THRESHOLD_PX;
    updateDrag();
  };
  const end = () => {
    const action = gesture.current,valid=action&&owns(action);cancel();
    if (!action || !valid) return;
    // 「移動なし＝クリック確定」でのみ送る。`!action.moved` の早期 return より前に置く。
    if (!action.moved) { if (action.type === 'move' && action.seekTarget !== undefined) onSeek(action.seekTarget); return; }
    if (action.type === 'range') {
      if (action.moved && action.delta) onRange({ startFrame: Math.min(action.frame, action.frame + action.delta),
        endFrame: Math.max(action.frame, action.frame + action.delta), trackId: action.targetTrack ?? null });
      return;
    }
    if (action.type === 'move') {
      // Multiple selections keep their original tracks. A mixed track still permits time edits.
      if(action.ids!.length===1&&action.targetTrack&&action.targetTrack!==action.clip!.trackId
        &&action.clip!.content.kind!=='scene-fade'&&hasSceneFade(doc,action.targetTrack)){
        setMoveNotice('場面フェードのトラックです。別の映像トラックを選んでください。');return;
      }
      if (action.delta || (action.targetTrack && action.targetTrack !== action.clip!.trackId)) void submit({ type: 'move', clipIds: action.ids!, deltaFrames: action.delta,
        ...(action.ids!.length === 1 ? { trackId: action.targetTrack } : {}) });
    } else if (action.type !== 'scrub') {
      // 隣の手前で止めた結果、文書が変わらない no-op になることがある（T4 レビュー Minor 7）。
      // 理由つきの clamp は delta が 0 でも黙って終わらせず、止まった訳を出す。
      const clamped = action.ripplePlan?.kind === 'clamp' ? action.ripplePlan.reason : undefined;
      if (clamped) setMoveNotice(RIPPLE_NOTICE[clamped]);
      if (!action.delta) return;
      // reject は「この端は詰められない」なので、従来のトリム（ripple 無し）に落として理由を出す。
      const rejected = action.ripplePlan?.kind === 'reject' ? action.ripplePlan.reason : null;
      if (rejected) setMoveNotice(RIPPLE_NOTICE[rejected]);
      // 開始端の結合は左隣の先頭で止まる。要求がそれより左なら行き過ぎ分は捨てられる（M-4）。
      const joined = action.ripplePlan?.kind === 'join' ? action.ripplePlan : null;
      if (action.type === 'start' && joined) {
        const landing = doc.clips.find(c => c.id === joined.leftId)?.startFrame;
        if (landing !== undefined && action.frame + action.delta < landing) setMoveNotice(RIPPLE_JOIN_START_NOTICE);
      }
      void submit({ type: 'trim', clipId: action.clip!.id, edge: action.type,
        frame: action.frame + action.delta, ...(action.ripple && !rejected ? { ripple: true } : {}) });
    }
  };
  const handlers=useRef({move,end,cancel});useLayoutEffect(()=>{handlers.current={move,end,cancel};});
  useLayoutEffect(()=>{
    mounted.current=true;
    const pointerMove=(event:globalThis.PointerEvent)=>handlers.current.move(event);
    const pointerUp=(event:globalThis.PointerEvent)=>{if(gesture.current?.pointerId===event.pointerId){handlers.current.move(event,false);handlers.current.end();}};
    const pointerCancel=(event:globalThis.PointerEvent)=>{if(gesture.current?.pointerId===event.pointerId)handlers.current.cancel();};
    const abort=()=>handlers.current.cancel();
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&gesture.current){event.preventDefault();event.stopPropagation();abort();}};
    window.addEventListener('pointermove',pointerMove);window.addEventListener('pointerup',pointerUp);window.addEventListener('pointercancel',pointerCancel);
    window.addEventListener('blur',abort);window.addEventListener('keydown',escape,true);
    return()=>{mounted.current=false;abort();window.removeEventListener('pointermove',pointerMove);window.removeEventListener('pointerup',pointerUp);window.removeEventListener('pointercancel',pointerCancel);window.removeEventListener('blur',abort);window.removeEventListener('keydown',escape,true);};
  },[]);
  useLayoutEffect(()=>{cancel();},[projectId,doc.id,doc.revision,zoom,mode,tool,busy,readOnly]);
  const viewport=useNativeTimelineViewport({scroller,zoom,frame:playhead??displayFrame(frame),projectId,documentId:doc.id,mode,totalFrames:contentFrames,
    playing:playing&&playhead!==null,busy:seekBlocked,onZoomChange,
    pointer:()=>{
      const action=gesture.current;
      if(action&&owns(action))return {x:action.pointerX,y:action.pointerY,moved:!!action.moved};
      if(cutDrag.current.dragging){const cut=cutDrag.current.pointer();if(cut)return cut;}
      return assetDrop.pointer();
    },
    onDragScroll:()=>{updateDrag();assetDrop.refresh();},cancel,dragging:dragging||cutDragging||!!assetDrop.preview,
    hoverEdgeScroll:!dragging&&!cutDragging&&!assetDrop.preview&&!(playing&&playhead!==null)&&!blocked});
  useLayoutEffect(()=>{viewportRef.current=viewport;});
  useEffect(()=>{onMinZoom?.(viewport.minZoom);},[viewport.minZoom,onMinZoom]);
  const trimKey=(event:React.KeyboardEvent<HTMLButtonElement>,clip:SequenceClip,edge:'start'|'end')=>{
    if(event.key===' '||event.key==='Enter'){event.stopPropagation();return;}
    if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
    event.preventDefault();event.stopPropagation();
    if(blocked||committing.current||gesture.current||event.nativeEvent.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
    // ドラッグは startClip で毎回クリアするが、キー経路には無かった。前回の理由が残り続ける（M-2）。
    setMoveNotice('');
    const at=(edge==='start'?clip.startFrame:clipEnd(clip))+(event.key==='ArrowLeft'?-1:1);
    if(at<0||(edge==='start'?at>=clipEnd(clip):at<=clip.startFrame))return;
    const plan=rippleTrimPlan(doc,{type:'trim',clipId:clip.id,edge,frame:at,...(rippleOn?{ripple:true}:{})});
    const frame=plan.kind==='clamp'?plan.frame:at;
    if(plan.kind==='clamp'&&plan.reason)setMoveNotice(RIPPLE_NOTICE[plan.reason]);
    if(frame===(edge==='start'?clip.startFrame:clipEnd(clip)))return;
    if(plan.kind==='reject')setMoveNotice(RIPPLE_NOTICE[plan.reason]);
    void submit({type:'trim',clipId:clip.id,edge,frame,...(rippleOn&&plan.kind!=='reject'?{ripple:true}:{})});
  };
  // 目盛りは表示座標（left = TRACK_LABEL_WIDTH + tick*pixels）に置く。displayFrame の写像は掛けない
  // ので、ルーラーが示すのは表示時間（仕上げモードではカット後の尺）。
  const ripplePlan = ghost?.moved ? ghost.ripplePlan ?? null : null;
  const rippleRight = ripplePlan?.kind === 'join' ? doc.clips.find(c => c.id === ripplePlan.rightId) : undefined;
  // 結合しても足りない分は右へ押し出す（設計 §3・§6 の `join.push`）。単独の押し出しと同じ影で予告する
  // —「1 本に戻す」だけだと全トラックがずれることが伝わらない（レビュー Important 1）。
  const ripplePush = ripplePlan?.kind === 'push' ? ripplePlan : ripplePlan?.kind === 'join' ? ripplePlan.push ?? null : null;
  const rippleJoinLabel = ripplePlan?.kind === 'join' ? '1 本に戻す' : '';
  const step = contentFrames > 0 ? rulerStep(pixels, fps) : null;
  const longForm = contentFrames >= fps * 3600;
  // stepFrames／minorFrames は小数のまま（23.976／29.97fps では整数ではない）。ここで index 倍した値も
  // 小数のまま保持し、丸めるのは①画面上の位置（pixels 倍する直前）と②ラベルの秒数を出す瞬間だけに限る。
  // 先に丸めてから index 倍すると、丸め誤差が index に比例して積み上がる（Codex P2）。
  // 位置は index * stepFrames（従来どおり）。ラベルは index * stepSeconds という「秒」から直接
  // 整形する — stepSeconds は常に整数なので、フレームを経由して割り戻すより端数 fps で正確（R3-1）。
  const ticks = step ? Array.from({ length: Math.ceil(width / pixels / step.stepFrames) }, (_, i) => i) : [];
  // 補助線の除外はインデックスで判定する（丸めたフレーム値どうしの剰余だと端数 fps でずれる。R3-2）。
  const minorTicks = step?.minorFrames
    ? Array.from({ length: Math.ceil(width / pixels / step.minorFrames) }, (_, i) => i)
      .filter(i => i % step.minorDivisions !== 0)
    : [];
  const fadeJoins=useMemo(()=>sceneFadeJoins(doc),[doc]);
  // document 由来（0・クリップ端・語境界・語間）だけを持つ。再生ヘッド更新（毎フレーム）では作り直さない。
  // playhead は null で渡す — document 由来の index に「再生位置」を焼き込むと、frame 0 付近で
  // KIND_PRIORITY（playhead > zero）により常に「再生位置」が勝って「先頭」が出せなくなる。
  // 実際の再生ヘッドはドラッグ中の吸着ブロックで別途合成する。
  const snapTargets=useMemo(()=>snap?buildSnapIndex(doc,null,[]):[],[doc,snap]);
  const finishCutRow=finishMap&&<NativeFinishCutTrack ref={cutTrack} projectId={projectId} sessionId={sessionId} document={doc} map={finishMap} zoom={zoom} mode={mode} scroller={scroller} busy={seekBlocked} activeCutId={activeCutId??null}
    onSelectCut={id=>onSelectCut?.(id)} onCommand={onCutCommand??((operation)=>onCommand(operation))} prepare={prepareCut} readDocument={readDocument} onWorking={onCutWorking} onRestoreSelection={onRestoreSelection}
    onDragStateChange={state=>{cutDrag.current=state;setCutDragging(state.dragging);}}/>;
  return <div className={`native-timeline native-tool-${tool}`} data-dense={dense?'true':undefined} style={{'--native-visual-track-height':`${heights.visual}px`,'--native-audio-track-height':`${heights.audio}px`,'--native-cut-track-height':`${heights.cut}px`,'--tl-track-cut-h':`${heights.cut}px`} as CSSProperties} ref={scroller}
    onPointerDownCapture={event=>{
      if(!readOnly||(event.target as HTMLElement).closest('button,input,select,.native-track-label,.native-finish-cut-track .tl-cut')||!(event.target as HTMLElement).closest('.native-timeline-content'))return;
      event.stopPropagation();startScrub(event);
    }}
    onClickCapture={event=>{if(readOnly&&!(event.target as HTMLElement).closest('button,input,select,.native-track-label,.native-finish-cut-track .tl-cut'))event.stopPropagation();}}
    onLostPointerCapture={event=>{if(gesture.current?.pointerId===event.pointerId)cancel();}} aria-label="タイムライン" aria-busy={seekBlocked}>
    {/* ライブ領域は常設する。読み上げは「後から現れた要素」では起きないため（レビュー Minor 7）。
        通知が無いときはドラッグ中の結合予告を流し、どちらも無ければ空のまま置いておく。 */}
    <div role="status" style={{position:'sticky',top:0,left:0,height:0,zIndex:5,pointerEvents:'none'}}>
      {(moveNotice||rippleJoinLabel)&&<span style={{background:'var(--bg-1)',color:'var(--fg-1)',padding:'4px 12px'}}>{moveNotice||rippleJoinLabel}</span>}</div>
    <div className="native-timeline-content" style={{ width: width + TRACK_LABEL_WIDTH }}>
      <div className="native-ruler" onPointerDown={startScrub}><div className="native-track-label native-ruler-label">トラック</div>
        {onSceneFade&&(['head','tail'] as const).map(kind=><button key={kind} className="native-scene-fade-edge" aria-label={`${kind==='head'?'動画の最初':'動画の最後'}のフェードを設定`} style={{left:TRACK_LABEL_WIDTH+displayFrame(kind==='head'?0:doc.sequenceEndFrame)*pixels}} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onClick={()=>onSceneFade({kind})}><Icon name="fade-handle" size={12} filled/></button>)}
        {minorTicks.map(i => <i key={`m${i}`} className="native-ruler-minor" aria-hidden="true" style={{ left: TRACK_LABEL_WIDTH + Math.round(i * step!.minorFrames!) * pixels }} />)}
        {ticks.map(i => <span key={i} style={{ left: TRACK_LABEL_WIDTH + Math.round(i * step!.stepFrames) * pixels }}>{rulerLabelFromSeconds(i * step!.stepSeconds, longForm)}</span>)}
      </div>
      {!cutTrackId&&finishCutRow}
      {!!finishMap?.unresolved.length&&<div className="native-cut-lane native-unresolved-cuts"><div className="native-track-label">位置の確認</div>{finishMap.unresolved.map(cut=><button key={cut.cut.id} disabled={blocked} title={cut.reason} onClick={()=>onOpenCut?.(cut.entryIds[0]!)}>保存カットを確認</button>)}</div>}
      {showCuts&&<div className="native-cut-lane"><div className="native-track-label">カットした部分</div>{cuts.map(([at,group])=><button key={at} data-native-cut-id={group.ids[0]} aria-pressed={!!activeCutId&&group.ids.includes(activeCutId)} className={group.ambiguous?'is-ambiguous':''} style={{left:TRACK_LABEL_WIDTH+displayFrame(at,'before')*pixels}} disabled={blocked}
        aria-label={`${(at/fps).toFixed(2)}秒付近のカット${group.ids.length}件を確認`} title={group.ambiguous?'復元位置の確認が必要です':'カットした部分を確認・復元'} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onClick={()=>onOpenCut?.(group.ids[0]!)}>↶ {group.ids.length>1?group.ids.length:''}{group.ambiguous?' ?':''}</button>)}</div>}
      {tracks.map(track => <div className={`native-track native-track-${track.kind}${track.id===cutTrackId?' native-track-with-cuts':''}`} data-native-track={track.id} key={track.id}
        style={{'--track-accent':`var(${accents.get(track.id)??trackAccent(track,doc.clips,tracks,trackColors,kindAccents)})`,'--native-visual-track-height':`${rowHeights.get(track.id)}px`,'--native-audio-track-height':`${rowHeights.get(track.id)}px`,'--native-cut-track-height':`${rowHeights.get(track.id)}px`} as CSSProperties}
        onPointerDown={event => { if (event.target !== event.currentTarget) return;
          if (tool === 'range') { onSelect([]); startRange(event); }
          else { if (!canGesture(event)) return; onSelect([]); startScrub(event); } }}
        onDragOver={event=>assetDrop.over(event,track.id)} onDragLeave={assetDrop.leave}
        onDrop={event=>assetDrop.drop(event,track.id)}>
        {assetDrop.preview?.trackId===track.id&&<div className="native-asset-drop-marker" data-drop-frame={assetDrop.preview.frame} style={{left:TRACK_LABEL_WIDTH+displayFrame(assetDrop.preview.frame)*pixels}}><span>{assetDrop.preview.frame} fr</span></div>}
        <div className="native-track-label">
          <div className="native-track-actions">
            <button className="native-track-toggle" data-kind={track.kind === 'audio' ? 'mute' : 'eye'} aria-label={`${track.name}を${track.enabled ? '無効' : '有効'}にする`}
              title={track.kind === 'audio' ? (track.enabled ? 'ミュート' : 'ミュート解除') : (track.enabled ? '非表示にする' : '表示する')}
              aria-pressed={track.kind === 'audio' ? !track.enabled : track.enabled} disabled={blocked}
              onClick={() => void submit({ type: 'set-track-enabled', trackId: track.id, enabled: !track.enabled })}>{track.kind === 'audio' ? 'M' : <Icon name={track.enabled ? 'eye' : 'eye-off'} size={14} />}</button>
          </div>
          <span className="native-track-name" title={track.name}>{track.name}</span>
          <div className="native-track-tools">
            {([-1, 1] as const).map(direction => {
              const sameKind = tracks.filter(t => t.kind === track.kind), neighbor = sameKind[sameKind.findIndex(t => t.id === track.id) + direction];
              return <button key={direction} className="native-track-tool" disabled={blocked||!neighbor} aria-label={`${track.name}を${direction === -1 ? '上' : '下'}へ移動`} title={direction === -1 ? '上へ移動' : '下へ移動'} onClick={() => {
                if (neighbor) void submit({ type: 'move-track', trackId: track.id, index: doc.tracks.findIndex(t => t.id === neighbor.id) });
              }}><Icon name={direction === -1 ? 'arrow-up' : 'arrow-down'} size={13} /></button>;
            })}
            <button ref={colorMenu===track.id?colorMenuDot:undefined} className="native-track-tool native-track-color" aria-label={`${track.name}の色`} aria-haspopup="menu" aria-expanded={colorMenu===track.id} title="トラックの色"
              onClick={event=>{event.stopPropagation();
                // 最下トラックでは .native-timeline（overflow:auto）に切られるので、入らないときは上へ開く（M-7）。
                const rect=event.currentTarget.getBoundingClientRect(),box=scroller.current?.getBoundingClientRect();
                setColorMenuUp(!!box&&rect.bottom+COLOR_MENU_HEIGHT>box.bottom&&rect.top-COLOR_MENU_HEIGHT>=box.top);
                setColorMenu(open=>open===track.id?null:track.id);}}><i className="native-track-color-dot" aria-hidden="true"/></button>
            {colorMenu===track.id&&<div ref={colorMenuHost} className="native-track-color-menu" data-drop={colorMenuUp?'up':undefined} role="menu" aria-label={`${track.name}の色`} onPointerDown={event=>event.stopPropagation()}
              onKeyDown={event=>{
                // 矢印・Space・Enter はワークスペースのコマ送り／再生へ流さない（NativeAddBar.tsx:31 と同じ作法）
                event.stopPropagation();
                // 変換中の Esc は変換の取り消しに譲る（I-8 と同じガード）。
                if(isEscape(event.nativeEvent)){setColorMenu(null);(event.currentTarget.previousElementSibling as HTMLElement|null)?.focus();return;}
                const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^=menuitem]')];const index=items.indexOf(document.activeElement as HTMLButtonElement);
                const step=event.key==='ArrowRight'||event.key==='ArrowDown'?1:event.key==='ArrowLeft'||event.key==='ArrowUp'?-1:0;
                if(step){event.preventDefault();items[(index+step+items.length)%items.length]?.focus();}
              }}>
              {TRACK_ACCENTS.map(accent=><button key={accent.token} type="button" role="menuitemradio" aria-checked={trackColors[track.id]===accent.token} aria-label={accent.label} title={accent.label}
                style={{'--c':`var(${accent.token})`} as CSSProperties} onClick={()=>{setTrackColor(track.id,accent.token);setColorMenu(null);}}/>)}
              <button type="button" role="menuitem" className="btn-ghost" onClick={()=>{setTrackColor(track.id,null);setColorMenu(null);}}>自動に戻す</button>
            </div>}
            <button className="native-track-delete btn-danger native-track-tool" aria-label={`${track.name}を削除`} title={doc.clips.some(c=>c.trackId===track.id)?'クリップを移動または削除して空にしてください':'空のトラックを削除（元に戻せます）'} disabled={blocked||doc.clips.some(c=>c.trackId===track.id)} onClick={()=>void submit({type:'remove-track',trackId:track.id})}><Icon name="x" size={13} /></button>
          </div>
          <div className="native-track-resizer" role="separator" tabIndex={0} aria-orientation="horizontal"
            aria-label={`${track.name}のトラック高さ`} aria-valuemin={MIN_TRACK_HEIGHT} aria-valuemax={MAX_INDIVIDUAL_TRACK_HEIGHT}
            aria-valuenow={rowHeights.get(track.id)} aria-valuetext={`${rowHeights.get(track.id)}ピクセル`}
            title="上下にドラッグでこのトラックの高さを調整。ダブルクリックで標準に戻す"
            onPointerDown={event=>{
              event.stopPropagation();
              const start=event.clientY,height=rowHeights.get(track.id)!,base=baseHeight(track);
              trackResize.start(event,move=>setScale(track.id,individualTrackHeight(height+move.clientY-start)/base));
            }}
            onPointerMove={trackResize.onPointerMove} onLostPointerCapture={trackResize.onLostPointerCapture}
            onDoubleClick={event=>{event.stopPropagation();setScale(track.id,null);}}
            onKeyDown={event=>{
              if(!['ArrowUp','ArrowDown','Home','Enter'].includes(event.key))return;
              event.preventDefault();event.stopPropagation();
              if(event.key==='Home'||event.key==='Enter')setScale(track.id,null);
              else setScale(track.id,individualTrackHeight(rowHeights.get(track.id)!+(event.key==='ArrowDown'?1:-1)*(event.shiftKey?20:4))/baseHeight(track));
            }}/>
        </div>
        {finishMap&&visibleTracks.has(track.id)&&<NativeArchivedMedia document={doc} projectId={projectId} map={finishMap} trackId={track.id} pixels={pixels} scrollLeft={view.left} viewportWidth={view.width} height={rowHeights.get(track.id)!} gain={waveformGain(waveform)}/>}
        {track.id===cutTrackId&&finishCutRow}
        {(()=>{
          const trackClips=doc.clips.filter(c=>c.trackId===track.id);
          // 字幕（telop だけ）のトラックに限る。映像（フィルムストリップ）・音声（波形）・混在は常にクリップ描画(Codex 指摘 5)。
          const captionOnly=trackClips.length>0&&trackClips.every(c=>c.content.kind==='telop');
          if(captionOnly&&!finishMap&&!ghost&&!selected.some(id=>trackClips.some(c=>c.id===id))&&laneModes.get(track.id)==='density')
            return <NativeDensityLane clips={trackClips} pixels={pixels} offset={TRACK_LABEL_WIDTH} height={rowHeights.get(track.id)!}/>;
          return trackClips.map(clip => {
          const dragging = ghost?.ids?.includes(clip.id), delta = dragging ? ghost!.delta : 0;
          const start = clip.startFrame + (dragging && ghost!.type !== 'end' ? delta : 0);
          const duration = clip.durationFrames + (dragging && ghost!.type === 'end' ? delta : dragging && ghost!.type === 'start' ? -delta : 0);
          if(finishMap){
            const pieces=displayPieces(start,start+duration),first=pieces[0],last=pieces.at(-1);
            if(!first||!last)return null;
            const left=first.displayStart,span=last.displayEnd-left;
            const originalPieces=displayPieces(clip.startFrame,clipEnd(clip)),originalFirst=originalPieces[0]??first,originalLast=originalPieces.at(-1)??last;
            const startWidth=clipHandleWidth(Math.max(3,(originalFirst.displayEnd-originalFirst.displayStart)*pixels),7),endWidth=clipHandleWidth(Math.max(3,(originalLast.displayEnd-originalLast.displayStart)*pixels),7);
            return <div key={clip.id} className="native-clip-pieces" role="button" tabIndex={0} aria-label={`${clip.name} ${clip.startFrame}〜${clipEnd(clip)}フレーム`} aria-pressed={selected.includes(clip.id)} data-native-clip-id={clip.id}
              style={{left:TRACK_LABEL_WIDTH+left*pixels,width:Math.max(3,span*pixels),opacity:dragging?0.7:undefined}} onPointerDown={event=>startClip(event,clip)} onKeyDown={event=>{if(event.key==='Enter')onSelect([clip.id]);}}>
              {pieces.map((piece,index)=>{
                const length=piece.endFrame-piece.startFrame,wave=clip.content.kind==='audio'&&visibleTracks.has(track.id)?waveformViewport(piece.displayStart,length,pixels,view.left,view.width):null;
                return <div key={index} className={`native-clip native-clip-${kindName(clip)} ${selected.includes(clip.id)?'is-selected':''} ${!track.enabled?'is-muted':''}`} data-native-display-start={piece.displayStart} data-native-completion-start={piece.startFrame}
                  {...(Math.max(3,length*pixels)<NARROW_CLIP_BELOW?{'data-narrow':'true'}:{})}
                  style={{left:(piece.displayStart-left)*pixels,width:Math.max(3,length*pixels)}}>
                  {clip.content.kind==='video'&&visibleTracks.has(track.id)&&<NativeFilmstrip document={doc} projectId={projectId} clip={clip} sourceOffsetFrames={piece.startFrame-start+(dragging&&ghost!.type==='start'?delta:0)} displayStartFrame={piece.displayStart} displayDuration={length} pixelsPerFrame={pixels} scrollLeft={view.left} viewportWidth={view.width}/>}
                  <span className="native-clip-name">{clip.linkGroupId&&<span className="native-clip-link"><Icon name="link" size={12}/></span>}{clip.name}</span>
                  {wave&&audioPlan&&<NativeWaveform projectId={projectId} clip={clip} plan={audioPlan} viewport={wave} height={Math.max(8,Math.min(rowHeights.get(track.id)!-18,Math.round(heights.waveform*rowHeights.get(track.id)!/heights.audio)))} displayGain={waveformGain(waveform)} sourceOffsetFrames={piece.startFrame-start+(dragging&&ghost!.type==='start'?delta:0)} displayStartFrame={piece.startFrame} displayDuration={length}/>}
                </div>;
              })}
              <button type="button" className="native-trim native-trim-start" style={{width:startWidth??undefined,display:startWidth===null?'none':undefined}} disabled={blocked} aria-label={`${clip.name}の開始位置を調整`} onPointerDown={event=>startClip(event,clip,'start')} onKeyDown={event=>trimKey(event,clip,'start')}/>
              <button type="button" className="native-trim native-trim-end" style={{width:endWidth??undefined,display:endWidth===null?'none':undefined}} disabled={blocked} aria-label={`${clip.name}の終了位置を調整`} onPointerDown={event=>startClip(event,clip,'end')} onKeyDown={event=>trimKey(event,clip,'end')}/>
            </div>;
          }
          // A captured edge remains mounted while its live width shrinks; evaluate the next hit area after commit.
          const handleWidth=clipHandleWidth(Math.max(3,clip.durationFrames*pixels),7);
          const visibleWave=clip.content.kind==='audio'&&visibleTracks.has(track.id)?waveformViewport(start,duration,pixels,view.left,view.width):null;
          return <div key={clip.id} role="button" tabIndex={0} aria-label={`${clip.name} ${clip.startFrame}〜${clipEnd(clip)}フレーム`} aria-pressed={selected.includes(clip.id)}
            data-native-clip-id={clip.id} className={`native-clip native-clip-${kindName(clip)} ${selected.includes(clip.id) ? 'is-selected' : ''} ${!track.enabled ? 'is-muted' : ''}`}
            {...(Math.max(3,duration*pixels)<NARROW_CLIP_BELOW?{'data-narrow':'true'}:{})}
            style={{ left: TRACK_LABEL_WIDTH + start * pixels, width: Math.max(3, duration * pixels), ...(dragging ? { opacity: .7 } : {}) } as CSSProperties}
            onPointerDown={event => startClip(event, clip)} onKeyDown={event => { if (event.key === 'Enter') onSelect([clip.id]); }}>
            {clip.content.kind==='video'&&visibleTracks.has(track.id)&&<NativeFilmstrip document={doc} projectId={projectId} clip={clip} sourceOffsetFrames={dragging&&ghost!.type==='start'?delta:0} displayStartFrame={start} displayDuration={duration} pixelsPerFrame={pixels} scrollLeft={view.left} viewportWidth={view.width}/>}
            <button type="button" className="native-trim native-trim-start" style={{width:handleWidth??undefined,display:handleWidth===null?'none':undefined}} disabled={blocked}
              aria-label={`${clip.name}の開始位置を調整`} onPointerDown={event => startClip(event, clip, 'start')} onKeyDown={event=>trimKey(event,clip,'start')} />
            <span className="native-clip-name">{clip.linkGroupId&&<span className="native-clip-link"><Icon name="link" size={12}/></span>}{clip.name}</span>
            {visibleWave&&audioPlan&&<NativeWaveform projectId={projectId} clip={clip} plan={audioPlan} viewport={visibleWave} height={Math.max(8,Math.min(rowHeights.get(track.id)!-18,Math.round(heights.waveform*rowHeights.get(track.id)!/heights.audio)))} displayGain={waveformGain(waveform)} sourceOffsetFrames={dragging&&ghost!.type==='start'?delta:0} displayStartFrame={start} displayDuration={duration}/>}
            <button type="button" className="native-trim native-trim-end" style={{width:handleWidth??undefined,display:handleWidth===null?'none':undefined}} disabled={blocked}
              aria-label={`${clip.name}の終了位置を調整`} onPointerDown={event => startClip(event, clip, 'end')} onKeyDown={event=>trimKey(event,clip,'end')} />
          </div>;
        });})()}
        {onSceneFade&&fadeJoins.filter(j=>j.target.trackId===track.id).map(join=><button key={sceneFadeTargetKey(join.target)} className="native-scene-fade-join" aria-label={`${join.label} のフェードを設定`} style={{left:TRACK_LABEL_WIDTH+displayFrame(join.frame)*pixels}} onPointerDown={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()} onClick={()=>onSceneFade(join.target)}><Icon name="fade-handle" size={12} filled/></button>)}
      </div>)}
      {!tracks.length && <div className="native-timeline-empty">素材を追加すると、ここで編集できます。</div>}
      {playhead!==null&&<div className="native-playhead" style={{ left: TRACK_LABEL_WIDTH + playhead * pixels }}><span /></div>}
      {ghost&&ghost.moved&&ghost.type!=='range'&&<NativeDragTooltip
        frame={ghost.type==='move'?ghost.clip!.startFrame+ghost.delta:ghost.frame+ghost.delta}
        originFrame={ghost.type==='move'?ghost.clip!.startFrame:ghost.frame} fps={fps}
        left={TRACK_LABEL_WIDTH+displayFrame((ghost.type==='move'?ghost.clip!.startFrame:ghost.frame)+ghost.delta)*pixels}
        top={(ghost.targetTrack?trackTops.get(ghost.targetTrack):undefined)??36}/>}
      {ghost&&ghost.moved&&ghost.snapFrame!==undefined&&<div className="native-snapline" style={{left:TRACK_LABEL_WIDTH+displayFrame(ghost.snapFrame)*pixels}}>
        <span>{ghost.snapLabel}</span></div>}
      {ripplePlan?.kind==='close'&&(()=>{
        const width=Math.max(1,(displayFrame(ripplePlan.endFrame,'before')-displayFrame(ripplePlan.startFrame))*pixels);
        // 細い帯では見出しが右へはみ出し、右隣クリップの名前に見えてしまう。右端に揃えて左へ逃がす。
        return <div className={`native-ripple-ghost-close${width<180?' is-narrow':''}`}
          style={{left:TRACK_LABEL_WIDTH+displayFrame(ripplePlan.startFrame)*pixels,width}}>
          <span>この範囲を全トラックから取り除く</span></div>;
      })()}
      {ripplePush&&<div className="native-ripple-ghost-push"
        style={{left:TRACK_LABEL_WIDTH+displayFrame(ripplePush.atFrame)*pixels,
          width:Math.max(1,(displayFrame(ripplePush.atFrame+ripplePush.delta,'before')-displayFrame(ripplePush.atFrame))*pixels)}}>
        <span>ここから右へ押し出す</span></div>}
      {ripplePlan?.kind==='clamp'&&<div className="native-snapline" style={{left:TRACK_LABEL_WIDTH+displayFrame(ripplePlan.frame)*pixels}}>
        <span>{ripplePlan.reason ? RIPPLE_CLAMP_GHOST[ripplePlan.reason] : 'ここで止まる'}</span></div>}
      {ripplePlan?.kind==='join'&&rippleRight&&<div className="native-ripple-ghost-join"
        style={{left:TRACK_LABEL_WIDTH+displayFrame(rippleRight.startFrame)*pixels}}>{rippleJoinLabel}</div>}
      {shownRange && shownRange.endFrame > shownRange.startFrame && (()=>{
        const pieces=displayPieces(shownRange.startFrame,shownRange.endFrame);
        const middle=(shownRange.startFrame+shownRange.endFrame)/2;
        // ホストは1つのピースの子として置く必要があるため、境界を含むピースへマウントする。
        // 見つからない場合（境界が隙間に落ちる等）は先頭ピースへフォールバックする — 水平位置自体は
        // 下の bandMidDisplay が帯全体の中点を計算するので、フォールバックの選択はズレを生まない。
        const hostIndex=Math.max(0,pieces.findIndex(piece=>piece.startFrame<=middle&&middle<=piece.endFrame));
        const hostPiece=pieces[hostIndex];
        // ボタンの水平位置は帯全体（複数ピースに割れていても連続している表示座標）の中点。
        // ピース単体の 50% ではなく、先頭ピースの開始〜末尾ピースの終了の中間を使う。
        const bandMidDisplay=pieces.length?(pieces[0]!.displayStart+pieces.at(-1)!.displayEnd)/2:middle;
        const hostLeft=hostPiece?(bandMidDisplay-hostPiece.displayStart)*pixels:undefined;
        const rowTop=shownRange.trackId?trackTops.get(shownRange.trackId):undefined;
        return pieces.map((piece,index)=><div key={index} className="native-range" style={{ left: TRACK_LABEL_WIDTH + piece.displayStart * pixels, width: (piece.displayEnd-piece.displayStart) * pixels }}>
          {index===hostIndex&&!draftRange&&range&&<div className="native-range-cut-host" style={{top:rowTop===undefined?undefined:`${rowTop-36-30}px`,left:hostLeft===undefined?undefined:`${hostLeft}px`}}>
            <button className="native-range-cut" disabled={blocked}
              onPointerDown={event => event.stopPropagation()} onClick={() => {
              void submit({ type: 'ripple-delete', startFrame: range.startFrame, endFrame: range.endFrame }).then(ok => { if (ok) { onSeek(range.startFrame); onRange(null); } });
            }}>✂ カット <span>{((range.endFrame - range.startFrame) / fps).toFixed(2)}秒</span></button>
            <span className="native-range-hint">Delete でカット・Esc で解除</span>
          </div>}
        </div>);
      })()}
    </div>
  </div>;
});
