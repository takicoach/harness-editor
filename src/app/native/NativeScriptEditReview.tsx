import { forwardRef,useEffect,useImperativeHandle,useRef,useState } from 'react';
import { validateScriptEditArtifact,type ScriptEditArtifact } from '../../core/scriptEditArtifact';
import { validateScriptEditInput } from '../../core/scriptEditProposal';
import type { ScriptEditModification } from '../../core/scriptEditModification';
import type { SequenceDocument } from '../../core/sequence/model';
import { nativeRequest,type NativeSession } from './api';
import { NativePreview,type NativePreviewHandle } from './NativePreview';
import { ScriptAdoptionControls,type ScriptAdoptionAccess } from '../panels/ScriptAdoptionControls';
import { ScriptOperationDetails } from '../panels/ScriptOperationDetails';
import { TaskProgress } from '../components/TaskProgress';

interface Props {projectId:string;state:NativeSession;read():NativeSession|null;mode:'caption'|'structure';occurrenceId:string;
  disabled:boolean;adoption:ScriptAdoptionAccess;onPreview():void}
interface Review {artifact:ScriptEditArtifact;before:SequenceDocument;after:SequenceDocument}
export interface NativeScriptEditReviewHandle {pause():void}
export const NativeScriptEditReview=forwardRef<NativeScriptEditReviewHandle,Props>(function NativeScriptEditReview(props,ref) {
  const [review,setReview]=useState<Review|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [preview,setPreview]=useState<'before'|'after'|null>(null);
  const latest=useRef(props);latest.current=props;
  const player=useRef<NativePreviewHandle>(null);
  useImperativeHandle(ref,()=>({pause:()=>player.current?.pause()}));
  useEffect(()=>{player.current?.pause();setPreview(null);},[props.state.document.revision,props.occurrenceId,props.mode]);
  const pending=useRef<{token:number;controller?:AbortController}>({token:0});
  useEffect(()=>()=>{pending.current.token++;pending.current.controller?.abort();},[]);
  function isCurrent(artifact:ScriptEditArtifact) {
    const current=latest.current,session=current.read(),binding=artifact.input.native;
    return !!binding&&!!session&&!current.disabled&&!session.dirty&&session.document.revision===binding.revision
      &&session.savedContentHash===binding.contentHash&&current.occurrenceId===binding.source.occurrenceId&&current.mode===artifact.proposal.kind;
  }
  async function checked(artifact:ScriptEditArtifact,modification?:ScriptEditModification,signal?:AbortSignal):Promise<Review> {
    if(!isCurrent(artifact))throw new Error('編集内容や対象が変わっています。現在の内容から変更案を作り直してください。');
    const state=latest.current.read()!;
    const result=await nativeRequest<Review>(props.projectId,'/script/edit-review',{sessionId:state.sessionId,expectedRevision:state.document.revision,artifact,modification},signal);
    if(!isCurrent(artifact)||latest.current.read()?.sessionId!==state.sessionId)throw new Error('確認中に編集内容が変わりました。もう一度変更案を確認してください。');
    return {...result,artifact:validateScriptEditArtifact(result.artifact)};
  }
  async function run(action:(signal:AbortSignal)=>Promise<void>) {
    if(busy||latest.current.disabled)return;
    pending.current.controller?.abort();const controller=new AbortController(),token=++pending.current.token;pending.current.controller=controller;
    setBusy(true);setError(null);
    try{await action(controller.signal);}catch(cause){if(token===pending.current.token&&!controller.signal.aborted)setError(cause instanceof Error?cause.message:String(cause));}
    finally{if(token===pending.current.token)setBusy(false);}
  }
  const stale=review!==null&&!isCurrent(review.artifact);
  const bridge={...props.adoption.bridge,review:async(artifact:ScriptEditArtifact,modification?:ScriptEditModification)=>(await checked(artifact,modification)).artifact};
  return <section className="script-edit-review" aria-label="台本の変更案">
    <h3>編集の変更案</h3><p>保存した台本と発話をもとに変更案を作り、内容を確認してから採用できます。</p>
    <button className="btn-secondary" disabled={props.disabled||busy||!props.occurrenceId||!props.state.document.scriptDocument} onClick={()=>void run(async signal=>{
      const state=latest.current.read()!,occurrenceId=latest.current.occurrenceId,mode=latest.current.mode;
      const input=validateScriptEditInput(await nativeRequest(props.projectId,'/script/edit-input',{sessionId:state.sessionId,expectedRevision:state.document.revision,occurrenceId,mode},signal));
      const current=latest.current.read();if(signal.aborted||!current||current.sessionId!==state.sessionId||current.document.revision!==state.document.revision||current.dirty)throw new Error('入力の作成中に編集内容が変わりました。もう一度作成してください。');
      const url=URL.createObjectURL(new Blob([JSON.stringify(input,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`script-${mode}-input.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    })}>変更案用の入力を書き出す</button>
    <label className="script-import">変更案を読み込む<input type="file" aria-label="台本の変更案を読み込む" accept=".json,application/json" disabled={props.disabled||busy} onChange={event=>{
      const file=event.target.files?.[0];event.target.value='';if(!file)return;
      void run(async signal=>{
        if(file.size>16*1024*1024)throw new Error('変更案は16MB以内のファイルを選んでください。');
        const artifact=validateScriptEditArtifact(JSON.parse(await file.text()));signal.throwIfAborted();
        const result=await checked(artifact,undefined,signal);signal.throwIfAborted();setReview(result);setPreview(null);
      });
    }}/></label>
    {props.state.dirty&&<p className="script-stage-note">編集内容を保存すると、変更案を作成・確認できます。</p>}
    {busy&&<TaskProgress compact label="台本の変更案を確認しています"/>}
    {error&&<p className="script-error" role="alert">{error}</p>}
    {review&&<div key={review.artifact.proposal.proposalId}>
      {stale&&<p className="script-stale" role="status">編集内容や対象が変わっています。この案は現在の内容へ採用できません。</p>}
      <ScriptOperationDetails artifact={review.artifact}/>
      <div className="script-adoption-actions"><button className="btn-secondary" disabled={busy||stale} onClick={()=>{props.onPreview();setPreview('before');}}>変更前を再生</button>
        <button className="btn-secondary" disabled={busy||stale} onClick={()=>{props.onPreview();setPreview('after');}}>変更案を再生</button></div>
      {preview&&<div className="native-script-source"><strong>{preview==='before'?'変更前の確認':'変更案の確認（未反映）'}</strong>
        <NativePreview ref={player} key={`${review.artifact.proposal.proposalId}:${preview}`} monitor={preview==='before'?'変更前':'変更案'} projectId={props.projectId} document={review[preview]} initialFrame={0} onFrame={()=>undefined} bypassLut={false} onPlay={props.onPreview}/>
        <button onClick={()=>setPreview(null)}>変更案の再生を閉じる</button></div>}
      <ScriptAdoptionControls {...props.adoption} bridge={bridge} artifact={review.artifact} disabled={props.disabled||busy||stale} isCurrent={()=>isCurrent(review.artifact)}/>
    </div>}
  </section>;
});
