import {useEffect,useRef,useState} from 'react';
import type {SequenceAsset} from '../../core/sequence/model';

/** checking: サーバが中身の照合を裏で続けている（SD カードの大きな素材は数分）。
 * copying: 速いドライブへコピーしている（設計 §5）。どちらもエラーではない。 */
export type ReferenceStatus={state:'ok'|'checking'|'copying'|'missing'|'mismatch'|'invalid';message?:string};
const STATES:ReferenceStatus['state'][]=['ok','checking','copying','missing','mismatch','invalid'];
/** 確認の間隔。照合中・コピー中の素材がある間は短く（終わったらすぐ表示を戻す。照合中から戻った素材は読み直す）。 */
export const REFERENCE_CHECKING_INTERVAL_MS=2000,REFERENCE_IDLE_INTERVAL_MS=5000;
/** 状態確認の 15 秒の打ち切りがこの回数続いたら、ドライブ自体が応答しないものとして invalid にする。 */
export const REFERENCE_TIMEOUTS_BEFORE_INVALID=3;
const busy=(status:ReferenceStatus)=>status.state==='checking'||status.state==='copying';
/** 接続が確認できない・中身が違うなど、利用者に知らせる状態（照合中・コピー中は含めない）。 */
export const referenceUnavailable=(status:ReferenceStatus|undefined)=>!!status&&status.state!=='ok'&&!busy(status);
/** Check links even when the disconnected clip is not currently being played. */
export function useNativeReferenceStatus(projectId:string,assets:SequenceAsset[]|undefined,refresh:number,onRecovered:()=>void) {
  const key=JSON.stringify((assets??[]).filter(asset=>asset.file.startsWith('.harness/references/')).map(asset=>asset.id));
  const [statuses,setStatuses]=useState<Record<string,ReferenceStatus>>({});
  const recovered=useRef(onRecovered);recovered.current=onRecovered;
  useEffect(()=>{
    const ids=JSON.parse(key) as string[],controller=new AbortController(),timedOut:Record<string,number>={};let timer:ReturnType<typeof setTimeout>|undefined,running=false,previous:Record<string,ReferenceStatus>={};
    setStatuses({});if(!ids.length)return;
    const check=async()=>{
      if(running||controller.signal.aborted)return;clearTimeout(timer);
      // 隠れている間は確かめない。ただし照合中の素材がある間は続ける（サーバは 30 秒問われない未開始の照合を捨てるため）。コピー中だけでは続けない（読み直しはコピーの作業の終わりに行う）。
      if(document.visibilityState==='hidden'&&!Object.values(previous).some(status=>status.state==='checking'))return;
      running=true;const next:Record<string,ReferenceStatus>={};
      try{
        for(const id of ids){
          if(controller.signal.aborted)return;
          const timeout=AbortSignal.timeout(15000);
          try{
            const response=await fetch(`/api/sequence/reference/status?${new URLSearchParams({id:projectId,asset:id})}`,{signal:AbortSignal.any([controller.signal,timeout])});
            if(!response.ok)throw new Error('素材の接続を確認できませんでした。');
            const status=await response.json() as ReferenceStatus;
            if(!STATES.includes(status.state))throw new Error('素材の接続を確認できませんでした。');
            next[id]=status;timedOut[id]=0;
          }catch{
            if(controller.signal.aborted)return;
            // サーバはすぐ答えるので通常は起きない。時間切れは照合が終わっていないだけで、接続できないとは限らない（続くならドライブが応答していない）。
            timedOut[id]=timeout.aborted?(timedOut[id]??0)+1:0;
            next[id]=timeout.aborted&&timedOut[id]!<REFERENCE_TIMEOUTS_BEFORE_INVALID?{state:'checking',message:'素材の確認に時間がかかっています。'}
              :{state:'invalid',message:'素材の接続を確認できません。ドライブの接続を確認してください。'};
          }
        }
        if(controller.signal.aborted)return;
        // 照合中・未接続などから ok に戻った素材は、読み込みに失敗していた再生・波形などを読み直す。
        // コピー中から ok は読み直さない: コピーの作業の終わりにまとめて1回読み直す（useMediaCopyJobs。1本ごとにプレビュー・タイムラインを作り直さない）。
        const restored=ids.some(id=>previous[id]&&previous[id]!.state!=='ok'&&previous[id]!.state!=='copying'&&next[id]?.state==='ok');
        if(JSON.stringify(previous)!==JSON.stringify(next))setStatuses(next);
        previous=next;if(restored)recovered.current();
      }finally{
        running=false;
        if(!controller.signal.aborted)timer=setTimeout(()=>void check(),Object.values(previous).some(busy)?REFERENCE_CHECKING_INTERVAL_MS:REFERENCE_IDLE_INTERVAL_MS);
      }
    };
    const wake=()=>{void check();};void check();window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
    return()=>{controller.abort();clearTimeout(timer);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
  },[projectId,key,refresh]);
  return statuses;
}
