import {useEffect,useRef,useState} from 'react';
import {nativeRequest,NativeApiError,type NativeSession} from './api';
import type {SequenceDocument} from '../../core/sequence/model';
import {DEFAULT_SILENCE_SETTINGS,silenceSettings,type SilencePlan,type SilenceRange,type SilenceSettings,type SilenceStatus} from '../../shared/silenceCut';

const PREF='harness.silence-settings.v1';
const message=(e:unknown)=>e instanceof Error?e.message:String(e);
export function useSilenceCut(props:{projectId:string;state:NativeSession;read:()=>NativeSession|null;accept:(s:NativeSession)=>void;prepare:()=>Promise<boolean>;blocked:boolean;onBusy:(v:boolean)=>void;onCandidates:(r:SilenceRange[])=>void;onPreview:(d:SequenceDocument|null,start?:number,end?:number)=>void}){
  const latest=useRef(props);latest.current=props;
  const [started,setStarted]=useState(false);
  const [settings,setSettings]=useState<SilenceSettings>(()=>{try{return silenceSettings(JSON.parse(localStorage.getItem(PREF)??''));}catch{return {...DEFAULT_SILENCE_SETTINGS};}});
  const [tracks,setTracks]=useState<string[]>(()=>{const ids=[...new Set(props.state.document.clips.filter(c=>c.content.kind==='audio'&&c.content.role==='speech').map(c=>c.trackId))];return ids.length===1?ids:[];});
  const [scope,setScope]=useState<SilenceRange|undefined>(),[status,setStatus]=useState<SilenceStatus|null>(null),[plan,setPlan]=useState<SilencePlan|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[applying,setApplying]=useState(false),[uncertain,setUncertain]=useState(false);
  const [applied,setApplied]=useState<{revision:number;sessionId:string;count:number;frames:number}|null>(null);
  const analysis=useRef<string|null>(null),mounted=useRef(true),generation=useRef(0),planGeneration=useRef(0),pending=useRef<Record<string,unknown>|null>(null);
  const pendingInfo=useRef({count:0,frames:0});
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;latest.current.onBusy(false);latest.current.onCandidates([]);latest.current.onPreview(null);};},[]);
  useEffect(()=>{try{localStorage.setItem(PREF,JSON.stringify(settings));}catch{}},[settings]);
  const revision=props.state.document.revision,sessionId=props.state.sessionId;
  useEffect(()=>{
    const token=++generation.current;planGeneration.current++;setStatus(null);setPlan(null);setError('');analysis.current=null;
    latest.current.onCandidates([]);latest.current.onPreview(null);
    const stillApplied=applied?.revision===revision&&applied.sessionId===sessionId;
    if(!stillApplied)setApplied(null);
    if(!started||stillApplied||!tracks.length||pending.current)return;
    const controller=new AbortController();let id:string|undefined,timer:ReturnType<typeof setTimeout>;
    const cancel=(value:string)=>void nativeRequest(props.projectId,'/silence/cancel',{sessionId,analysisId:value}).catch(()=>{});
    const current=()=>!controller.signal.aborted&&token===generation.current;
    const poll=async()=>{
      try{
        const result=await nativeRequest<SilenceStatus>(props.projectId,'/silence/status',undefined,controller.signal,{sessionId,analysisId:id!});
        if(!current())return;setStatus(result);if(result.phase==='analyzing')timer=setTimeout(poll,250);else if(result.phase==='failed')setError(result.error??'解析に失敗しました');
      }catch(e){if(current())setError(message(e));}
    };
    void nativeRequest<SilenceStatus>(props.projectId,'/silence/analyze',{sessionId,expectedRevision:revision,trackIds:tracks}).then(result=>{
      id=result.analysisId;if(!current()){cancel(id);return;}analysis.current=id;setStatus(result);void poll();
    }).catch(e=>{if(current())setError(message(e));});
    return()=>{controller.abort();clearTimeout(timer);if(id)cancel(id);};
  },[props.projectId,revision,sessionId,tracks,retry,started]);
  useEffect(()=>{
    const token=++planGeneration.current;setPlan(null);latest.current.onPreview(null);
    // Keep the previous overlay during the short settings debounce to avoid flashing.
    // No plan means apply stays disabled until the replacement has been validated.
    if(status?.phase!=='completed')latest.current.onCandidates([]);
    if(status?.phase!=='completed'||pending.current)return;
    const controller=new AbortController();let pollTimer:ReturnType<typeof setTimeout>;
    const current=()=>!controller.signal.aborted&&token===planGeneration.current;
    const publish=(p:SilencePlan)=>{if(!current())return;setPlan(p);latest.current.onCandidates(p.ranges);if(p.phase==='failed')setError(p.error??'配置を確認できませんでした');};
    const poll=async(planId:string)=>{try{const p=await nativeRequest<SilencePlan>(props.projectId,'/silence/plan-status',undefined,controller.signal,{sessionId,planId});publish(p);if(current()&&p.phase==='checking')pollTimer=setTimeout(()=>void poll(planId),200);}catch(e){if(current()){latest.current.onCandidates([]);setError(message(e));}}};
    const timer=setTimeout(()=>{setError('');void nativeRequest<SilencePlan>(props.projectId,'/silence/plan',{sessionId,expectedRevision:revision,analysisId:status.analysisId,settings,...(scope?{scope}:{})},controller.signal).then(p=>{publish(p);if(current()&&p.phase==='checking')void poll(p.planId);}).catch(e=>{if(current()){latest.current.onCandidates([]);setError(message(e));}});},150);
    return()=>{controller.abort();clearTimeout(timer);clearTimeout(pollTimer);};
  },[props.projectId,status?.phase,status?.analysisId,settings,scope,revision,sessionId]);
  const isCurrent=()=>{const s=latest.current.read();return s&&s.sessionId===sessionId&&s.document.revision===revision&&!s.externalChange;};
  const apply=async()=>{
    if(applying||latest.current.blocked||!await latest.current.prepare())return;
    if(!pending.current&&(!plan||plan.phase!=='ready'||!plan.ranges.length||!isCurrent()))return;
    if(!pending.current){pending.current={sessionId,expectedRevision:revision,planId:plan!.planId,planDigest:plan!.planDigest,executionId:crypto.randomUUID()};pendingInfo.current={count:plan!.ranges.length,frames:plan!.removedFrames};}
    const request=pending.current;setApplying(true);latest.current.onBusy(true);setError('');latest.current.onPreview(null);
    try{
      const response=await nativeRequest<NativeSession&{appliedRevision:number}>(props.projectId,'/silence/apply',request);
      pending.current=null;if(!mounted.current)return;
      setUncertain(false);
      if(response.document.revision===response.appliedRevision)setApplied({revision:response.appliedRevision,sessionId,...pendingInfo.current});
      else{setApplied(null);setRetry(n=>n+1);}
      latest.current.accept(response);setPlan(null);latest.current.onCandidates([]);
    }catch(e){if(mounted.current){if(e instanceof NativeApiError&&e.status>=400&&e.status<500){pending.current=null;setUncertain(false);setError(message(e));}else{setError(`${message(e)}。同じ操作の結果を「結果を再確認」で確認できます。`);setUncertain(true);}}}
    finally{if(mounted.current)setApplying(false);latest.current.onBusy(pending.current!==null);}
  };
  const audition=async(index:number)=>{
    if(!plan||plan.phase!=='ready'||latest.current.blocked||!isCurrent())return;
    try{
      const token=planGeneration.current,doc=await nativeRequest<SequenceDocument>(props.projectId,'/silence/preview',{sessionId,expectedRevision:revision,planId:plan.planId});
      if(!mounted.current||!isCurrent()||token!==planGeneration.current)return;
      const item=plan.ranges[index];if(!item)return;
      const cutBefore=plan.ranges.slice(0,index).reduce((n,c)=>n+c.endFrame-c.startFrame,0),seam=item.startFrame-cutBefore,fps=doc.fps.num/doc.fps.den;
      latest.current.onPreview(doc,Math.max(0,seam-Math.round(fps*1.5)),Math.min(doc.sequenceEndFrame,seam+Math.round(fps*1.5)));
    }catch(e){if(mounted.current)setError(message(e));}
  };
  return {settings,setSettings,tracks,setTracks,scope,setScope,status,plan,error,applying,uncertain,applied,apply,audition,started,reanalyze:()=>{setApplied(null);setStarted(true);setRetry(n=>n+1);},canUndo:!!applied&&applied.sessionId===sessionId&&applied.revision===revision};
}
