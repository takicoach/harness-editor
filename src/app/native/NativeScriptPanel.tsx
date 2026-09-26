import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { NativeCommand, NativeSession } from './api';
import { nativeRequest } from './api';
import { createScriptDocument } from '../../core/scriptDocumentData';
import { validateScriptProposalArtifact, type ScriptProposalArtifact } from '../../core/scriptProposalArtifact';
import { sourceReviewDocument } from '../../core/sequence/sourceReview';
import { timeNumber } from '../../core/sequence/time';
import { NativePreview, type NativePreviewHandle } from './NativePreview';
import '../panels/ScriptPanel.css';
import { NativeScriptEditReview,type NativeScriptEditReviewHandle } from './NativeScriptEditReview';
import {TaskProgress} from '../components/TaskProgress';
import {importScriptFile,SCRIPT_FILE_ACCEPT} from './scriptImport';
import type { ScriptAdoptionAccess } from '../panels/ScriptAdoptionControls';

export interface NativeScriptHandle { flush():Promise<boolean>;pauseSource():void }
interface Props {projectId:string;state:NativeSession;busy:boolean;occurrenceId:string;adoption?:ScriptAdoptionAccess;
  read():NativeSession|null;execute(command:NativeCommand):Promise<boolean>;save():Promise<boolean>;onSourcePreview():void;onDraft(dirty:boolean):void}
const statuses={unique:'文字が一致',ambiguous:'候補が複数',unmatched:'一致が見つかりません'};
const clock=(ms:number)=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${Math.floor(ms/100)%10}`;

export const NativeScriptPanel=forwardRef<NativeScriptHandle,Props>(function NativeScriptPanel(props,ref){
  const {state,projectId,occurrenceId}=props,script=state.document.scriptDocument;
  const [text,setText]=useState(script?.text??''),[base,setBase]=useState(script?.text??''),[error,setError]=useState<string|null>(null);
  const [mode,setMode]=useState<'caption'|'structure'>('caption'),[working,setWorking]=useState(false),[visible,setVisible]=useState(20);
  const [result,setResult]=useState<{artifact:ScriptProposalArtifact;revision:number;occurrenceId:string;mode:typeof mode}|null>(null);
  const [source,setSource]=useState<{document:NativeSession['document'];ms:number}|null>(null);
  const latest=useRef({props,text,base,mode});latest.current={props,text,base,mode};
  const pending=useRef<Promise<boolean>|null>(null),generation=useRef(0),controller=useRef<AbortController|null>(null);
  const sessionOwner=useRef({projectId,sessionId:state.sessionId}),sessionGeneration=useRef(0);
  const [importing,setImporting]=useState(false),[importedName,setImportedName]=useState('');
  const importController=useRef<AbortController|null>(null),importGeneration=useRef(0),editGeneration=useRef(0);
  const sourcePlayer=useRef<NativePreviewHandle>(null);
  const reviewPlayer=useRef<NativeScriptEditReviewHandle>(null);
  const dirty=text!==(script?.text??''),conflict=dirty && base!==(script?.text??'');
  useEffect(()=>{const value=script?.text??'';if(latest.current.text===latest.current.base){setText(value);setBase(value);}},[script?.revision]);
  useEffect(()=>{props.onDraft(dirty||importing);},[dirty,importing]);
  useEffect(()=>()=>{sessionGeneration.current++;generation.current++;controller.current?.abort();importGeneration.current++;importController.current?.abort();props.onDraft(false);},[]);
  useEffect(()=>{
    generation.current++;controller.current?.abort();importGeneration.current++;importController.current?.abort();importController.current=null;
    const previous=sessionOwner.current;sessionOwner.current={projectId,sessionId:state.sessionId};
    sessionGeneration.current++;pending.current=null;editGeneration.current++;
    // Reconnection retires requests, not the user's unsaved text. A different
    // project must never inherit it; a changed server text remains a conflict.
    if(previous.projectId!==projectId||latest.current.text===latest.current.base){
      const value=script?.text??'';latest.current.text=value;latest.current.base=value;setText(value);setBase(value);setError(null);
    }
    setResult(null);setWorking(false);setImporting(false);setImportedName('');
  },[projectId,state.sessionId]);
  useEffect(()=>{
    const unload=(event:BeforeUnloadEvent)=>{if(latest.current.text!==(latest.current.props.read()?.document.scriptDocument?.text??'')){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);
  },[]);
  async function flush():Promise<boolean> {
    if(pending.current){if(!await pending.current)return false;return flush();}
    const current=latest.current,document=current.props.read()?.document;
    if(!document)return false;
    if(current.text===(document.scriptDocument?.text??''))return true;
    if(importController.current){setError('台本を読み込み中です。完了後に本文を確認してください。');return false;}
    if(current.base!==(document.scriptDocument?.text??'')){setError('別の操作で台本が変わりました。入力した文章を確認してください。');return false;}
    const epoch=sessionGeneration.current,origin=current.props.projectId,session=current.props.state.sessionId;
    const owns=()=>sessionGeneration.current===epoch&&latest.current.props.projectId===origin&&latest.current.props.state.sessionId===session;
    try {
      // onChange updates the latest ref in place before React renders. Keep the
      // submitted value separate so a later draft cannot mutate this comparison.
      const submittedText=current.text;
      const next=submittedText.trim()?createScriptDocument(submittedText,{documentId:document.scriptDocument?.documentId??crypto.randomUUID(),revision:crypto.randomUUID()}):null;
      const task=(async()=>{
        const ok=await current.props.execute({type:'set-script',script:next});
        if(!owns())return false;
        if(ok){
          const value=next?.text??'';latest.current.base=value;setBase(value);
          if(latest.current.text===submittedText){latest.current.text=value;setText(value);}setError(null);
        }else setError('台本を反映できませんでした。入力はこの画面に残っています。');
        return ok;
      })();pending.current=task;
      const ok=await task;if(pending.current===task)pending.current=null;
      return ok ? flush() : false;
    } catch(cause){if(owns()){pending.current=null;setError(cause instanceof Error?cause.message:'台本を確認してください');}return false;}
  }
  useImperativeHandle(ref,()=>({flush,pauseSource:()=>{sourcePlayer.current?.pause();reviewPlayer.current?.pause();}}));
  useEffect(()=>setSource(null),[occurrenceId,state.document.revision]);
  async function align(){
    if(!await flush())return;
    const token=++generation.current;controller.current?.abort();controller.current=new AbortController();setWorking(true);setError(null);
    try {
      if(!await latest.current.props.save())throw new Error('保存してから、もう一度照合してください。');
      const captured=latest.current.props.read();if(!captured)throw new Error('案件を読み直してください');
      const selected=latest.current.props.occurrenceId,purpose=latest.current.mode;
      const artifact=validateScriptProposalArtifact(await nativeRequest(projectId,'/script/alignment',{sessionId:captured.sessionId,
        expectedRevision:captured.document.revision,occurrenceId:selected,mode:purpose},controller.current.signal));
      if(token!==generation.current)return;
      if(latest.current.props.read()?.document.revision!==captured.document.revision || latest.current.props.occurrenceId!==selected || latest.current.mode!==purpose)
        throw new Error('照合中に対象や編集内容が変わりました。もう一度照合してください。');
      setResult({artifact,revision:captured.document.revision,occurrenceId:selected,mode:purpose});setVisible(20);
    }catch(cause){if(token===generation.current && !controller.current?.signal.aborted)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(token===generation.current)setWorking(false);}
  }
  async function upload(file:File){
    importController.current?.abort();const abort=new AbortController();importController.current=abort;
    const token=++importGeneration.current,current=latest.current;
    const owner={projectId:current.props.projectId,sessionId:current.props.state.sessionId,edit:editGeneration.current};
    const owns=()=>token===importGeneration.current&&latest.current.props.projectId===owner.projectId&&latest.current.props.state.sessionId===owner.sessionId;
    setImporting(true);setError(null);
    try{
      // Clicking the file label can first blur a dirty textarea. Own this request
      // now, but capture the revision only after that existing commit settles.
      if(pending.current&&!await pending.current)throw new Error('台本を反映できませんでした。入力を確認してから、もう一度ファイルを選んでください');
      if(!owns())return;
      if(editGeneration.current!==owner.edit)throw new Error('読み込み中に編集内容が変わりました。入力を残しました。もう一度ファイルを選んでください');
      const snapshot={text:latest.current.text,revision:latest.current.props.read()?.document.revision};
      const imported=await importScriptFile(file,abort.signal);
      if(!owns())return;
      if(editGeneration.current!==owner.edit||latest.current.text!==snapshot.text||latest.current.props.read()?.document.revision!==snapshot.revision)
        throw new Error('読み込み中に編集内容が変わりました。入力を残しました。もう一度ファイルを選んでください');
      latest.current.text=imported;editGeneration.current++;setText(imported);setImportedName(file.name);setError(null);
    }catch(cause){if(owns()&&!abort.signal.aborted)setError(cause instanceof Error?cause.message:'台本ファイルを確認してください');}
    finally{if(owns()){importController.current=null;setImporting(false);}}
  }
  const stale=!!result && (dirty || result.revision!==state.document.revision || result.occurrenceId!==occurrenceId || result.mode!==mode);
  return <section className="script-panel" aria-label="撮影台本">
    <header><p className="script-eyebrow">撮影した言葉と、台本をつなぐ</p><h2>台本</h2><p>台本をアップロードし、読み込んだ本文を確認してから発話と照合します。</p></header>
    <div className="script-upload">
      <label className="btn-primary script-import">台本をアップロード
        <input type="file" aria-label="台本ファイルをアップロード" accept={SCRIPT_FILE_ACCEPT} disabled={props.busy||working} onChange={event=>{
          const file=event.target.files?.[0];event.target.value='';if(file)void upload(file);
        }}/>
      </label>
      <p>Word（.docx）・PDF・TXT・Markdown・SRT / 8MBまで</p>
      <p>SRTは本文のみを読み込みます。発話の時刻は照合で確認します。</p>
      {importing&&<TaskProgress label="台本を読み込んでいます" compact detail="本文を取り出しています"/>}
      {importedName&&<p className="script-input-meta">{importedName}</p>}
    </div>
    <label className="script-input-label" htmlFor="native-shooting-script">台本の本文を確認・修正</label>
    <textarea id="native-shooting-script" value={text} maxLength={2000000} rows={6} placeholder="ここに直接貼り付けることもできます" onChange={event=>{editGeneration.current++;latest.current.text=event.target.value;setText(event.target.value);setImportedName('');}} onBlur={event=>{
      // These actions flush the draft themselves. Starting an edit on blur would
      // disable their button between pointer-down and click, swallowing the action.
      if(!(event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-native-script-flush]')))void flush();
    }} />
    <div className="script-input-meta"><span>{script?.passages.length??0} 文章{dirty?' · 未反映':''}</span><span>200万文字まで</span></div>
    <button data-native-script-flush className="btn-secondary" disabled={!dirty || props.busy || working || importing || conflict} onClick={()=>void flush()}>台本を反映</button>
    {conflict && <button className="btn-secondary" onClick={()=>{editGeneration.current++;latest.current.text=script?.text??'';latest.current.base=script?.text??'';setText(script?.text??'');setBase(script?.text??'');setImportedName('');setError(null);}}>保存済みの台本を読み直す</button>}
    <fieldset className="script-purpose"><legend>照合の目的</legend>{([['caption','字幕の表記を揃える'],['structure','台本の構成に揃える']] as const).map(([value,label])=>
      <label key={value}><input type="radio" name="native-script-mode" checked={mode===value} onChange={()=>setMode(value)} /><span>{label}</span></label>)}</fieldset>
    <button data-native-script-flush className="btn-primary script-align" disabled={!text.trim() || !occurrenceId || props.busy || working || importing || conflict} onClick={()=>void align()}>{working?'発話を探しています…':'保存して発話と照合'}</button>
    {working && <button className="btn-secondary" onClick={()=>{generation.current++;controller.current?.abort();setWorking(false);}}>照合を中止</button>}
    {error && <p className="script-error" role="alert">{error}</p>}
    {result && <div className="script-results" aria-label="台本の照合結果"><h3>発話との対応</h3>
      <p className="script-summary" role="status">一致 {result.artifact.proposals.filter(item=>item.status==='unique').length} ・候補複数 {result.artifact.proposals.filter(item=>item.status==='ambiguous').length} ・未対応 {result.artifact.proposals.filter(item=>item.status==='unmatched').length}</p>
      {stale && <p className="script-stale" role="status">編集内容や対象が変わっています。もう一度照合してください。</p>}
      <ol>{result.artifact.proposals.slice(0,visible).map(proposal=><li key={proposal.proposalId} className="script-passage" data-status={proposal.status}>
        <span className="script-match-label">{statuses[proposal.status]}</span><p>{result.artifact.packet.script.text.slice(proposal.scriptRange.start,proposal.scriptRange.end)}</p>
        <div className="script-candidates">{proposal.candidates.map((candidate,index)=>{
          const words=result.artifact.packet.transcript.words,start=words[candidate.wordRef.startIndex]!.startMs,end=words[candidate.wordRef.endIndex-1]!.endMs;
          return <button key={index} disabled={stale || working} title="素材の発話を確認" onClick={()=>{
            try{reviewPlayer.current?.pause();props.onSourcePreview();setSource({document:sourceReviewDocument(state.document,occurrenceId),ms:start});}catch(cause){setError(String(cause));}
          }}>{clock(start)}–{clock(end)}</button>;
        })}</div></li>)}</ol>
      {result.artifact.proposals.length>visible && <button className="btn-secondary" onClick={()=>setVisible(count=>count+20)}>続きを表示</button>}
      <p className="script-stage-note">候補の確認だけでは字幕やカットは変更されません。</p>
    </div>}
    {props.adoption&&<NativeScriptEditReview ref={reviewPlayer} projectId={projectId} state={state} read={props.read} mode={mode} occurrenceId={occurrenceId} disabled={props.busy||working||importing||dirty||state.dirty} adoption={props.adoption} onPreview={()=>{sourcePlayer.current?.pause();props.onSourcePreview();}}/>}
    {source && <div className="native-script-source"><strong>素材の発話を確認</strong><NativePreview monitor="ソース" ref={sourcePlayer} onPlay={()=>{reviewPlayer.current?.pause();props.onSourcePreview();}} key={`${source.document.assets[0]!.id}:${source.ms}`} projectId={projectId}
      document={source.document} initialFrame={Math.floor(source.ms/1000*timeNumber(source.document.fps))} onFrame={()=>undefined} bypassLut={false} />
      <button onClick={()=>setSource(null)}>素材の確認を閉じる</button></div>}
  </section>;
});
