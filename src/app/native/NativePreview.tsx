import { cloneElement, forwardRef, isValidElement, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,type ReactElement,type ReactNode,type PointerEvent as ReactPointerEvent } from 'react';
import {lowStage} from './layoutBudget';
import {TaskProgress} from '../components/TaskProgress';
import { Icon } from '../Icon';
import { playbackRateLabel } from '../preview/transport';
import type { ClipVisual, SequenceDocument } from '../../core/sequence/model';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { timeNumber } from '../../core/sequence/time';
import { NativePreviewBridge } from '../../preview/native/previewBridge';
import { NativeAudioTransport } from '../../preview/native/audioTransport';
import { audioPlaybackPlan, validatePlaybackRate } from '../../preview/native/audioPlaybackPlan';
import { audioPlanIdentity } from '../../preview/native/audioPlanIdentity';
import { pcmKey, type PreparedPcm } from '../../preview/native/audioMixer';
import type {RenderedSceneGeometry} from '../../preview/native/renderGeometry';
import { PreviewResourceError, previewFailure, type NativePreviewFailure } from '../../preview/native/previewError';
import type { LegacyMeasurementReader } from '../../preview/native/legacyMeasurement';
import {NativePreviewManipulation,type NativeManipulationHandle,type NativeManipulationBindings} from './NativePreviewManipulation';
import {shuttleAction} from './shuttleKeys';
import type {ShapeKind} from '../../core/types';
import {shapeSvgGeometry} from '../../core/shapeStyle';
import {angleArcPath,trianglePoints} from '../../core/shapeGeometry';
import {NativeShapeToolbar} from './NativeShapeToolbar';
import {beginShapeDraft,normalizeStagePoint,releaseShapeDraft,shapeDraftChip,shapeDraftData,updateShapeDraft,DEFAULT_SHAPE_BOX,type ShapeData,type ShapeDraft} from './shapeDraft';
import {safeAreaBoxes} from './safeArea';

export interface NativePreviewHandle { play(): Promise<void>; pause(): void; seek(frame: number): Promise<void>; seekBy(delta: number): Promise<void>; setPlaybackRate(rate:number):void; isPlaybackPending():boolean; toggle(): void; frame(): number;flushManipulation():Promise<boolean>;cancelManipulation():void;measureLegacy:LegacyMeasurementReader; shuttle(key: 'j' | 'l', shift: boolean, maxRate?: 4 | 8): void; stop(): void }
export const NATIVE_RESTORATION_TIMEOUT_MS=10_000;
export interface NativeVisualPreview {documentId:string;revision:number;clipId:string;visual:ClipVisual}
/** 図形の描画モード。ツールバーの選択と、完成した 1 件の挿入だけをワークスペースへ返す。 */
export interface NativeShapeDrawBindings {
  kind: ShapeKind|null;
  disabled: boolean;
  color: string;
  onPick(kind: ShapeKind|null): void;
  /** 完成した図形データを 1 コマンドで insert する。失敗時は false。 */
  onComplete(data: ShapeData): Promise<boolean>;
}
export interface NativePreviewProps { projectId: string; sessionId?: string; document: SequenceDocument; onFrame(frame: number): void; bypassLut: boolean; initialFrame?: number; onPlay?():void; monitor?:'プログラム'|'ソース'|'変更前'|'変更案'|'カット込み確認';manipulation?:NativeManipulationBindings; legacyContext?: string; onError?(failure: NativePreviewFailure): void;
  onRendered?(frame: number, geometry: RenderedSceneGeometry | null): void;
  onPlaybackChanged?(playing: boolean): void;
  onEnded?(): void;
  /** トランスポートの J / L ボタン。ワークスペースが設定の最高速度を添えて handle.shuttle を呼ぶ。 */
  onShuttle?(key: 'j' | 'l'): void;
  /** legacy エディタ（panels/Preview.tsx → EditorLegacyPreview）向けの制御用。native ワークスペースは渡さず、handle.shuttle / stop で速度を扱う。 */
  playbackRate?: number;
  monitorControls?:ReactNode;
  addBar?:ReactNode;
  notice?:ReactNode;
  onFitPanels?():void;
  visualPreview?:NativeVisualPreview|null;
  /** 渡された間だけ図形ツールバーを出し、プレビュー上のドラッグ描画を受け付ける。 */
  shapeDraw?:NativeShapeDrawBindings;
  /** プレビューへセーフエリア枠を重ねるか（設定 `EditorPrefs.safeArea`）。既定 false。 */
  safeArea?: boolean;
}
export const NativePreview = forwardRef<NativePreviewHandle, NativePreviewProps>(function NativePreview({ projectId, sessionId, document: doc, onFrame, bypassLut, initialFrame = 0, onPlay, monitor='プログラム',manipulation,legacyContext,onError,onRendered,onPlaybackChanged,onEnded,onShuttle,playbackRate,monitorControls,addBar,notice,onFitPanels,visualPreview,shapeDraw,safeArea }, ref) {
  const stage = useRef<HTMLDivElement>(null), frameBox = useRef<HTMLDivElement>(null), box = useRef<HTMLDivElement>(null), renderer = useRef<NativePreviewBridge | null>(null);
  const current = useRef(initialFrame), transport = useRef<NativeAudioTransport | null>(null), context = useRef<AudioContext | null>(null);
  const [frame, setFrame] = useState(initialFrame), [playing, setPlaying] = useState(false), [scale, setScale] = useState(.5), [error, setError] = useState<string | null>(null);
  const [surface, setSurface] = useState<{ x: number; y: number } | null>(null);
  const [ready, setReadyState] = useState(false), playingRef = useRef(false), rendered = useRef(-1), onFrameRef = useRef(onFrame);
  const [recoveryAvailable,setRecoveryAvailableState]=useState(false);
  const [preparing,setPreparing]=useState<string|null>(null);
  const [showFrameLoading,setShowFrameLoading]=useState(true);
  useEffect(()=>{
    if(ready){setShowFrameLoading(false);return;}
    if(rendered.current<0){setShowFrameLoading(true);return;}
    // Keep the last completed picture during short plan updates, but show genuine waits.
    const timer=setTimeout(()=>setShowFrameLoading(true),180);
    return()=>clearTimeout(timer);
  },[ready]);
  const readyRef=useRef(false),recoveryAvailableRef=useRef(false);
  // A completed draw may synchronously ask its host to resume. The imperative
  // gate must change before callbacks, independently of React's next commit.
  const setReady=(value:boolean)=>{readyRef.current=value;setReadyState(value);};
  const setRecoveryAvailable=(value:boolean)=>{recoveryAvailableRef.current=value;setRecoveryAvailableState(value);};
  onFrameRef.current = onFrame;
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  const notifications = useRef({onRendered,onPlaybackChanged,onEnded}); notifications.current = {onRendered,onPlaybackChanged,onEnded};
  // M-1: legacy（panels/Preview.tsx）は playbackRate を prop で制御する。自然終了で内部だけ 1 に戻すと
  //       App 側の値と食い違い、以後「再生」ボタンが表示 4×・実際 1× になる。native 経路（prop 無し）だけ戻す。
  const controlledRate = useRef(playbackRate); controlledRate.current = playbackRate;
  const version = useRef(0), planRef = useRef<ScenePlan | null>(null), pcm = useRef(new Map<string, PreparedPcm>());
  const planSession = useRef(sessionId);
  const bypass = useRef(bypassLut); bypass.current = bypassLut;
  const drawing = useRef(0),failureVersion=useRef(0);
  const latestDrawing=useRef<Promise<RenderedSceneGeometry|undefined>|null>(null);
  const playbackDrawing=useRef<Promise<RenderedSceneGeometry|undefined>|null>(null);
  const manipulationHandle=useRef<NativeManipulationHandle>(null),temporary=useRef<ScenePlan|null>(null);
  const inspectorPreview=useRef<ScenePlan|null>(null);
  const [geometry,setGeometry]=useState<RenderedSceneGeometry|null>(null);
  const [draft,setDraft]=useState<ShapeDraft|null>(null);
  const draftRef=useRef<ShapeDraft|null>(null);draftRef.current=draft;
  const shapeDrawRef=useRef(shapeDraw);shapeDrawRef.current=shapeDraw;
  const drawKind=shapeDraw?.kind??null;
  useEffect(()=>{setDraft(null);},[drawKind,projectId]);
  const stageRect=()=>{
    const value=frameBox.current?.getBoundingClientRect();
    return value&&value.width>0&&value.height>0?{left:value.left,top:value.top,width:value.width,height:value.height}:null;
  };
  const drawDown=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(!shapeDraw||!drawKind||shapeDraw.disabled||event.button!==0)return;
    const rect=stageRect();if(!rect)return;
    event.preventDefault();event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const at=normalizeStagePoint({x:event.clientX,y:event.clientY},rect);
    // レビュー Minor 6: 描き始めた瞬間の frame を startFrame にするため、下書き開始（新規のみ・
    // 分度器の端点 B 確定クリックは除く）で既存ジェスチャーと同じく一時停止する。
    // 再生中または準備中のときだけ pause() を呼び、停止中には何もしない。
    if(!(draftRef.current&&draftRef.current.stage==='vertexB')&&(playingRef.current||preparation.current))pause();
    setDraft(current=>current&&current.stage==='vertexB'?updateShapeDraft(current,at):beginShapeDraft(drawKind,at));
  };
  const drawMove=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const current=draftRef.current,rect=stageRect();if(!current||!rect)return;
    // レビュー Important 1: ボタンをすべて離した状態で pointermove が来るのは、取りこぼした
    // pointerup/pointercancel の後始末。既存ジェスチャーの pointercancel 購読に倣い下書きを捨てる。
    if(current.stage==='drag'&&event.buttons===0){setDraft(null);return;}
    setDraft(updateShapeDraft(current,normalizeStagePoint({x:event.clientX,y:event.clientY},rect)));
  };
  const drawUp=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button!==0)return; // レビュー Minor 7: 主ボタン以外の pointerup では完成させない
    const current=draftRef.current,rect=stageRect(),bindings=shapeDrawRef.current;
    if(!current||!rect||!bindings)return;
    const released=releaseShapeDraft(current,normalizeStagePoint({x:event.clientX,y:event.clientY},rect),{width:doc.resolution.width,height:doc.resolution.height});
    if(!released.done){setDraft(released.draft);return;}
    setDraft(null);
    void bindings.onComplete(shapeDraftData(released.draft,bindings.color)).catch(()=>undefined);
  };
  const drawCancel=()=>setDraft(null); // レビュー Important 1: pointercancel で下書きを破棄（ツール選択は維持）
  // 下書きの Esc は操作オーバーレイの Esc と別経路。下書きがある間だけ横取りする。
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||!draftRef.current)return;
      event.preventDefault();event.stopImmediatePropagation();
      setDraft(null);shapeDrawRef.current?.onPick(null);
    };
    window.addEventListener('keydown',key,true);
    return ()=>window.removeEventListener('keydown',key,true);
  },[]);
  // レビュー Important 1: 既存ジェスチャー（NativePreviewManipulation）と同じく、画面から
  // フォーカスが離れたら下書きを破棄する（ツール選択は維持）。
  useEffect(()=>{
    const onBlur=()=>{if(draftRef.current)setDraft(null);};
    window.addEventListener('blur',onBlur);
    return ()=>window.removeEventListener('blur',onBlur);
  },[]);
  const preparation = useRef<AbortController | null>(null);
  const playbackRateRef=useRef(playbackRate ?? 1);
  const [rate,setRate]=useState(playbackRate ?? 1);
  const activity = useRef(0);
  // Relative input follows the latest requested position; frame()/geometry stay
  // tied to completed pixels. Object identity prevents old completion cleanup
  // from discarding a newer request, including synchronous pause reentry.
  const seekIntent=useRef<{frame:number}|null>(null);
  const audioVersion=useRef(0);
  const drawFrame = async (target: number) => {
    const plan = inspectorPreview.current??temporary.current??planRef.current, painter = renderer.current; if (!plan || !painter || plan.document.sequenceEndFrame === 0) return;
    const generation = version.current, request = ++drawing.current,errorAtStart=failureVersion.current, notify = notifications.current;
    target = Math.max(0, Math.min(plan.document.sequenceEndFrame - 1, target));
    const isCurrent = () => generation === version.current && request === drawing.current;
    let geometry:RenderedSceneGeometry|undefined;
    try { geometry=await painter.render(plan, target, bypass.current, isCurrent); }
    catch (error) { if (isCurrent()) throw error; return; }
    if (!isCurrent()) return;
    seekIntent.current=null;
    rendered.current = target; current.current = target; setFrame(target); setReady(true);
    if(errorAtStart===failureVersion.current)setError(null);
    setRecoveryAvailable(false);setGeometry(geometry??null);
    notify.onRendered?.(target, geometry??null);
    if (isCurrent()) onFrameRef.current(target);
    return geometry;
  };
  const show=(target:number)=>{const result=drawFrame(target);latestDrawing.current=result;return result;};
  const pause = () => { activity.current++; audioVersion.current++; preparation.current?.abort(); preparation.current = null; setPreparing(null); playingRef.current = false; transport.current?.pause(); setPlaying(false); notifications.current.onPlaybackChanged?.(false); };
  const fail = (error: unknown) => {
    const failure = previewFailure(error), generation = version.current, notify = onErrorRef.current;
    failureVersion.current++; seekIntent.current=null; pause();
    // Pausing can synchronously replace the document/lease and its error host.
    if (generation !== version.current) return;
    setError(failure.message); notify?.(failure);
  };
  const seek = async (target: number): Promise<void> => {
    manipulationHandle.current?.cancel('再生位置を変えたため、操作を取り消しました。');
    const operation = activity.current + 1;
    pause();
    // A pause subscriber may issue a newer seek/play synchronously.
    if (activity.current !== operation) return;
    const plan = planRef.current; if (!plan || plan.document.sequenceEndFrame === 0) return;
    target = Math.max(0, Math.min(plan.document.sequenceEndFrame - 1, Math.round(target)));
    const intent={frame:target};seekIntent.current=intent;
    try {
      transport.current?.seek(Math.round(target / timeNumber(plan.document.fps) * transport.current.context.sampleRate));
      await show(target).catch(fail);
    } finally { if(seekIntent.current===intent)seekIntent.current=null; }
  };
  const seekBy=(delta:number)=>seek((seekIntent.current?.frame??current.current)+delta);
  const abandonPainter=(painter:NativePreviewBridge|null,message:string)=>{
    if(renderer.current!==painter)return;
    // Discard the FIFO as well as its generation so stalled fonts/decode cannot
    // keep a later retry behind an abandoned drawing request.
    drawing.current++;painter?.dispose();latestDrawing.current=null;playbackDrawing.current=null;temporary.current=null;
    renderer.current=stage.current?new NativePreviewBridge(stage.current,projectId,legacyContext):null;
    setGeometry(null);setRecoveryAvailable(true);fail(new Error(message));
  };
  const [fullscreen,setFullscreen]=useState(false);
  const [reloading,setReloading]=useState(false);
  useEffect(()=>{
    const change=()=>setFullscreen(document.fullscreenElement===box.current);
    document.addEventListener('fullscreenchange',change);return ()=>document.removeEventListener('fullscreenchange',change);
  },[]);
  const toggleFullscreen=()=>{
    const element=box.current;if(!element)return;
    // レビュー I3: requestFullscreen は Safari の一部や埋め込み環境で未実装なことがあり、
    // 呼び出すと同期 TypeError で catch() に落ちない。事前に存在確認し、念のため try/catch でも囲む。
    if(document.fullscreenElement===element){void document.exitFullscreen().catch(()=>undefined);return;}
    if(typeof element.requestFullscreen!=='function'){setError('全画面にできませんでした。ブラウザの設定を確認してください。');return;}
    try{void element.requestFullscreen().catch(()=>setError('全画面にできませんでした。ブラウザの設定を確認してください。'));}
    catch{setError('全画面にできませんでした。ブラウザの設定を確認してください。');}
  };
  const reloadPreview=async()=>{
    const painter=renderer.current;if(!painter||reloading)return;
    const at=current.current,wasPlaying=playingRef.current||preparation.current!==null;
    setReloading(true);pause();manipulationHandle.current?.cancel('再読み込みのため、操作を取り消しました。');
    try{
      drawing.current++;latestDrawing.current=null;playbackDrawing.current=null;temporary.current=null;inspectorPreview.current=null;
      await painter.reload();
      if(renderer.current!==painter)return;
      setReady(false);setGeometry(null);
      await show(at);
      setError(null);setRecoveryAvailable(false);
      if(wasPlaying)await play();
    }catch(error){
      // 復元に失敗しても保存はできる。次の一手をそのまま出す。
      setRecoveryAvailable(true);
      fail(new Error(`プレビューを再読み込みできませんでした（表示のみ・編集内容は保たれています）。位置を指定し直すか、再生で再試行してください。 ${error instanceof Error?error.message:''}`.trim()));
    // レビュー I4: renderer が別ペインターへ差し替わっていても、この reloadPreview を
    // 起動した側の reloading フラグ（＝このボタンの disabled）は必ず解除する。
    // painter 一致条件を付けると、途中で projectId が変わった時にボタンが押せないまま残る。
    }finally{setReloading(false);}
  };
  const play = async () => {
    if (playingRef.current || preparation.current || !planRef.current || (!readyRef.current&&!recoveryAvailableRef.current)) return;
    const pendingSeek=seekIntent.current?latestDrawing.current:null;
    const painter=renderer.current;
    const request = new AbortController(); preparation.current = request; setPreparing('再生を準備しています…'); activity.current++;
    const audioOwner=++audioVersion.current;
    const isCurrent=()=>audioOwner===audioVersion.current&&!request.signal.aborted&&renderer.current===painter;
    try {
    // A subtitle/timeline seek can still be decoding when Play is pressed.
    // Keep pixels and the audio start on that requested position; a newer seek
    // or pause retires this playback request through the existing owner check.
    if(pendingSeek){
      await new Promise<void>((resolve,reject)=>{
        let timeout:ReturnType<typeof setTimeout>|undefined;
        const cleanup=()=>{if(timeout!==undefined)clearTimeout(timeout);request.signal.removeEventListener('abort',cancel);};
        const cancel=()=>{cleanup();resolve();};
        request.signal.addEventListener('abort',cancel,{once:true});
        pendingSeek.then(()=>{cleanup();resolve();},error=>{cleanup();reject(error);});
        timeout=setTimeout(()=>{
          cleanup();const message='再生位置の表示がタイムアウトしました。位置を指定し直すか、再生で再試行してください。';
          if(isCurrent())abandonPainter(painter,message);
          reject(new Error(message));
        },NATIVE_RESTORATION_TIMEOUT_MS);
      });
      if(!isCurrent())return;
    }
    if(recoveryAvailableRef.current){await renderManipulation(null,true);if(!isCurrent())return;}
    if(manipulationHandle.current&&!(await manipulationHandle.current.restore()))return;
    if(!isCurrent()||!planRef.current)return;
    onPlay?.();
    if(!isCurrent())return;
    const plan = planRef.current, playbackRate=playbackRateRef.current;
    const audioPlan=audioPlaybackPlan(plan,playbackRate);
    const audio = context.current ?? new AudioContext({ sampleRate: 48000 }); context.current = audio;
    await audio.resume();
    if (!isCurrent()) return;
    for (const clip of audioPlan.audibleClips) {
      const content = clip.content; if (content.kind !== 'audio') continue;
      const key = pcmKey(content.assetId, content.streamIndex, content.rate); if (pcm.current.has(key)) continue;
      setPreparing('音声を準備しています…');
      const params = new URLSearchParams({ id: projectId, asset: content.assetId, stream: String(content.streamIndex), rateNum: String(content.rate.num), rateDen: String(content.rate.den), ...(legacyContext ? { context: legacyContext } : {}) });
      const response = await fetch(`${legacyContext ? '/api/legacy-preview/audio/info' : '/api/sequence/audio'}?${params}`, { signal: request.signal });
      if (!isCurrent()) return;
      if (!response.ok) throw new PreviewResourceError('音声を準備できません', response.status, 'pcm', !!legacyContext);
      const prepared = await response.json();
      if (!isCurrent()) return;
      setPreparing('音声を読み込んでいます…');
      const raw = await fetch(prepared.url, { signal: request.signal }); if (!isCurrent()) return;
      if (!raw.ok) throw new PreviewResourceError('準備した音声を読み込めません', raw.status, 'pcm', !!legacyContext);
      const samples = new Float32Array(await raw.arrayBuffer());
      if (!isCurrent()) return;
      if (samples.length !== prepared.sampleCount * 2) throw new Error('音声の長さが一致しません');
      const left = new Float32Array(prepared.sampleCount), right = new Float32Array(prepared.sampleCount);
      for (let i = 0; i < left.length; i++) { left[i] = samples[i * 2]!; right[i] = samples[i * 2 + 1]!; }
      pcm.current.set(key, { assetId: content.assetId, streamIndex: content.streamIndex, rate: content.rate, sampleRate: prepared.sampleRate, channels: [left, right] });
    }
    if (!isCurrent()) return;
    setPreparing('再生を準備しています…');
    const startFrame=playbackRate>0&&current.current>=plan.document.sequenceEndFrame-1?0:
      playbackRate<0&&current.current<=0?plan.document.sequenceEndFrame-1:current.current;
    if(startFrame!==current.current){await show(startFrame);if(!isCurrent())return;}
    transport.current?.dispose(); transport.current = new NativeAudioTransport(audio, plan, pcm.current, error => { if (isCurrent()) fail(error); },playbackRate);
    transport.current.seek(Math.round(current.current / timeNumber(plan.document.fps) * audio.sampleRate));
    const active = transport.current;
    await active.play();
    if (!isCurrent()) { active.pause(); return; }
    playingRef.current = true; setPlaying(true); notifications.current.onPlaybackChanged?.(true);
    } catch (error) { if (isCurrent()) { fail(error); throw error; } }
    finally { if (preparation.current === request) {preparation.current = null;setPreparing(null);} }
  };
  const setPlaybackRate=(next:number)=>{
    validatePlaybackRate(next);
    if(next===playbackRateRef.current)return;
    const restart=playingRef.current||preparation.current!==null,operation=activity.current+1;
    playbackRateRef.current=next;setRate(next);pause();
    if(restart&&operation===activity.current)void play().catch(()=>undefined);
  };
  // legacy エディタ（panels/Preview.tsx）向け。値が与えられた時だけ追随する（native ワークスペースは渡さない）。
  useEffect(()=>{ if(playbackRate!==undefined) setPlaybackRate(playbackRate); },[playbackRate]);
  /** ユーザーの停止（K・Space・再生ボタン・自然終了）。内部の pause と違い、速度を 1 に戻す。 */
  const stop=()=>{ if(controlledRate.current===undefined){playbackRateRef.current=1;setRate(1);} pause(); };
  /** J / L。準備中も「再生中」として段を上げる（準備中に連打しても 1 倍に落ちない）。 */
  const shuttle=(key:'j'|'l',shift:boolean,maxRate:4|8=8)=>{
    const action=shuttleAction({rate:playbackRateRef.current,playing:playingRef.current||preparation.current!==null,kHeld:false},key,shift,maxRate);
    if(action.kind!=='play')return;
    const wasIdle=!playingRef.current&&preparation.current===null;
    setPlaybackRate(action.rate);
    if(wasIdle)void play().catch(()=>undefined);
  };
  useImperativeHandle(ref, () => ({ play, pause, seek, seekBy, setPlaybackRate, isPlaybackPending:()=>preparation.current!==null, toggle: () => { if (playingRef.current || preparation.current) stop(); else void play().catch(()=>undefined); }, frame: () => current.current,
    measureLegacy:(kind,id)=>{const plan=planRef.current;return plan?renderer.current?.measureLegacy({documentId:plan.document.id,revision:plan.document.revision,frame:rendered.current,kind,id})??null:null;},
    flushManipulation:()=>manipulationHandle.current?.flush()??Promise.resolve(true),cancelManipulation:()=>manipulationHandle.current?.cancel(), shuttle, stop }));
  useEffect(() => {
    temporary.current=null;inspectorPreview.current=null;setRecoveryAvailable(false);setPreparing(null);
    if (!stage.current) return;
    const painter = new NativePreviewBridge(stage.current, projectId, legacyContext); renderer.current = painter;
    return () => { seekIntent.current=null; version.current++; preparation.current?.abort(); preparation.current = null; playingRef.current = false; renderer.current?.dispose(); renderer.current = null;planRef.current=null;latestDrawing.current=null;playbackDrawing.current=null;
      readyRef.current=false;recoveryAvailableRef.current=false;
      transport.current?.dispose(); void context.current?.close(); context.current = null; pcm.current.clear(); };
  }, [projectId, legacyContext]);
  useEffect(() => {
    // Revisions are immutable within a session. A disk reload starts a new session
    // and may replace the graph at the same revision (or restore an older one).
    if(planSession.current===sessionId&&planRef.current?.document.id===doc.id&&planRef.current.document.revision>=doc.revision)return;
    planSession.current=sessionId;
    temporary.current=null;inspectorPreview.current=null;
    const nextPlan=new ScenePlan(doc),previous=planRef.current;
    const keepAudio=previous?.document.id===doc.id&&(playingRef.current||preparation.current!==null)
      &&audioPlanIdentity(previous.document)===audioPlanIdentity(nextPlan.document);
    seekIntent.current=null; version.current++; setReady(false); setRecoveryAvailable(false);
    if(!keepAudio)pause();
    setError(null); planRef.current=nextPlan;
    if (doc.sequenceEndFrame > 0) void show(Math.max(0,Math.min(previous&&previous.document.id!==doc.id?initialFrame:current.current, doc.sequenceEndFrame - 1))).catch(fail);
    else { renderer.current?.clear(); current.current = 0; setFrame(0); }
  }, [doc, projectId, legacyContext, sessionId]);
  useEffect(()=>{
    const previous=inspectorPreview.current;
    inspectorPreview.current=null;
    if(visualPreview&&visualPreview.documentId===doc.id&&visualPreview.revision===doc.revision&&doc.clips.some(c=>c.id===visualPreview.clipId&&c.content.kind==='video')){
      const preview={...doc,clips:doc.clips.map(c=>c.id===visualPreview.clipId?{...c,visual:visualPreview.visual}:c)};
      inspectorPreview.current=new ScenePlan(preview);
      pause();manipulationHandle.current?.cancel();
    }
    if(previous||inspectorPreview.current)void show(current.current).catch(fail);
  },[visualPreview,doc,projectId,legacyContext]);
  const renderManipulation=async(document:SequenceDocument|null,isTemporary:boolean)=>{
    const painter=renderer.current;
    if(isTemporary)temporary.current=document?new ScenePlan(document):null;
    else if(document){temporary.current=null;planRef.current=new ScenePlan(document);}
    if(!document){const current=manipulation?.readDocument();if(current&&(current.id!==planRef.current?.document.id||current.revision!==planRef.current?.document.revision))planRef.current=new ScenePlan(current);}
    const draw=async()=>{
      let request=show(current.current),result=await request;
      if(document)return result;
      // A seek/LUT/revision render may supersede restoration. Its old undefined
      // result is not proof of restored pixels: follow the latest actual draw.
      while(renderer.current===painter&&latestDrawing.current&&request!==latestDrawing.current){
        request=latestDrawing.current;result=await request;
      }
      if(renderer.current!==painter)throw new Error('表示するプロジェクトが変わりました。');
      if(!result&&planRef.current?.document.sequenceEndFrame)throw new Error('確定済みの配置を復元できませんでした。');
      setRecoveryAvailable(false);return result;
    };
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      if(document)return await draw();
      return await Promise.race([draw(),new Promise<never>((_resolve,reject)=>{
        timeout=setTimeout(()=>{
          abandonPainter(painter,'配置の復元がタイムアウトしました。保存はできます。再生で再試行してください。');
          reject(new Error('配置の復元がタイムアウトしました。保存はできます。再生で再試行してください。'));
        },NATIVE_RESTORATION_TIMEOUT_MS);
      })]);
    }catch(error){if(renderer.current===painter){if(!document)setRecoveryAvailable(true);fail(error);}throw error;}
    finally{if(timeout!==undefined)clearTimeout(timeout);}
  };
  useEffect(() => { if (planRef.current) void show(current.current).catch(fail); }, [bypassLut]);
  const content = useRef<HTMLDivElement>(null);
  const [low, setLow] = useState(false);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const bounds = box.current?.getBoundingClientRect();
      if (bounds) setScale(Math.min(bounds.width / doc.resolution.width, bounds.height / doc.resolution.height));
      if (content.current) setLow(lowStage(content.current.clientHeight));
    });
    if (box.current) observer.observe(box.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [doc.resolution.width, doc.resolution.height]);
  // 外枠は px 指定のため、使用値がブラウザの 1/64px グリッドへ丸められる。合成面の
  // 倍率を丸め後の実測矩形から縦横別に求め、両者の bounding box を一致させる
  // （差は 1/64px 未満で見た目は不変。直接操作の換算基準をどちらにしても同じ値になる）。
  useLayoutEffect(() => {
    const bounds = frameBox.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const next = { x: bounds.width / doc.resolution.width, y: bounds.height / doc.resolution.height };
    setSurface(previous => previous && previous.x === next.x && previous.y === next.y ? previous : next);
  }, [scale, doc.resolution.width, doc.resolution.height]);
  useEffect(() => {
    let cancelled = false, animation = 0;
    const tick = (timestamp: number) => {
      if (cancelled) return;
      const audio = transport.current, plan = planRef.current;
      if (playingRef.current && audio && plan) {
        const target = Math.min(plan.document.sequenceEndFrame - 1, Math.floor(audio.presentationSample(timestamp) / audio.context.sampleRate * timeNumber(plan.document.fps)));
        if (!playbackDrawing.current && target !== rendered.current) {
          const request=show(target);playbackDrawing.current=request;
          void request.catch(fail).finally(()=>{if(playbackDrawing.current===request)playbackDrawing.current=null;});
        }
        if (!audio.isPlaying) {
          playingRef.current = false; setPlaying(false);
          const generation = version.current, notify = notifications.current, lastDraw = latestDrawing.current, operation = activity.current;
          const isCurrent = () => generation === version.current && operation === activity.current && transport.current === audio && !playingRef.current && !preparation.current;
          void Promise.resolve(lastDraw).then(async () => {
            if (!isCurrent()) return;
            // A preceding frame may still have been in flight when audio ended.
            // Publish ended only after the final frame actually reaches pixels.
            const finalFrame=audio.playbackRate<0?0:plan.document.sequenceEndFrame-1;
            if (rendered.current !== finalFrame) await show(finalFrame);
            if (!isCurrent()) return;
            if (controlledRate.current === undefined) { playbackRateRef.current=1; setRate(1); }
            notify.onEnded?.(); notify.onPlaybackChanged?.(false);
          }).catch(error => { if (isCurrent()) fail(error); });
        }
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick); return () => { cancelled = true; cancelAnimationFrame(animation); };
  }, []);
  const fps = timeNumber(doc.fps);
  const boxes = safeAreaBoxes(doc.resolution);
  const timecode = (at: number) => { const seconds = at / fps; return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}:${String(Math.round(at) % Math.round(fps)).padStart(2, '0')}`; };
  // バッジは再生中だけ。0.5 は片矢印（transport.ts のラベルは 1 以上の段が前提）。
  const badge = playing && rate !== 1 ? (Math.abs(rate) < 1 ? `${rate < 0 ? '◀' : '▶'} ${Math.abs(rate)}x` : playbackRateLabel(rate)) : '';
  const direction = badge ? (rate < 0 ? 'reverse' : 'forward') : undefined;
  const [mmss, ff] = [timecode(frame).slice(0, 5), timecode(frame).slice(6)];
  return <section className="native-preview" aria-label={`${monitor}モニター`}>
    {/* T31 回帰: 再読み込み・全画面はプレビュー枠の内側に絶対配置していたため、映像の上へ重なり
        書き出しフレームとの画素比較（native-image-manipulation-audit.ts）を落としていた。
        見出し行の右端＝プレビュー枠の外へ出す。全画面中は見出しごと隠れるので Esc で戻る。
        R2-M2: その案内は全画面に入る前しか読めないので、非全画面側の title にも書く。 */}
    <div className="native-panel-heading"><span>{monitor}</span>{notice}<span>{doc.resolution.width} × {doc.resolution.height} · {fps.toFixed(2).replace(/\.00$/, '')} fps</span>
      <div className="native-preview-tools">
        {onFitPanels&&<button className="btn-ghost native-header-icon" aria-label="映像に合わせてパネル幅を整える" title="映像の左右の余白を使ってパネルを広げる" onClick={onFitPanels}><Icon name="layout-wide"/></button>}
        {/* レビュー M6: legacy の Preview.tsx にも同名ボタン「プレビューを再読み込み」がある。
            native と legacy は同時に描画されないため名前は意図して揃えたまま維持する。 */}
        <button className="btn-ghost native-header-icon" aria-label="プレビューを再読み込み" title="プレビューを再読み込み" disabled={reloading} onClick={()=>void reloadPreview()}><Icon name="refresh"/></button>
        <button className="btn-ghost native-header-icon" aria-label={fullscreen?'全画面を終了':'全画面で表示'} aria-pressed={fullscreen} title={fullscreen?'全画面を終了（Esc）':'全画面で表示（全画面中は Esc で戻る）'} onClick={toggleFullscreen}><Icon name={fullscreen?'minimize':'maximize'}/></button>
      </div>
    </div>
    {monitorControls}
    <div className="native-preview-content" ref={content} data-low={low ? 'true' : undefined}>{isValidElement(addBar) ? cloneElement(addBar as ReactElement<{ vertical?: boolean }>, { vertical: !low }) : addBar}
    <div className="native-preview-box" ref={box}>
      {/* 枠は scale を掛けた px を指定するため、使用値がブラウザの 1/64px グリッドへ丸められる。
          合成面は丸め後の枠の実測値から縦横別の倍率を受け取り、枠と同じ矩形に揃える。
          直接操作の換算には、その合成面（下の transform 済み要素）を渡す。 */}
      {shapeDraw&&<NativeShapeToolbar active={drawKind} disabled={shapeDraw.disabled} onPick={shapeDraw.onPick}
        onPlaceDefault={()=>{
          if(!drawKind)return;
          const base:ShapeDraft={kind:drawKind,...DEFAULT_SHAPE_BOX,stage:'drag'};
          const placed=drawKind==='angle'?{...base,x3:DEFAULT_SHAPE_BOX.x2,y3:DEFAULT_SHAPE_BOX.y1}:base;
          void shapeDraw.onComplete(shapeDraftData(placed,shapeDraw.color)).catch(()=>undefined);
        }}/>}
      <div className="native-preview-stage" ref={frameBox} style={{ width: doc.resolution.width * scale, height: doc.resolution.height * scale }}
        data-native-drawing={drawKind??undefined}
        onPointerDown={drawDown} onPointerMove={drawMove} onPointerUp={drawUp} onPointerCancel={drawCancel}>
        <div ref={stage} style={{ position: 'relative', width: doc.resolution.width, height: doc.resolution.height, transform: `scale(${surface?.x ?? scale}, ${surface?.y ?? scale})`, transformOrigin: 'top left' }} />
        {manipulation&&!drawKind&&<NativePreviewManipulation ref={manipulationHandle} {...manipulation} document={doc} frame={frame} geometry={ready&&!error?geometry:null} stage={stage} pause={pause} render={renderManipulation}/>}
        {draft&&<svg className="native-shape-draft" aria-label="図形の下書き" viewBox={`0 0 ${doc.resolution.width} ${doc.resolution.height}`} preserveAspectRatio="none">
          <NativeShapeDraftBody draft={draft} width={doc.resolution.width} height={doc.resolution.height}/>
          <text x={draft.x2*doc.resolution.width+8} y={draft.y2*doc.resolution.height-8} className="native-shape-draft-chip">{shapeDraftChip(draft,doc.resolution)}</text>
        </svg>}
      </div>
      {/* 実測: フレーム枠の内側に置くと、生 DOM 合成面と書き出しフレームを 1px 以下の誤差で
          突き合わせる監査（native-graphics-position-audit.ts の maxDelta<=1）が常に赤になる
          （破線が実際に描画されてしまうため）。ガイドは書き出しに焼き込まれない編集専用の
          UI 装飾なので、合成面と同じ矩形をフレーム枠の外側（box 基準の絶対配置）に重ねる。 */}
      {safeArea&&<div className="native-safe-area" aria-hidden="true" style={{width:doc.resolution.width*scale,height:doc.resolution.height*scale}}>
        <div className="native-safe-area-frame" style={{left:`${boxes.safe.left*100}%`,top:`${boxes.safe.top*100}%`,width:`${boxes.safe.width*100}%`,height:`${boxes.safe.height*100}%`}}/>
        {boxes.band&&<div className="native-safe-area-band" style={{left:`${boxes.band.left*100}%`,top:`${boxes.band.top*100}%`,width:`${boxes.band.width*100}%`,height:`${boxes.band.height*100}%`}}/>}
      </div>}
      {preparing && !error && <div className="native-preview-status"><TaskProgress label={preparing} compact/></div>}
      {!preparing && !ready && showFrameLoading && !error && <div className="native-preview-status">{doc.sequenceEndFrame ? <TaskProgress label={rendered.current<0?"プレビューを準備中…":"表示を更新中…"} compact/> : '素材をタイムラインへ配置してください'}</div>}
      {error && <div className="native-preview-status" role="alert">{error}</div>}
      {badge && <span className="native-rate-overlay" aria-hidden="true">{badge}</span>}
    </div>
    </div>
    <div className="native-transport">
      <div className="native-timecode-group"><output aria-label="再生位置" className="native-timecode">{mmss}:<span className="native-timecode-frames">{ff}</span></output><span className="native-timecode-total">/ {timecode(doc.sequenceEndFrame)}</span></div>
      <div className="native-transport-keys">
        <button className="btn-ghost native-transport-icon" aria-label="先頭へ" title="先頭へ（Home）" disabled={!doc.sequenceEndFrame} onClick={() => void seek(0)}><Icon name="skip-back" /></button>
        <button className="btn-ghost native-transport-icon" aria-label="逆再生" title="逆再生（J）" disabled={!ready || !!error || !onShuttle} onClick={() => onShuttle?.('j')}><Icon name="rewind" /></button>
        <button className="btn-ghost native-transport-icon" onClick={() => seekBy(-1)} title="1フレーム戻る（←）"><Icon name="step-back" /></button>
        <button className="native-play" data-playing={playing || !!preparing} aria-label={preparing ? '再生準備を中止' : playing ? '一時停止' : '再生'} disabled={!preparing&&!playing&&(!ready || !!error)&&!recoveryAvailable} onClick={() => { if (playingRef.current||preparation.current) stop(); else void play().catch(()=>undefined); }}><span className="native-play-icon native-play-icon-play"><Icon name="play" filled size={18} /></span><span className="native-play-icon native-play-icon-pause"><Icon name="pause" filled size={18} /></span></button>
        <button className="btn-ghost native-transport-icon" onClick={() => seekBy(1)} title="1フレーム進む（→）"><Icon name="step-forward" /></button>
        <button className="btn-ghost native-transport-icon" aria-label="順再生" title="順再生（L）" disabled={!ready || !!error || !onShuttle} onClick={() => onShuttle?.('l')}><Icon name="fast-forward" /></button>
        <button className="btn-ghost native-transport-icon" aria-label="末尾へ" title="末尾へ（End）" disabled={!doc.sequenceEndFrame} onClick={() => void seek(Math.max(0, doc.sequenceEndFrame - 1))}><Icon name="skip-forward" /></button>
      </div>
      <span className="native-rate-badge" data-direction={direction} aria-live="polite">{badge}</span>
    </div>
    <div className="native-seek"><input aria-label="シークバー" type="range" min={0} max={Math.max(0,doc.sequenceEndFrame-1)} step={1} value={frame} disabled={!doc.sequenceEndFrame} onChange={event=>void seek(Number(event.target.value))}
      onKeyDown={event=>{
        // The thumb reports the displayed frame, which can lag decoding. Base
        // repeated keyboard steps on the pending request, just like frame buttons.
        const delta=event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='ArrowLeft'||event.key==='ArrowDown'?-1:0;
        if(delta){event.preventDefault();void seekBy(delta);}
      }}/></div>
  </section>;
});

/**
 * 下書きを完成品と同じ幾何で破線描画する（文書には触れない）。
 * レビュー Minor 4: 矢印は線のみ描く。矢尻（sceneRenderer.tsx の SVG marker）は
 * shapeGeometry.ts に幾何として存在しないため、下書きでは再現しない。
 */
function NativeShapeDraftBody({draft,width,height}:{draft:ShapeDraft;width:number;height:number}){
  const g=shapeSvgGeometry(draft,width,height);
  const dash={fill:'none',stroke:'currentColor',strokeWidth:2,strokeDasharray:'6 4'} as const;
  if(draft.kind==='rect')return <rect x={g.rectX} y={g.rectY} width={g.rectW} height={g.rectH} {...dash}/>;
  if(draft.kind==='ellipse')return <ellipse cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} {...dash}/>;
  if(draft.kind==='triangle')return <polygon points={trianglePoints(g.x1,g.y1,g.x2,g.y2).map(p=>`${p.x},${p.y}`).join(' ')} {...dash}/>;
  if(draft.kind==='angle'){
    const vertex={x:g.x1,y:g.y1},a={x:g.x2,y:g.y2},b={x:(draft.x3??draft.x1)*width,y:(draft.y3??draft.y1)*height};
    return <g {...dash}>
      <line x1={vertex.x} y1={vertex.y} x2={a.x} y2={a.y}/>
      <line x1={vertex.x} y1={vertex.y} x2={b.x} y2={b.y}/>
      <path d={angleArcPath(vertex,a,b,Math.min(width,height)*.08)}/>
    </g>;
  }
  return <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} {...dash}/>;
}
