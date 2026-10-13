import {useEffect,useRef,useState} from 'react';
import type {Rational} from '../../core/sequence/time';
import {FRAME_PARTIAL_RETRIES,FRAME_RETRY_MAX_MS,FRAME_RETRY_MS,cachedThumb,loadThumbs,nearestThumb,thumbOwner,thumbRetry,thumbTimeKey,type ThumbSource} from './frameThumbnails';

/** 見えているセルの時刻ごとのコマ絵（data URL）。スクロールが 120ms 落ち着いてから1要求。ドラッグ中（frozen）は取りに行かず近い時刻のコマで並べ替える。
 * held（最初のプレビューの絵の前・設計 §2-1「取得の開始」）は取りに行かず、手元にある同じ時刻のコマだけを出す。
 * 描くたびに欠けを数え、キャッシュから消えたコマも取り直す。混雑（503・混雑で落ちたコマ）・通信エラーは待ちを延ばしながら取り直し続け、400番台では止める。
 * 切り出せないコマと 503 以外の 500番台は、同じ表示（素材・時刻の組・文書の版）につき FRAME_PARTIAL_RETRIES 回まで（そのために ffmpeg を走らせ続けない）。 */
export function useFrameThumbnails(source:ThumbSource|null,times:readonly Rational[],frozen:boolean,held=false,revision=0):ReadonlyMap<string,string>{
  const tries=useRef({view:'',count:0}),[spent,setSpent]=useState(''),[,setVersion]=useState(0),owner=source?thumbOwner(source):'',keys=times.map(thumbTimeKey),request=JSON.stringify([owner,keys]);
  // 回数を数える単位。尽きた表示（spent）は、時刻の組か版が変わるまで取り直さない。
  const view=`${request}@${revision}`,exhausted=spent===view;
  const result=new Map<string,string>();
  if(source)times.forEach((time,index)=>{const key=keys[index]!,url=cachedThumb(owner,key)??(frozen?nearestThumb(owner,time.num/time.den):undefined);if(url)result.set(key,url);});
  const complete=keys.every(key=>cachedThumb(owner,key));
  useEffect(()=>{
    if(tries.current.view!==view)tries.current={view,count:0};
    if(!source||frozen||held||complete||exhausted)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,attempt=0;
    const again=()=>{timer=setTimeout(load,Math.min(FRAME_RETRY_MAX_MS,FRAME_RETRY_MS*2**attempt++));};
    const limited=()=>{if(tries.current.count++<FRAME_PARTIAL_RETRIES)again();else setSpent(view);};
    const load=()=>{timer=undefined;void loadThumbs(source,times,controller.signal).then(({busy})=>{
      if(controller.signal.aborted)return;setVersion(value=>value+1);
      if(keys.some(key=>!cachedThumb(owner,key)))(busy?again:limited)();
    },error=>{if(controller.signal.aborted)return;const retry=thumbRetry(error);if(retry==='busy')again();else if(retry==='limited')limited();});};
    timer=setTimeout(load,120);
    return()=>{controller.abort();if(timer)clearTimeout(timer);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[request,frozen,held,complete,spent,exhausted]);
  return result;
}
