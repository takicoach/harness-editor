import type {Rational} from '../../core/sequence/time';
import {FRAME_THUMB_HEIGHT} from '../../shared/filmstripHeight';

/** 設計 §2-1: コマ絵はサーバが切り出す。ブラウザは <video> を作らず、同時 2 本までで取りに行く（6本の接続を使い切らない）。
 * 確定値は事前の測定で決めた。高さはサーバが受ける値と同じ所（src/shared/filmstripHeight.ts）から出す。 */
export {FRAME_THUMB_HEIGHT};
/** 取り直しの待ち: 1.5→3→6→10秒（以後10秒）。サーバは待ち行列があふれると最低優先のコマ絵を落とす（ffmpegGate）ので、画面側が取り直す。 */
export const FRAME_FETCH_CONCURRENCY=2,FRAME_RETRY_MS=1500,FRAME_RETRY_MAX_MS=10000,FRAME_PARTIAL_RETRIES=3,MAX_CACHED_THUMBS=2000;
export interface ThumbSource {projectId:string;assetId:string;streamIndex:number;fingerprint:string}
export const thumbTimeKey=(time:Rational)=>`${time.num}/${time.den}`;
export const thumbOwner=(source:ThumbSource)=>JSON.stringify([source.projectId,source.assetId,source.fingerprint,source.streamIndex,FRAME_THUMB_HEIGHT]);
interface Thumb {seconds:number;url:string}
/** 古い順＝最後に読んだ（入れた）順。表示に使ったコマは読むたびに新しい側へ並べ直し、見えている絵から消さない。 */
const owners=new Map<string,Map<string,Thumb>>();let cached=0;
function touch(owner:string):Map<string,Thumb>|undefined{const map=owners.get(owner);if(map){owners.delete(owner);owners.set(owner,map);}return map;}
export function cachedThumb(owner:string,key:string):string|undefined{
  const map=owners.get(owner),thumb=map?.get(key);if(!thumb)return undefined;
  touch(owner);map!.delete(key);map!.set(key,thumb);return thumb.url;
}
/** ドラッグ中の並べ替え用: その素材で取得済みのうち、時刻がいちばん近いコマ。 */
export function nearestThumb(owner:string,seconds:number):string|undefined{
  let best:Thumb|undefined;for(const thumb of owners.get(owner)?.values()??[])if(!best||Math.abs(thumb.seconds-seconds)<Math.abs(best.seconds-seconds))best=thumb;return best?.url;
}
function remember(owner:string,key:string,thumb:Thumb){
  let map=touch(owner);if(!map){map=new Map();owners.set(owner,map);}
  if(!map.has(key))cached++;map.delete(key);map.set(key,thumb);
  for(const [name,entries] of owners){
    if(cached<=MAX_CACHED_THUMBS)break;
    for(const old of entries.keys()){if(cached<=MAX_CACHED_THUMBS)break;entries.delete(old);cached--;}
    if(!entries.size)owners.delete(name);
  }
}
/** 応答の状態つきの失敗。 */
export class ThumbLoadError extends Error {constructor(message:string,readonly status:number){super(message);}}
/** 取り直し方: busy＝混雑（503）・通信エラーは取り直し続ける。limited＝503 以外の 500番台は表示につき回数を限る。stop＝400番台など。 */
export const thumbRetry=(error:unknown):'busy'|'limited'|'stop'=>error instanceof ThumbLoadError?error.status===503?'busy':error.status>=500?'limited':'stop':error instanceof TypeError?'busy':'stop';
interface Task {run():Promise<void>}
const queue:Task[]=[];let active=0,generation=0;
function pump(){
  while(active<FRAME_FETCH_CONCURRENCY&&queue.length){const task=queue.shift()!,mine=generation;active++;
    // resetThumbs の前に出た要求は、後の勘定を狂わせない。
    void task.run().finally(()=>{if(mine!==generation)return;active--;pump();});}
}
/** 欠けている時刻だけを1要求で取りに行き、手元のキャッシュに入れる。取り消すと待ち行列から外れ、送信中ならサーバ側の切り出しも止まる。
 * busy: 応答の失敗に混雑で落ちたコマがあった（画面は 503 と同じく取り直す）。 */
export function loadThumbs(source:ThumbSource,times:readonly Rational[],signal:AbortSignal):Promise<{busy:boolean}>{
  const owner=thumbOwner(source),missing=[...new Map(times.map(time=>[thumbTimeKey(time),time] as const)).values()].filter(time=>!cachedThumb(owner,thumbTimeKey(time)));
  if(!missing.length)return Promise.resolve({busy:false});
  return new Promise((resolve,reject)=>{
    const task:Task={run:async()=>{
      signal.removeEventListener('abort',abort);
      try{
        signal.throwIfAborted();
        const query=new URLSearchParams({id:source.projectId,asset:source.assetId,stream:String(source.streamIndex),height:String(FRAME_THUMB_HEIGHT),times:missing.map(thumbTimeKey).join(',')});
        const response=await fetch(`/api/sequence/frames?${query}`,{signal});
        if(!response.ok){const body=await response.json().catch(()=>({}));throw new ThumbLoadError(typeof body?.error==='string'?body.error:'コマ絵を読み込めませんでした',response.status);}
        const body=await response.json();
        for(const item of Array.isArray(body.frames)?body.frames:[]){
          if(typeof item?.time!=='string'||typeof item.data!=='string'||!item.data.startsWith('data:image/jpeg;base64,'))continue;
          const [num=NaN,den=0]=item.time.split('/').map(Number);if(!Number.isFinite(num)||!den)continue;
          remember(owner,item.time,{seconds:num/den,url:item.data});
        }
        resolve({busy:Array.isArray(body.failed)&&body.failed.some((item:{busy?:unknown})=>item?.busy===true)});
      }catch(error){reject(error);}
    }};
    const abort=()=>{const index=queue.indexOf(task);if(index>=0){queue.splice(index,1);reject(signal.reason);}};
    signal.addEventListener('abort',abort,{once:true});queue.push(task);pump();
  });
}
/** 試験用: 送る前の待ち行列の数。 */
export const queuedThumbRequests=()=>queue.length;
/** 試験用 */
export function resetThumbs():void{owners.clear();cached=0;queue.length=0;active=0;generation++;}
