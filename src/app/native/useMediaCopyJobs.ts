import {useEffect,useMemo,useRef,useState} from 'react';
import {useEventChannelWithSync} from '../eventBus';
import type {CopyItemPhase,CopyJobView} from '../../shared/mediaCopy';

const FINISHED_ITEM:readonly CopyItemPhase[]=['done','failed','cancelled'],NO_JOBS:CopyJobView[]=[];
/** SSE copy-jobs チャネルの一覧型メッセージ。 */
export function copyJobsMessage(raw:unknown):CopyJobView[]|null{
  if(!raw||typeof raw!=='object'||(raw as {type?:unknown}).type!=='list'||!Array.isArray((raw as {jobs?:unknown}).jobs))return null;
  return (raw as {jobs:CopyJobView[]}).jobs;
}
/**
 * 案件のコピーの作業（設計 §6）。案件を開き直した時・通知の再接続の時は一覧を取り直す（接続時と sync で一覧が届く）。
 * 裏で接続が変わった素材があれば、その作業の終わり（running でなくなった時）に onConnected で素材を読み直させる（状態確認の 確認中→ok だけに頼らない）。
 * 1本ごとには知らせない: 読み直しはプレビューとタイムラインを作り直す（編集・再生の手が止まる）。つなぎ替えた後も元の素材は消えず、同じ中身なので、作業の終わりにまとめて1回で足りる。
 * 同じ一覧で複数の作業が終わっても1回。開いて最初の一覧に既にある完了分は数えない（素材は読み込んだばかり）。
 * onSettled: この画面で走っているのを見ていた作業（このエディターの作業）が終わった・止まった・ドライブの接続待ちになった時に1回（完了の通知）。
 * activeAssetIds: このエディターが動かしている作業でコピー中・待ち中の素材（別のエディター・回収を待つ前回の作業＝notThisProcess は含めない）。
 */
export function useMediaCopyJobs(projectId:string,onConnected:()=>void,onSettled?:(job:CopyJobView)=>void){
  const [jobs,setJobs]=useState<CopyJobView[]>([]),[listedFor,setListedFor]=useState<string|null>(null);
  // seen: 数えた（または最初の一覧にあった）完了の項目。reconnected: 新しくつなぎ替えた素材があり、終わりを待っている作業。running: 走っているのを見た作業。primedFor: 最初の一覧を受けた案件
  const seen=useRef(new Set<string>()),reconnected=useRef(new Set<string>()),running=useRef(new Set<string>()),primedFor=useRef<string|null>(null);
  const callbacks=useRef({onConnected,onSettled});callbacks.current={onConnected,onSettled};
  useEffect(()=>{setJobs([]);setListedFor(null);primedFor.current=null;},[projectId]);
  useEventChannelWithSync('copy-jobs',projectId,raw=>{
    const list=copyJobsMessage(raw);if(!list)return;const mine=list.filter(job=>job.projectId===projectId);setJobs(mine);setListedFor(projectId);
    const first=primedFor.current!==projectId;
    if(first){primedFor.current=projectId;seen.current=new Set();reconnected.current=new Set();running.current=new Set();}
    let reload=false;const settled:CopyJobView[]=[];
    for(const job of mine){
      for(const item of job.items)if(item.phase==='done'){const key=`${job.jobId}:${item.itemId}`;if(!seen.current.has(key)){seen.current.add(key);if(!first)reconnected.current.add(job.jobId);}}
      if(job.state!=='running'&&reconnected.current.delete(job.jobId))reload=true;
      if(job.state==='running'&&!job.notThisProcess)running.current.add(job.jobId);
      else if(job.state!=='running'&&running.current.delete(job.jobId))settled.push(job);
    }
    if(reload)callbacks.current.onConnected();
    for(const job of settled)callbacks.current.onSettled?.(job);
  });
  const shown=listedFor===projectId?jobs:NO_JOBS;
  const activeAssetIds=useMemo(()=>new Set(shown.filter(job=>job.state==='running'&&!job.notThisProcess)
    .flatMap(job=>job.items.filter(item=>item.assetId&&!FINISHED_ITEM.includes(item.phase)).map(item=>item.assetId!))),[shown]);
  return {jobs:shown,activeAssetIds};
}
