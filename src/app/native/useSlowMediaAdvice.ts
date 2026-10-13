import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {MAX_COPY_ITEMS,type SlowMediaAdvice} from '../../shared/mediaCopy';
import type {ReferenceStatus} from './useNativeReferenceStatus';
import {fetchSlowMediaAdvice,suppressSlowMedia} from './mediaCopyApi';

/** 「今回はこのまま」を選んだ素材（案件ごと）。この画面を閉じるまで出さない（案件を切り替えて戻っても出さない。ページを読み直すと消える）。 */
const keptOnce=new Map<string,Set<string>>();
export const SLOW_ADVICE_REFRESH_MS=5000;
/**
 * このページで判断待ち（decision 付き）として見た・判断を送った取り込みの束（案件ごと）。追加時の「今回はこのまま」を素材 ID へ引き継ぐのは、この束だけ
 * （ディスクに残る前のページの束は引き継がない＝読み直すと案内が再び出る。設計 §2「この画面を閉じるまで」）。「今後この場所では出さない」はサーバが案内から外すので引き継がない。
 */
const askedBatches=new Map<string,Set<string>>();
export function noteAskedBatch(projectId:string,batchId:string):void{const set=askedBatches.get(projectId)??new Set<string>();set.add(batchId);askedBatches.set(projectId,set);}
export const wasAskedBatch=(projectId:string,batchId:string)=>askedBatches.get(projectId)?.has(batchId)??false;
/** 試験用: このページの記憶（「今回はこのまま」と見た束）を忘れる（ページを読み直したのと同じ）。 */
export const slowAdviceTesting={forget(){keptOnce.clear();askedBatches.clear();}};
const isNumber=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
/** サーバの応答の形を確かめる（違えば案内を出さない）。 */
function isAdvice(raw:unknown):raw is SlowMediaAdvice{
  if(!raw||typeof raw!=='object')return false;const value=raw as Record<string,unknown>;
  return Array.isArray(value.targets)&&isNumber(value.unmeasured)&&isNumber(value.totalBytes)&&isNumber(value.totalSeconds)&&value.targets.every(target=>!!target&&typeof target==='object'
    &&typeof (target as Record<string,unknown>).assetId==='string'&&typeof (target as Record<string,unknown>).name==='string'
    &&isNumber((target as Record<string,unknown>).sizeBytes)&&isNumber((target as Record<string,unknown>).seconds));
}
/**
 * 開いた時の案内（設計 §1・§2）。サーバは保存済みの文書のリンク素材を見る（未保存で追加した素材は追加時の案内＝束の判断待ちが扱う）。
 * 素材の状態が変わるたびと、照合中・コピー中の素材がある間は 5 秒ごとに取り直す（速さは裏の照合が読み進めると測れる）。照合済み・コピー中の素材はサーバが出さない。
 * 取り直すのは案内だけで、素材は読み直さない。リンク素材が無い間・enabled でない間（文書が無い・案件の切り替え中）は問わず、案内も出さない。
 * keepOnce: 「今回はこのまま」。keepAlways: 「今後この場所では出さない」をサーバに記録する（ドライブを識別できない素材＝canRemember:false は記録できないので、
 * 記録せず「今回はこのまま」と同じにする）。記録できた素材から順に隠す。失敗したら理由（NativeApiError）で拒否し、残りは出したままにする。
 * 並べるのは1回のコピーの上限（MAX_COPY_ITEMS）まで。残りは more に本数だけ持ち、並べた分を判断する（コピー中・このまま）と次の分が出る。
 */
export function useSlowMediaAdvice(projectId:string,statuses:Record<string,ReferenceStatus>,enabled:boolean){
  // loaded は取得した時の案件と組で持つ（切り替えた直後の描画で前の案件の案内を出さない）
  const [loaded,setLoaded]=useState<{projectId:string;advice:SlowMediaAdvice}|null>(null),[keptVersion,setKeptVersion]=useState(0);
  const latest=useRef(loaded);latest.current=loaded;
  const key=JSON.stringify(Object.entries(statuses).map(([id,status])=>[id,status.state]).sort()),busy=Object.values(statuses).some(status=>status.state==='checking'||status.state==='copying');
  const linked=key!=='[]';
  useEffect(()=>{
    if(!enabled||!linked)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const load=async()=>{
      try{const next:unknown=await fetchSlowMediaAdvice(projectId,controller.signal);if(!controller.signal.aborted&&isAdvice(next))setLoaded({projectId,advice:next});}catch{/* 案内は補助。取れなくても編集は止めない */}
      if(busy&&!controller.signal.aborted)timer=setTimeout(()=>void load(),SLOW_ADVICE_REFRESH_MS);
    };
    void load();return ()=>{controller.abort();clearTimeout(timer);};
  },[projectId,key,busy,enabled,linked]);
  const keepOnce=useCallback((ids:readonly string[])=>{
    const set=keptOnce.get(projectId)??new Set<string>(),before=set.size;for(const id of ids)set.add(id);keptOnce.set(projectId,set);
    if(set.size!==before)setKeptVersion(version=>version+1);
  },[projectId]);
  const keepAlways=useCallback(async(ids:readonly string[])=>{
    const shown=latest.current?.projectId===projectId?latest.current.advice.targets:[],cannot=new Set(shown.filter(target=>target.canRemember===false).map(target=>target.assetId));
    for(const id of ids){if(!cannot.has(id))await suppressSlowMedia(projectId,id);keepOnce([id]);}
  },[projectId,keepOnce]);
  const advice=useMemo(()=>{
    if(!enabled||!loaded||loaded.projectId!==projectId)return null;
    const kept=keptOnce.get(projectId),open=loaded.advice.targets.filter(target=>!kept?.has(target.assetId)),targets=open.slice(0,MAX_COPY_ITEMS);
    return {...loaded.advice,targets,more:open.length-targets.length,totalBytes:targets.reduce((sum,target)=>sum+target.sizeBytes,0),totalSeconds:targets.reduce((sum,target)=>sum+target.seconds,0)};
  },[enabled,loaded,projectId,keptVersion]);   // eslint-disable-line react-hooks/exhaustive-deps
  return {advice,keepOnce,keepAlways};
}
