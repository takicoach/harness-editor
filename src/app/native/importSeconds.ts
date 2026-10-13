import {readVideoDurations} from './videoDuration';

/**
 * 束ごとの長さの先読み（設計 §1）。ページの中で1つ持ち、鍵は束の ID と素材の key。読めた分から書き足し、聞いている画面に知らせる。
 * ホームから編集画面へは、NativeApp ではページを読み直さずに移るので、この記録をそのまま使い、移った後に読めた分も枠に出る。
 * ページを読み直す移動（既定の navigateToProject・再読み込み）ではこの記録が消えるので、遷移の直前に読めている分を sessionStorage に残し、
 * 開いた編集画面が自分の案件の分を引き継ぐ（handOverImportSeconds / takeOverImportSeconds）。まだ読めていない分は、サーバの調査の結果を待つ（枠は推定）。
 */
const lengths=new Map<string,Map<string,number>>(),readers=new Map<string,AbortController>(),listeners=new Set<()=>void>();
export function importSeconds(batchId:string,key:string):number|undefined{return lengths.get(batchId)?.get(key);}
export function noteImportSeconds(batchId:string,entries:Iterable<readonly [string,number]>):void{
  const known=lengths.get(batchId)??new Map<string,number>();lengths.set(batchId,known);
  for(const [key,seconds] of entries)known.set(key,seconds);
  for(const listener of listeners)listener();
}
/** 配置・取り消し・失敗で枠が要らなくなった束の先読みを止め、長さを捨てる。 */
export function forgetImportSeconds(batchId:string):void{readers.get(batchId)?.abort();readers.delete(batchId);lengths.delete(batchId);}
export function subscribeImportSeconds(listener:()=>void):()=>void{listeners.add(listener);return ()=>{listeners.delete(listener);};}

export function importSecondsHandOverKey(projectId:string):string{return `harness.importSeconds.${projectId}`;}
const lengthRecord=(value:unknown):Array<[string,number]>=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.entries(value).filter((entry):entry is [string,number]=>typeof entry[1]==='number'&&Number.isFinite(entry[1])&&entry[1]>0):[];
/** 遷移の直前に、その束のいま読めている長さを案件ごとに残す。書けなければ残さない（無くても枠は推定で出る）。 */
export function handOverImportSeconds(projectId:string,batchId:string):void{
  const known=lengths.get(batchId);if(!known?.size)return;
  try{
    const key=importSecondsHandOverKey(projectId),raw=sessionStorage.getItem(key);let stored:Record<string,unknown>={};
    try{const parsed:unknown=raw?JSON.parse(raw):null;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))stored=parsed as Record<string,unknown>;}catch{/* 壊れた記録は上書きする */}
    sessionStorage.setItem(key,JSON.stringify({...stored,[batchId]:Object.fromEntries(known)}));
  }catch{/* 書けない環境では引き継がない */}
}
/** 開いた編集画面が自分の案件の分を読んで記録に移し、消す（1回だけ）。読めない・壊れている時は何もしない。 */
export function takeOverImportSeconds(projectId:string):void{
  let raw:string|null=null;
  try{const key=importSecondsHandOverKey(projectId);raw=sessionStorage.getItem(key);if(raw!==null)sessionStorage.removeItem(key);}catch{return;}
  if(!raw)return;
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return;
  for(const [batchId,value] of Object.entries(parsed)){const entries=lengthRecord(value);if(entries.length)noteImportSeconds(batchId,entries);}
}

/**
 * 束の作成と長さの先読みを並行に行う（先読みで束の作成を待たせない）。files が無ければ読まない（ブラウザ版）。
 * 束ができる前に読めた分は束ができた時に、後の分は読めた時に記録する。束を作れなければ新しく読み始めない。
 * 返す stop は先読みを止めてその束の長さを捨てる（束の取り消し・失敗）。signal が止まると先読みだけを止める（案件を離れた時。読めた分は残す）。
 */
export async function createWithDurations<T extends {batchId:string}>(files:readonly File[]|null,create:()=>Promise<T>,options:{signal?:AbortSignal}={}):Promise<{view:T;stop():void}>{
  const early=new Map<string,number>(),reading=new AbortController(),leave=()=>reading.abort();let batchId:string|null=null,finished=false;
  if(files?.length){
    if(options.signal?.aborted)reading.abort();else options.signal?.addEventListener('abort',leave,{once:true});
    void readVideoDurations(files,{signal:reading.signal,onRead:(key,seconds)=>{if(batchId===null)early.set(key,seconds);else noteImportSeconds(batchId,[[key,seconds]]);}})
      .catch(()=>undefined).finally(()=>{finished=true;options.signal?.removeEventListener('abort',leave);if(batchId!==null&&readers.get(batchId)===reading)readers.delete(batchId);});
  }
  try{
    const view=await create();batchId=view.batchId;if(early.size)noteImportSeconds(batchId,early);
    if(files?.length&&!finished&&!reading.signal.aborted)readers.set(batchId,reading);
    const id=batchId;return {view,stop:()=>{reading.abort();forgetImportSeconds(id);}};
  }catch(error){reading.abort();throw error;}
}
