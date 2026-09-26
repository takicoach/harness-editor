import { useEffect,useRef,useState } from 'react';
import {TaskProgress} from '../components/TaskProgress';
import type { SourceTranscript } from '../../core/sequence/model';
import { transcriptIdentity } from '../../core/sequence/transcript';
import { transcriptionActive,type NativeTranscriptionStatus } from '../../shared/nativeTranscription';
import { nativeRequest,NativeApiError,type NativeSession } from './api';

interface Props {projectId:string;occurrenceId:string;assetId:string;streamIndex:number;state:NativeSession;busy:boolean;read():NativeSession|null;accept(state:NativeSession):void}
const labels:Record<NativeTranscriptionStatus['phase'],string>={queued:'準備を待っています',preparing:'選んだ原音を準備しています','loading-model':'音声認識を準備しています',analyzing:'文字起こししています',writing:'結果を整理しています',completed:'文字起こしができました',failed:'文字起こしできませんでした',cancelled:'文字起こしを中止しました'};
export function NativeTranscribeControl(props:Props) {
  const {projectId,assetId,streamIndex}=props;
  const [job,setJob]=useState<NativeTranscriptionStatus|null>(null),[working,setWorking]=useState(false),[error,setError]=useState<string|null>(null),[result,setResult]=useState<SourceTranscript|null>(null);
  const latest=useRef(props);latest.current=props;
  const generation=useRef(0),pendingStart=useRef<{sessionId:string;expectedRevision:number;executionId:string;occurrenceId:string}|null>(null);
  const pendingApply=useRef<{sessionId:string;expectedRevision:number;executionId:string}|null>(null);
  useEffect(()=>{
    const token=++generation.current,controller=new AbortController();setJob(null);setResult(null);setError(null);pendingStart.current=null;pendingApply.current=null;
    void nativeRequest<{jobs:NativeTranscriptionStatus[]}>(projectId,'/transcribe/list',undefined,controller.signal).then(value=>{
      if(token===generation.current)setJob(value.jobs.filter(job=>job.assetId===assetId&&job.streamIndex===streamIndex).at(-1)??null);
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>{generation.current++;controller.abort();};
  },[projectId,assetId,streamIndex]);
  useEffect(()=>{
    if(!job||!transcriptionActive(job))return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      try{setJob(await nativeRequest<NativeTranscriptionStatus>(projectId,'/transcribe/status',undefined,controller.signal,{job:job.id}));}
      catch(error){if(!controller.signal.aborted)setError(error instanceof Error?error.message:String(error));}
      if(!controller.signal.aborted)timer=setTimeout(poll,500);
    };
    timer=setTimeout(poll,200);return()=>{controller.abort();clearTimeout(timer);};
  },[projectId,job?.id,job?.phase]);
  const run=async(work:()=>Promise<void>)=>{
    const token=generation.current;setWorking(true);setError(null);
    try{await work();}catch(error){if(token===generation.current)setError(error instanceof Error?error.message:String(error));}
    finally{if(token===generation.current)setWorking(false);}
  };
  const start=()=>run(async()=>{
    const current=latest.current.read();if(!current)throw new Error('案件を読み直してください');
    pendingStart.current??={sessionId:current.sessionId,expectedRevision:current.document.revision,executionId:crypto.randomUUID(),occurrenceId:latest.current.occurrenceId};
    const token=generation.current;
    let value:NativeTranscriptionStatus;
    try{value=await nativeRequest<NativeTranscriptionStatus>(projectId,'/transcribe',pendingStart.current);}
    catch(error){if(error instanceof NativeApiError&&error.status>=400&&error.status<500)pendingStart.current=null;throw error;}
    if(token!==generation.current)return;
    pendingStart.current=null;pendingApply.current=null;setResult(null);setJob(value);
  });
  const inspect=()=>run(async()=>{
    if(!job)return;const token=generation.current;
    const value=await nativeRequest<{transcript:SourceTranscript}>(projectId,'/transcribe/result',undefined,undefined,{job:job.id});
    if(token===generation.current)setResult(value.transcript);
  });
  const apply=()=>run(async()=>{
    if(!job||!result)return;const current=latest.current.read();if(!current)throw new Error('案件を読み直してください');
    pendingApply.current??={sessionId:current.sessionId,expectedRevision:current.document.revision,executionId:crypto.randomUUID()};
    const token=generation.current;
    let value:NativeSession;
    try{value=await nativeRequest<NativeSession>(projectId,'/transcribe/apply',pendingApply.current,undefined,{job:job.id});}
    catch(error){if(error instanceof NativeApiError&&error.status>=400&&error.status<500)pendingApply.current=null;throw error;}
    if(token===generation.current){latest.current.accept(value);pendingApply.current=null;}
  });
  const existing=props.state.document.transcripts.find(item=>item.assetId===assetId&&item.streamIndex===streamIndex)??null;
  const applied=!!result&&transcriptIdentity(existing)===transcriptIdentity(result);
  return <section className="native-transcription" aria-label="文字起こしの生成">
    <p className="native-subtle">選んだ原音の全体から発話を生成します。</p>
    <button disabled={props.busy||working||!!job&&transcriptionActive(job)} onClick={()=>void start()}>{pendingStart.current?'開始を再試行':existing?'文字起こしを再生成':'文字起こしを生成'}</button>
    {working&&!job&&<TaskProgress label="文字起こしを開始しています" compact/>}
    {job&&<>{transcriptionActive(job)?<TaskProgress label={labels[job.phase]} value={job.percent===undefined?undefined:job.percent/100}/>:<p role="status">{labels[job.phase]}</p>}
      {transcriptionActive(job)&&<button disabled={working} onClick={()=>void run(async()=>{setJob(await nativeRequest<NativeTranscriptionStatus>(projectId,'/transcribe/cancel',{},undefined,{job:job.id}));})}>生成を中止</button>}
      {job.error&&<p role="alert">{job.error}</p>}
      {job.phase==='completed'&&<><p>{job.wordCount} 語 · {job.excerpt}</p><button disabled={working} onClick={()=>void inspect()}>生成結果を確認</button></>}
    </>}
    {result&&<div className="native-transcription-result"><label>生成した発話<textarea readOnly rows={5} value={result.words.map(word=>word.text).join('')} /></label>
      <p className="native-subtle">この原音の文字起こしを置き換えます。字幕やカットは変更しません。</p>
      <button disabled={applied||working||props.busy} onClick={()=>void apply()}>{applied?'取り込み済み':'この結果を取り込む'}</button>
    </div>}
    {error&&<p role="alert">{error}</p>}
  </section>;
}
