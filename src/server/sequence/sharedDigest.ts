import {createHash} from 'node:crypto';
import {constants,type Stats} from 'node:fs';
import {open} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {SharedPreparations} from './sharedPreparation';
import {mediaCopyFakeActive} from './mediaCopy/io';
import {UnresponsiveFileError,watchedFs} from './fsWatch';

/** dev・ino・size・mtime・ctime。照合の記憶はこの識別情報ごと（設計 §2-3。参照素材はディスクにも残す）。 */
export const fileIdentity=(s:Pick<Stats,'dev'|'ino'|'size'|'mtimeMs'|'ctimeMs'>)=>JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);
export class FileChangedError extends Error{constructor(){super('読み取り中に素材が変更されました');this.name='FileChangedError';}}
const digests=new SharedPreparations<string>();
/**
 * SD カードの遅い読みの再現専用（1MiB ごとの待ち）。試験の実行中（vitest が VITEST を立てる）と、確かめ終えた実ブラウザ監査の偽装が有効な間（mediaCopyFakeActive）だけ読み、
 * 製品では設定されていても効かない。
 */
const testDelayMs=()=>process.env.VITEST||mediaCopyFakeActive()?Number(process.env.HARNESS_TEST_DIGEST_DELAY_MS??0):0;
/** 読み終わっていない全体読み（組ごと）。work はその読みの中止の合図、lastProgress は最後に 1MiB 読めた時刻（始めた時刻）。
 * 中止された読みも、OS の読み待ちから戻るまで残る。 */
interface Read {work:AbortSignal;lastProgress:number}
const reading=new Map<string,Set<Read>>(),listeners=new Map<string,Set<(bytes:number)=>void>>();
/** 中止されてからこの長さ読み進んでいない読みは「止まった読み」。待ち手が去っただけの読みは次の 1MiB で終わるので数えない。 */
const STUCK_IDLE_MS=10_000;
/**
 * 同じ組（パス・識別情報）に、中止されたのに OS の読み待ちから戻らない読みがあるか。止まった読みは取り消せず、作業用スレッドを1本塞いだまま残る。
 * 中止されていない進行中の読みは数えない（sharedFileDigest で合流できる）。
 */
export function stuckDigestRead(path:string,identity:string):boolean{
  for(const read of reading.get(JSON.stringify([path,identity]))??[])if(read.work.aborted&&Date.now()-read.lastProgress>=STUCK_IDLE_MS)return true;
  return false;
}
/** 同じファイル（同じ識別情報）の SHA-256 は同時に1本だけ。持ち主は共有の待ち合わせで、最初の要求が取り消されても待っている要求のために続ける。
 * onProgress は、この呼び手が待っている間、同じ組の読みが 1MiB 進むごとに、その回に実際に読めたバイト数（最後は 1MiB 未満のことがある）を渡して呼ぶ
 * （合流した呼び手にも。参照素材の照合の見張りと読みの速さの計測が使う）。 */
export function sharedFileDigest(path:string,identity:string,signal?:AbortSignal,onProgress?:(bytes:number)=>void):Promise<string>{
  const key=JSON.stringify([path,identity]);
  const result=digests.get(key,async work=>{
    // 前の待ち手が見限った読みがまだ戻っていなければ、開き直さずに同じ失敗にする（止まった読みを積み重ねて作業用スレッドを使い切らない。
    // 参照素材の裏の照合は呼ぶ前に同じ確かめをする。管理素材の書き出し前の確認はここで止まる）。
    if(stuckDigestRead(path,identity))throw new UnresponsiveFileError('read',path,STUCK_IDLE_MS);
    const read:Read={work,lastProgress:Date.now()};let reads=reading.get(key);if(!reads)reading.set(key,reads=new Set());reads.add(read);
    try{
      const handle=await watchedFs('open',path,()=>open(path,constants.O_RDONLY|constants.O_NOFOLLOW));
      try{
        if(fileIdentity(await handle.stat())!==identity)throw new FileChangedError();
        const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;
        while(true){work.throwIfAborted();const {bytesRead}=await watchedFs('read',path,()=>handle.read(buffer,0,buffer.length,position));if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;
          read.lastProgress=Date.now();for(const listener of listeners.get(key)??[])listener(bytesRead);
          const delay=testDelayMs();if(delay>0)await sleep(delay,undefined,{signal:work});}
        if(fileIdentity(await handle.stat())!==identity)throw new FileChangedError();
        return hash.digest('hex');
      }finally{await handle.close();}
    }finally{reads.delete(read);if(!reads.size&&reading.get(key)===reads)reading.delete(key);}
  },signal);
  if(onProgress){
    let set=listeners.get(key);if(!set)listeners.set(key,set=new Set());const mine=set;mine.add(onProgress);
    const remove=()=>{mine.delete(onProgress);if(!mine.size&&listeners.get(key)===mine)listeners.delete(key);};
    result.then(remove,remove);
  }
  return result;
}
/**
 * sharedFileDigest を待つが、読みが stallMs 進まなければ待つのをやめる（UnresponsiveFileError）。
 * やめるのはこの待ち手だけ: ほかに待ち手が残れば読みは続き、誰もいなければ読みは中止の合図を受ける（止まった読みは OS から戻るまで残り、
 * 同じ組の次の読みは stuckDigestRead で開き直さずに失敗する）。
 */
export function sharedFileDigestUntilStalled(path:string,identity:string,signal:AbortSignal|undefined,stallMs:number):Promise<string>{
  const controller=new AbortController(),forward=()=>controller.abort(signal!.reason);
  if(signal?.aborted)forward();else signal?.addEventListener('abort',forward,{once:true});
  const timer=setTimeout(()=>controller.abort(new UnresponsiveFileError('read',path,stallMs)),stallMs);
  return Promise.resolve().then(()=>sharedFileDigest(path,identity,controller.signal,()=>timer.refresh())).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',forward);});
}
