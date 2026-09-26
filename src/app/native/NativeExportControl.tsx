import {reportEditorError} from './notificationHistory';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {TaskProgress} from '../components/TaskProgress';
import { nativeRequest, NativeApiError, type NativeSession } from './api';
import type { NativeExportStatus,NativeExportPreflight } from '../../shared/nativeExport';
import {nativeExportSettings,type NativeExportSettings} from '../../shared/nativeExport';
import {RENDER_PRESETS,presetLabel,resolutionLabel,type RenderPresetId,type RenderResolution,type RenderQuality} from '../../shared/renderPreset';
import {loadStoredRenderOptions,saveStoredRenderOptions} from '../../shared/renderPresetStorage';

const labels: Record<NativeExportStatus['phase'], string> = { queued:'書き出しを準備中',preparing:'素材を確認中',audio:'音声を準備中',rendering:'映像を描画中',finalizing:'動画を仕上げ中',complete:'書き出しが完了しました',cancelled:'書き出しを中止しました',failed:'書き出しできませんでした' };
const active = (job: NativeExportStatus | null) => !!job && !['complete','cancelled','failed'].includes(job.phase);
type StartRequest = {sessionId:string;expectedRevision:number;executionId:string;settings?:NativeExportSettings};
type History = {jobs:NativeExportStatus[];total:number;nextOffset:number|null};
const storageKey=(id:string)=>`harness.native.export.pending:${id}`;
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const qualityLabels={high:'高画質',standard:'標準',light:'軽量'};
function historySettings(job:NativeExportStatus):string {
  // Older records may know only some fields; never infer their encoding settings.
  return [job.settings&&({full:'そのまま','1080p':'1080p','720p':'720p'})[job.settings.resolution],
    job.outputResolution&&`${job.outputResolution.width}×${job.outputResolution.height}`,
    job.settings&&qualityLabels[job.settings.quality]].filter(Boolean).join(' · ');
}
function readPending(projectId:string):StartRequest|null {
  const raw=sessionStorage.getItem(storageKey(projectId));if(!raw)return null;
  const value=JSON.parse(raw);
  if(typeof value.sessionId!=='string'||typeof value.executionId!=='string'||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)
    throw new Error('前回の書き出し要求を読み取れません。書き出し履歴を確認してください。');
  if(value.settings!==undefined)value.settings=nativeExportSettings(value.settings);
  return value;
}
export function NativeExportControl({ projectId, disabled, revision, resolution,save,onBusyChange,onComplete }: { projectId: string; disabled: boolean; revision: number; resolution:{width:number;height:number};save(): Promise<boolean>;onBusyChange?(busy:boolean):void;
  /** この画面で開始・回収・監視した実行中ジョブが完了した時に、1ジョブにつき1回だけ呼ぶ（履歴で選んだ過去のジョブでは呼ばない）。 */
  onComplete?(job:NativeExportStatus):void }) {
  const [job,setJob]=useState<NativeExportStatus|null>(null),[history,setHistory]=useState<History>({jobs:[],total:0,nextOffset:null});
  const [opened,setOpened]=useState(false),[starting,setStarting]=useState(false),[error,setError]=useState<string|null>(null);
  const [checking,setChecking]=useState(false),[preflight,setPreflight]=useState<NativeExportPreflight|null>(null);
  const warning=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(preflight?.issues.length)warning.current?.focus();},[preflight]);
  useEffect(()=>{const failure=error??job?.error;if(failure)reportEditorError(projectId,'書き出し',failure);},[projectId,error,job?.error]);
  const [configuring,setConfiguring]=useState(false),[settings,setSettings]=useState<NativeExportSettings>(()=>{
    const {resolution,quality}=loadStoredRenderOptions();return {resolution,quality};
  });
  const [pending,setPending]=useState<StartRequest|null>(null),[loading,setLoading]=useState(true);
  const [storageBroken,setStorageBroken]=useState(false);
  const [verifying,setVerifying]=useState(false);
  const historyRefresh=useRef(0);
  const projectEpoch=useRef(0);
  const onCompleteRef=useRef(onComplete);
  // Assign before paint, not during render, so a render that throws or bails out never leaves
  // a stale callback wired in.
  useLayoutEffect(()=>{onCompleteRef.current=onComplete;});
  const completed=useRef(new Set<string>());
  const notifyComplete=(value:NativeExportStatus)=>{
    if(value.phase!=='complete'||completed.current.has(value.id))return;
    completed.current.add(value.id);
    try{onCompleteRef.current?.(value);}
    catch(error){reportEditorError(projectId,'書き出し完了通知',message(error));}
  };
  const record=(value:NativeExportStatus)=>{
    setJob(value);setHistory(previous=>{
      const jobs=[value,...previous.jobs.filter(item=>item.id!==value.id)];
      return {...previous,jobs,total:Math.max(previous.total,jobs.length)};
    });
  };
  const accepted=(value:NativeExportStatus)=>{
    // If browser storage fails, keep the request unresolved; replay is still safe.
    sessionStorage.removeItem(storageKey(projectId));setPending(null);record(value);setError(null);setConfiguring(false);
    // Our own request (including one recovered after a lost response) may already be complete.
    notifyComplete(value);
    // A recovered job outside the loaded page already belongs to the server's total.
    const generation=++historyRefresh.current;
    void nativeRequest<History>(projectId,'/export/list').then(result=>{
      if(generation!==historyRefresh.current)return;
      setHistory(result);
      // The refreshed list can replace our still-running entry with one that already
      // completed between the accept and this refresh, tearing down the poller before
      // it gets a chance to notify. Catch that transition here too.
      const refreshed=result.jobs.find(item=>item.id===value.id);
      if(refreshed)notifyComplete(refreshed);
    }).catch(error=>{if(generation===historyRefresh.current)setError(message(error));});
  };
  useEffect(()=>{
    projectEpoch.current++;historyRefresh.current++;setStarting(false);setChecking(false);
    const controller=new AbortController();setLoading(true);setJob(null);setError(null);setPending(null);setPreflight(null);setHistory({jobs:[],total:0,nextOffset:null});
    let saved:StartRequest|null=null;
    try{saved=readPending(projectId);setPending(saved);setStorageBroken(false);if(saved)setOpened(true);}catch(error){setError(message(error));setStorageBroken(true);}
    void nativeRequest<History>(projectId,'/export/list',undefined,controller.signal).then(async result=>{
      setHistory(result);setJob(result.jobs[0]??null);
      if(saved){
        const lookup=await nativeRequest<{job:NativeExportStatus|null}>(projectId,'/export/request',undefined,controller.signal,{executionId:saved.executionId});
        if(lookup.job)accepted(lookup.job);
      }
    }).catch(error=>{if(!controller.signal.aborted)setError(message(error));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>{projectEpoch.current++;controller.abort();};
  },[projectId]);
  const running=history.jobs.find(active)??null;
  // 書き出し中は音声の補正を受け付けない（サーバーも 409 で拒否する）。上位へ状態だけ伝える。
  useEffect(()=>{onBusyChange?.(!!running||starting);},[running?.id,running?.phase,starting,onBusyChange]);
  useEffect(()=>{
    if(!running)return;
    const controller=new AbortController();let busy=false;
    const timer=setInterval(()=>{
      if(busy)return;busy=true;
      void nativeRequest<NativeExportStatus>(projectId,'/export/status',undefined,controller.signal,{job:running.id}).then(value=>{
        setHistory(previous=>({...previous,jobs:previous.jobs.map(item=>item.id===value.id?value:item)}));
        setJob(previous=>previous?.id===value.id?value:previous);
        // The running → complete transition of a job this screen is watching.
        if(!controller.signal.aborted)notifyComplete(value);
      }).catch(error=>{if(!controller.signal.aborted)setError(message(error));}).finally(()=>{busy=false;});
    },500);
    return ()=>{controller.abort();clearInterval(timer);};
  },[projectId,running?.id,running?.phase]);
  const submit=async(request:StartRequest)=>{
    const generation=projectEpoch.current;
    try{const value=await nativeRequest<NativeExportStatus>(projectId,'/export',request);if(generation===projectEpoch.current)accepted(value);}
    catch(error){
      if(generation!==projectEpoch.current)return;
      // A successful absence lookup alone cannot prove a delayed POST will never arrive.
      // Always retain and replay the exact request until the server returns a job or rejects it.
      if(error instanceof NativeApiError&&[400,409,422,429].includes(error.status)){
        sessionStorage.removeItem(storageKey(projectId));setPending(null);throw error;
      }
      const result=await nativeRequest<{job:NativeExportStatus|null}>(projectId,'/export/request',undefined,undefined,{executionId:request.executionId}).catch(()=>null);
      if(generation!==projectEpoch.current)return;
      if(result?.job)accepted(result.job);else throw error;
    }
  };
  const start=async()=>{
    setOpened(true);if(starting||loading||storageBroken)return;
    if(running&&!pending){setJob(running);return;}
    const generation=projectEpoch.current,owns=()=>generation===projectEpoch.current;
    setStarting(true);setPreflight(null);if(!pending)setError(null);
    try {
      if(pending){await submit(pending);return;}
      const selectedSettings=nativeExportSettings(settings);
      // Match the old dialog's start-time memory without making it authoritative
      // for pending retries. Only the two native fields enter the frozen request.
      saveStoredRenderOptions({...loadStoredRenderOptions(),...selectedSettings});
      if(!await save()||!owns())return;
      const state=await nativeRequest<NativeSession>(projectId,'/session',{});
      if(!owns())return;
      setChecking(true);
      const checked=await nativeRequest<NativeExportPreflight>(projectId,'/export/preflight',{sessionId:state.sessionId,expectedRevision:state.document.revision});
      if(!owns())return;setPreflight(checked);if(checked.issues.length)return;
      const request={sessionId:state.sessionId,expectedRevision:state.document.revision,executionId:crypto.randomUUID(),settings:selectedSettings};
      sessionStorage.setItem(storageKey(projectId),JSON.stringify(request));setPending(request);
      await submit(request);
    }catch(error){if(owns())setError(message(error));}finally{if(owns()){setStarting(false);setChecking(false);}}
  };
  const older=async()=>{
    if(history.nextOffset===null||loading)return;setLoading(true);
    try{
      const result=await nativeRequest<History>(projectId,'/export/list',undefined,undefined,{offset:String(history.nextOffset)});
      setHistory(previous=>({...result,jobs:[...previous.jobs,...result.jobs.filter(item=>!previous.jobs.some(existing=>existing.id===item.id))]}));
    }catch(error){setError(message(error));}finally{setLoading(false);}
  };
  const download=async(value:NativeExportStatus)=>{
    if(verifying||!value.downloadUrl)return;setVerifying(true);setError(null);
    try {
      await nativeRequest(projectId,'/export/verify',undefined,undefined,{job:value.id});
      const anchor=document.createElement('a');anchor.href=value.downloadUrl;anchor.download='';document.body.append(anchor);anchor.click();anchor.remove();
    }catch(error){setError(message(error));}finally{setVerifying(false);}
  };
  return <div className="native-export">
    <button className="btn-primary" data-tutorial="export" data-native-script-flush disabled={starting||loading||storageBroken||(disabled&&!pending&&!running)} onClick={()=>{if(pending||running)void start();else{setOpened(true);setConfiguring(true);setJob(null);setError(null);}}}>{pending?'開始状況を再確認':running?'書き出し中…':starting?checking?'素材を確認中…':'保存中…':'書き出し'}</button>
    {(history.jobs.length>0||error||!!preflight?.issues.length)&&!opened&&<button aria-label="書き出し結果を表示" onClick={()=>setOpened(true)}>↓</button>}
    {opened&&<section className="native-export-panel" role="region" aria-label="動画の書き出し">
      <div className="native-export-heading"><strong role="heading" aria-level={3}>{pending?'開始状況を確認してください':starting?checking?'素材と接続を確認しています':'書き出しを準備しています':job?labels[job.phase]:'動画の書き出し'}</strong><button aria-label="書き出しパネルを閉じる" onClick={()=>setOpened(false)}>×</button></div>
      {starting&&<TaskProgress compact label={checking?'素材と接続を確認しています':'編集を保存して書き出しを準備しています'}/>}
      {loading&&<TaskProgress compact label="書き出し履歴を確認しています"/>}
      {verifying&&<TaskProgress compact label="動画を確認しています"/>}
      {!!preflight?.issues.length&&<div ref={warning} tabIndex={-1} className="native-export-preflight" role="alert"><strong>素材を確認できないため、書き出しを開始していません</strong>
        <ul>{preflight.issues.map(issue=><li key={issue.assetId}><b>{issue.name}</b><span>{issue.message}</span></li>)}</ul>
        <p>接続を確認し、場所を変更した素材は素材欄の「リンクし直す」で指定してから、もう一度開始してください。</p>
      </div>}
      {configuring&&!pending&&!running&&<fieldset className="native-export-settings" disabled={starting||disabled||loading||storageBroken}>
        <legend>書き出し設定</legend>
        <div className="native-export-presets">{(Object.keys(RENDER_PRESETS) as RenderPresetId[]).map(id=><button key={id} aria-pressed={settings.resolution===RENDER_PRESETS[id].resolution&&settings.quality===RENDER_PRESETS[id].quality} onClick={()=>setSettings(nativeExportSettings({resolution:RENDER_PRESETS[id].resolution,quality:RENDER_PRESETS[id].quality}))}>{presetLabel(id,resolution.width===resolution.height?'square':resolution.width>resolution.height?'landscape':'portrait')}</button>)}</div>
        <label>解像度<select aria-label="書き出し解像度" value={settings.resolution} onChange={event=>setSettings(previous=>({...previous,resolution:event.target.value as RenderResolution}))}>
          <option value="full">そのまま（{resolutionLabel(resolution.width,resolution.height,'full')}）</option>
          <option value="1080p">1080p（{resolutionLabel(resolution.width,resolution.height,'1080p')}）</option>
          <option value="720p">720p・軽量（{resolutionLabel(resolution.width,resolution.height,'720p')}）</option>
        </select></label>
        <label>画質<select aria-label="書き出し画質" value={settings.quality} onChange={event=>setSettings(previous=>({...previous,quality:event.target.value as RenderQuality}))}>
          <option value="high">高画質</option><option value="standard">標準</option><option value="light">軽量</option>
        </select></label>
        <p className="native-subtle">{resolutionLabel(resolution.width,resolution.height,settings.resolution)} · 編集を保存して、この設定で書き出します。</p>
        <p className="native-subtle">1080p は拡大せず、720p は元の寸法の2/3に縮小します。</p>
        <p className="native-subtle">開始前に素材と接続を確認します。外付けの素材は完了まで接続を保ち、移動・変更しないでください。</p>
        <button data-native-script-flush onClick={()=>void start()}>書き出し開始</button>
      </fieldset>}
      {pending&&<p className="native-subtle">前回の開始要求を確認できていません。「開始状況を再確認」で同じ要求を確認できます。</p>}
      {job?.historical&&<p className="native-subtle">以前の書き出しです。動画を保存するときにファイルを確認します。</p>}
      {job?.settings&&job.outputResolution&&<p className="native-subtle">{job.outputResolution.width}×{job.outputResolution.height} · {qualityLabels[job.settings.quality]}</p>}
      {job&&<><p className="native-subtle">{new Date(job.createdAt).toLocaleString('ja-JP')} 開始{revision!==job.revision?' · 開始時の編集内容を書き出します':''}</p>
        {active(job)&&<><TaskProgress label={labels[job.phase]} value={job.phase==='rendering'&&job.totalFrames?job.completedFrames/job.totalFrames:job.phase==='audio'?job.audioProgress:undefined} detail={job.phase==='rendering'?`${job.completedFrames} / ${job.totalFrames} フレーム`:undefined}/>
          <button onClick={()=>{void nativeRequest<NativeExportStatus>(projectId,'/export/cancel',{},undefined,{job:job.id}).then(record).catch(error=>setError(message(error)));}}>中止</button></>}
        {job.phase==='complete'&&job.downloadUrl&&<a className="native-export-download" href={job.downloadUrl} download aria-disabled={verifying} onClick={event=>{event.preventDefault();void download(job);}}>{verifying?'動画を確認中…':'動画を保存'}</a>}
      </>}
      {(error||job?.error)&&<p role="alert" className="native-export-error">{error??job?.error}</p>}
      {history.jobs.length>0&&<details className="native-export-history"><summary>書き出し履歴（{history.total}件）</summary>
        <ul aria-label="書き出し履歴">{history.jobs.map(item=><li key={item.id}><button aria-pressed={item.id===job?.id} onClick={()=>{setJob(item);setError(null);}}>
          <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('ja-JP')}</time><span>{labels[item.phase]}</span>
          {historySettings(item)&&<span className="native-subtle">{historySettings(item)}</span>}
        </button></li>)}</ul>
        {history.nextOffset!==null&&<button disabled={loading} onClick={()=>void older()}>以前の履歴を表示</button>}
      </details>}
    </section>}
  </div>;
}
