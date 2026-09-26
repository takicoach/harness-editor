import {forwardRef,useEffect,useImperativeHandle,useMemo,useRef,useState} from 'react';
import type {NativeCommand,NativeSession} from './api';
import {resolveCutBoundary} from '../../core/sequence/cutArchive';
import {previewCutRestoration} from '../../core/sequence/commands';
import {inspectNativeSourceGaps,type NativeSourceGapCandidate} from '../../core/sequence/sourceGapRecovery';
import type {CutArchiveEntry,SequenceDocument} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';
import {TaskProgress} from '../components/TaskProgress';
import {archivedWords,cutLabel} from './cutPresentation';
import {NativeCutRange,type CutRange} from './NativeCutRange';
import {NativeCutWords} from './NativeCutWords';
import './native-cut-panel.css';

export interface NativeCutHandle {flush():Promise<boolean>}
interface Props {
  projectId:string;state:NativeSession;busy:boolean;frame:number;activeId:string|null;
  compact?:boolean;
  visible?:boolean;
  read():NativeSession|null;prepare():Promise<boolean>;execute(command:NativeCommand):Promise<boolean>;
  onWorking(value:boolean):void;onRestored(frame:number):void;
  onImportLegacyHistory?():Promise<boolean>;
}
// Ignore unrelated document revisions, but retire the choice if its actual
// source, placement, or any offered owner's settings changed during a flush.
function sourceGapChoiceKey(document:SequenceDocument,gap:NativeSourceGapCandidate):string {
  const {revision:_,...intent}=gap;
  return JSON.stringify([intent,gap.ownerChoices.map(choice=>choice.mediaOwnerIds.map(id=>document.clips.find(clip=>clip.id===id)))]);
}
export const NativeCutPanel=forwardRef<NativeCutHandle,Props>(function NativeCutPanel(props,ref){
  const latest=useRef(props);latest.current=props;
  const [working,setWorking]=useState<string|null>(null),[error,setError]=useState<{id:string;message:string}|null>(null);
  const [shown,setShown]=useState(20);
  const pending=useRef<Promise<boolean>|null>(null),epoch=useRef(0),mounted=useRef(true),root=useRef<HTMLElement>(null);
  const sourceGaps=useMemo(()=>props.compact?{candidates:[],issues:[]}:inspectNativeSourceGaps(props.state.document),[props.state.document,props.compact]);
  const owner=useRef({project:props.projectId,session:props.state.sessionId});
  useEffect(()=>{
    const previous=owner.current;owner.current={project:props.projectId,session:props.state.sessionId};
    if(previous.project!==props.projectId||previous.session!==props.state.sessionId){epoch.current++;pending.current=null;setWorking(null);setError(null);props.onWorking(false);}
  },[props.projectId,props.state.sessionId]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;epoch.current++;latest.current.onWorking(false);};},[]);
  useEffect(()=>{if(props.visible!==false&&props.activeId)Array.from(root.current?.querySelectorAll<HTMLElement>('[data-cut-entry-id]')??[]).find(el=>el.dataset.cutEntryId===props.activeId)?.scrollIntoView({block:'nearest'});},[props.activeId,props.compact,props.visible]);
  useImperativeHandle(ref,()=>({flush:()=>pending.current??Promise.resolve(true)}));
  async function importLegacyHistory(){
    if(pending.current||latest.current.busy||!latest.current.onImportLegacyHistory)return;
    const token=epoch.current,owns=()=>mounted.current&&epoch.current===token;
    setWorking('legacy-history');setError(null);latest.current.onWorking(true);
    const task=(async()=>{
      try{
        if(!await latest.current.prepare()||!owns())return false;
        if(!await latest.current.onImportLegacyHistory?.())throw new Error('旧カットを読み込めませんでした。画面上部の案内を確認して再試行してください。');
        return owns();
      }catch(cause){if(owns())setError({id:'legacy-history',message:cause instanceof Error?cause.message:String(cause)});return false;}
      finally{if(owns()){setWorking(null);latest.current.onWorking(false);}}
    })();pending.current=task;
    try{return await task;}finally{if(pending.current===task)pending.current=null;}
  }
  async function adopt(gap:NativeSourceGapCandidate,ownerClipId:string,location:'original'|'playhead'){
    if(pending.current||latest.current.busy)return;
    const token=epoch.current,revision=latest.current.state.document.revision,expectedChoice=sourceGapChoiceKey(latest.current.state.document,gap);
    const owns=()=>mounted.current&&epoch.current===token;
    setWorking(gap.id);setError(null);latest.current.onWorking(true);
    const task=(async()=>{
      try{
        if(!await latest.current.prepare()||!owns())return false;
        const current=latest.current,snapshot=current.read();if(!snapshot)return false;
        const currentGap=inspectNativeSourceGaps(snapshot.document).candidates.find(item=>item.id===gap.id);
        if(!currentGap||sourceGapChoiceKey(snapshot.document,currentGap)!==expectedChoice)throw new Error('元映像の範囲や設定が変わりました。使用箇所と位置を選び直してください。');
        if(location==='playhead'&&snapshot.document.revision!==revision)throw new Error('編集内容が変わりました。現在の再生位置を確認してください。');
        const ok=await current.execute({type:'adopt-source-gap',candidateId:gap.id,ownerClipId,...(location==='playhead'?{atFrame:current.frame}:{})});
        if(!ok)throw new Error('元映像の範囲を追加できませんでした。表示された内容を確認してください。');
        return owns();
      }catch(cause){if(owns())setError({id:gap.id,message:cause instanceof Error?cause.message:String(cause)});return false;}
      finally{if(owns()){setWorking(null);latest.current.onWorking(false);}}
    })();pending.current=task;
    try{return await task;}finally{if(pending.current===task)pending.current=null;}
  }
  async function restore(entry:CutArchiveEntry,range:CutRange|null,location:'original'|'playhead'){
    if(pending.current||latest.current.busy)return;
    const token=epoch.current,expectedRevision=latest.current.state.document.revision;
    const owns=()=>mounted.current&&epoch.current===token;
    setWorking(entry.id);setError(null);latest.current.onWorking(true);
    const task=(async()=>{
      try{
        if(!await latest.current.prepare()||!owns())return false;
        const current=latest.current,snapshot=current.read();if(!snapshot)return false;
        const saved=snapshot.document.cutArchive?.entries.find(e=>e.id===entry.id);
        // A flush may update other text, but must not redirect this chosen band.
        if(!saved||JSON.stringify(saved)!==JSON.stringify(entry))throw new Error('選んだカット区間が変わりました。戻す範囲を選び直してください。');
        const boundary=resolveCutBoundary(snapshot.document,saved),at=location==='playhead'?current.frame:boundary.frame;
        if(at===null)throw new Error(boundary.reason??'復元位置を選択してください。');
        if(location==='playhead'&&snapshot.document.revision!==expectedRevision)throw new Error('編集内容が変わりました。現在の再生位置を確認して、もう一度戻してください。');
        const ok=await current.execute({type:'restore-cut',entryId:saved.id,...(range?{range}:{}),...(location==='playhead'?{atFrame:at}:{})});
        if(!owns())return false;
        if(!ok)throw new Error('カットを戻せませんでした。表示された内容を確認してください。');
        current.onRestored(at);return true;
      }catch(cause){if(owns())setError({id:entry.id,message:cause instanceof Error?cause.message:String(cause)});return false;}
    })();pending.current=task;
    await task;if(pending.current===task)pending.current=null;
    if(owns()){setWorking(null);latest.current.onWorking(false);}
  }
  const entries=props.state.document.cutArchive?.entries??[];
  // Keep the panel mounted until its restore callback settles, even when the
  // final band disappears. A selected distant band joins the compact page.
  const visibleEntries=props.compact?entries.filter((entry,index)=>index<shown||entry.id===props.activeId):entries;
  if(props.compact&&!entries.length)return null;
  return <section ref={root} className={`native-cut-panel${props.compact?' is-compact':''}`} aria-label="カットした部分" data-native-script-flush>
    <header><h3>{props.compact?'カット済みの発話・区間':'カットした部分'}</h3><span>{entries.length} 区間</span></header>
    {!props.compact&&props.onImportLegacyHistory&&props.state.document.legacy&&!('cutHistoryImport' in props.state.document.legacy)&&<div className="native-source-gaps">
      <p className="native-subtle">移行前の編集データから、旧カットをタイムラインで戻せる範囲として読み込みます。</p>
      <button disabled={props.busy||working!==null} onClick={()=>void importLegacyHistory()}>旧カットを読み込む</button>
      {working==='legacy-history'&&<TaskProgress label="旧カットを確認しています…" compact/>}
      {error?.id==='legacy-history'&&<p role="alert">{error.message}</p>}
    </div>}
    <p className="native-subtle">{props.compact?'取り消し線の部分はカット済みです。ことばを選んで、一部分だけ戻すこともできます。':'保存後も戻せます。ことばや左右のつまみで、一部分だけ戻す範囲を選べます。'}</p>
    {visibleEntries.map(entry=><CutRow key={`${props.projectId}:${props.state.sessionId}:${entry.id}`} compact={props.compact} document={props.state.document} entry={entry} frame={props.frame} active={props.activeId===entry.id} disabled={props.busy||working!==null} working={working===entry.id} error={error?.id===entry.id?error.message:null} onRestore={(range,location)=>void restore(entry,range,location)}/>)}
    {props.compact&&shown<entries.length&&<button onClick={()=>setShown(n=>n+20)}>続きのカットを表示</button>}
    {!entries.length&&<p className="native-subtle">カットした区間がここに残ります。</p>}
    {!props.compact&&sourceGaps.candidates.length>0&&<div className="native-source-gap-list"><h3>元映像から戻す範囲</h3>
      <p className="native-subtle">復元記録のない未使用部分です。選んだ使用箇所の現在の設定で、映像・原音の復元範囲を作ります。字幕や削除時の調整内容は含まれません。</p>
      {sourceGaps.candidates.map(gap=><SourceGapRow key={sourceGapChoiceKey(props.state.document,gap)} gap={gap} document={props.state.document} frame={props.frame} disabled={props.busy||working!==null} working={working===gap.id} error={error?.id===gap.id?error.message:null} onAdopt={(owner,location)=>void adopt(gap,owner,location)}/>)}
    </div>}
    {!props.compact&&sourceGaps.issues.length>0&&<p className="native-subtle">使用範囲や速度の対応を確認できない素材は、自動で復元範囲を作成していません。</p>}
  </section>;
});
function SourceGapRow({gap,document,frame,disabled,working,error,onAdopt}:{gap:NativeSourceGapCandidate;document:SequenceDocument;frame:number;disabled:boolean;working:boolean;error:string|null;onAdopt(owner:string,location:'original'|'playhead'):void}){
  const [owner,setOwner]=useState(()=>gap.requiresOwnerChoice?'':gap.ownerChoices.find(choice=>choice.durationFrames!==null)?.ownerClipId??'');
  const [location,setLocation]=useState<''|'original'|'playhead'>(()=>gap.placement.frame===null?'':'original');
  const choice=gap.ownerChoices.find(choice=>choice.ownerClipId===owner),usable=!!choice&&choice.durationFrames!==null&&!choice.reason;
  return <article className="native-source-gap-row" data-source-gap-id={gap.id}>
    <strong>元映像 {timeNumber(gap.source.start).toFixed(2)}〜{timeNumber(gap.source.end).toFixed(2)}秒</strong>
    <label>引き継ぐ設定<select aria-label="補完で引き継ぐ設定" value={owner} disabled={disabled} onChange={event=>setOwner(event.target.value)}><option value="" disabled>使用箇所を選択</option>{gap.ownerChoices.map(choice=><option key={choice.ownerClipId} value={choice.ownerClipId} disabled={choice.durationFrames===null}>{choice.side==='left'?'前側':'後側'}：{document.clips.find(clip=>clip.id===choice.ownerClipId)?.name??'使用箇所'}</option>)}</select></label>
    <label>仕上げで表示する位置<select aria-label="補完範囲の表示位置" value={location} disabled={disabled} onChange={event=>setLocation(event.target.value as 'original'|'playhead')}><option value="" disabled>位置を選択</option><option value="original" disabled={gap.placement.frame===null}>現在のつなぎ目</option><option value="playhead">現在の再生位置（{(frame/timeNumber(document.fps)).toFixed(2)}秒）</option></select></label>
    <button disabled={disabled||!usable||!location} onClick={()=>location&&onAdopt(owner,location)}>復元用の範囲に追加</button>
    {working&&<TaskProgress label="復元する範囲を準備中…" compact/>}{error&&<p role="alert">{error}</p>}
  </article>;
}
function CutRow({document,entry,frame,active,disabled,working,error,onRestore,compact}:{document:SequenceDocument;entry:CutArchiveEntry;frame:number;active:boolean;disabled:boolean;working:boolean;error:string|null;compact?:boolean;onRestore(range:CutRange|null,location:'original'|'playhead'):void}){
  const [range,setRange]=useState<CutRange>({startFrame:0,endFrame:entry.durationFrames}),[location,setLocation]=useState<'original'|'playhead'>('original');
  const entryIdentity=JSON.stringify(entry);
  // Saving unrelated input must not turn a failed partial restore into a full restore.
  useEffect(()=>{setRange({startFrame:0,endFrame:entry.durationFrames});},[entryIdentity]);
  const words=useMemo(()=>archivedWords(document,entry),[document,entry]);
  const label=useMemo(()=>cutLabel(document,entry),[document,entry]),boundary=resolveCutBoundary(document,entry);
  const fps=timeNumber(document.fps),whole=range.startFrame===0&&range.endFrame===entry.durationFrames;
  const restoration=useMemo(()=>{
    const inspect=(part?:CutRange)=>{try{return {duration:previewCutRestoration(document,entry.id,part).durationFrames,error:null};}catch(cause){return {duration:null,error:cause instanceof Error?cause.message:String(cause)};}};
    const selected=inspect(range);return {selected,all:whole?selected:inspect()};
  },[document,entry.id,range.startFrame,range.endFrame,whole]);
  return <article data-cut-entry-id={entry.id} className={active?'is-active':''}>
    <div className="native-cut-heading"><strong>{(entry.durationFrames/fps).toFixed(2)}秒の{entry.sourceRecovery?'元映像の復元範囲':entry.legacyRecovery?'旧カット':'カット'}</strong><small>{boundary.frame===null?'戻す位置を選択':`${(boundary.frame/fps).toFixed(2)}秒の位置`}</small></div>
    {entry.sourceRecovery&&<p className="native-subtle">元映像・原音から作成した範囲です。選択した使用箇所の設定を引き継いでいます。</p>}
    {entry.legacyRecovery&&<p className="native-subtle">移行前の編集データに残っている映像・原音・字幕などを、全体の設定で戻せます。</p>}
    <p className="native-cut-label"><s>{label}</s></p>
    {!!words.length&&<NativeCutWords key={`${entry.id}:${document.revision}`} words={words} value={range} disabled={disabled} onChange={setRange}/>}
    {!compact&&<><NativeCutRange key={`${entry.id}:${document.revision}`} duration={entry.durationFrames} value={range} disabled={disabled} onChange={setRange}/>
    <div className="native-cut-range-fields"><label>開始（fr）<input aria-label="戻す範囲の開始フレーム" type="number" min={0} max={range.endFrame-1} value={range.startFrame} disabled={disabled} onChange={event=>{const n=event.currentTarget.valueAsNumber;if(Number.isFinite(n))setRange({...range,startFrame:Math.max(0,Math.min(range.endFrame-1,Math.round(n)))});}}/></label>
      <label>終了（fr）<input aria-label="戻す範囲の終了フレーム" type="number" min={range.startFrame+1} max={entry.durationFrames} value={range.endFrame} disabled={disabled} onChange={event=>{const n=event.currentTarget.valueAsNumber;if(Number.isFinite(n))setRange({...range,endFrame:Math.max(range.startFrame+1,Math.min(entry.durationFrames,Math.round(n)))});}}/></label></div>
    <p className="native-subtle">カットした帯の {range.startFrame}〜{range.endFrame} フレームを選択</p></>}
    {restoration.selected.duration!==null?<p className="native-subtle">現在の速度では {(restoration.selected.duration/fps).toFixed(2)}秒（{restoration.selected.duration} fr）戻ります。</p>:<p role="status">{restoration.selected.error}</p>}
    <label className="native-cut-location"><input type="checkbox" checked={location==='playhead'} disabled={disabled} onChange={event=>setLocation(event.target.checked?'playhead':'original')}/>現在の再生位置（{(frame/fps).toFixed(2)}秒）に戻す</label>
    {boundary.frame===null&&location==='original'&&<p className="native-subtle">{boundary.reason}</p>}
    {working&&<TaskProgress label="カットした部分を戻しています" compact/>}
    {error&&<p role="alert">{error}</p>}
    <div className="native-cut-actions"><button disabled={disabled||!!restoration.all.error||(location==='original'&&boundary.frame===null)} onClick={()=>onRestore(null,location)}>このカットを戻す</button>
      {!whole&&<button disabled={disabled||!!restoration.selected.error||(location==='original'&&boundary.frame===null)} onClick={()=>onRestore(range,location)}>選択部分を戻す</button>}
      {!whole&&<button disabled={disabled} onClick={()=>setRange({startFrame:0,endFrame:entry.durationFrames})}>全体を選択</button>}</div>
  </article>;
}
