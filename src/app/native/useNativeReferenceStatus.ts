import {useEffect,useRef,useState} from 'react';
import type {SequenceAsset} from '../../core/sequence/model';

export type ReferenceStatus={state:'ok'|'missing'|'mismatch'|'invalid';message?:string};
/** Check links even when the disconnected clip is not currently being played. */
export function useNativeReferenceStatus(projectId:string,assets:SequenceAsset[]|undefined,refresh:number,onRecovered:()=>void) {
  const key=JSON.stringify((assets??[]).filter(asset=>asset.file.startsWith('.harness/references/')).map(asset=>asset.id));
  const [statuses,setStatuses]=useState<Record<string,ReferenceStatus>>({});
  const recovered=useRef(onRecovered);recovered.current=onRecovered;
  useEffect(()=>{
    const ids=JSON.parse(key) as string[],controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,running=false,previous:Record<string,ReferenceStatus>={};
    setStatuses({});if(!ids.length)return;
    const check=async()=>{
      if(running||controller.signal.aborted)return;clearTimeout(timer);
      if(document.visibilityState==='hidden')return;
      running=true;const next:Record<string,ReferenceStatus>={};
      try{
        for(const id of ids){
          if(controller.signal.aborted)return;
          try{
            const response=await fetch(`/api/sequence/reference/status?${new URLSearchParams({id:projectId,asset:id})}`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
            if(!response.ok)throw new Error('素材の接続を確認できませんでした。');
            const status=await response.json() as ReferenceStatus;
            if(!['ok','missing','mismatch','invalid'].includes(status.state))throw new Error('素材の接続を確認できませんでした。');
            next[id]=status;
          }catch{
            if(controller.signal.aborted)return;
            next[id]={state:'invalid',message:'素材の接続を確認できません。ドライブの接続を確認してください。'};
          }
        }
        if(controller.signal.aborted)return;
        const restored=ids.some(id=>previous[id]&&previous[id]!.state!=='ok'&&next[id]?.state==='ok');
        if(JSON.stringify(previous)!==JSON.stringify(next))setStatuses(next);
        previous=next;if(restored)recovered.current();
      }finally{running=false;if(!controller.signal.aborted)timer=setTimeout(()=>void check(),5000);}
    };
    const wake=()=>{void check();};void check();window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
    return()=>{controller.abort();clearTimeout(timer);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};
  },[projectId,key,refresh]);
  return statuses;
}
