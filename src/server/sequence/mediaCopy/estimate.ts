import {constants} from 'node:fs';
import type {CopyTimeRange} from '../../../shared/mediaCopy';
import {READ_ONLY,isSimulatedCrash,type CopyFile,type CopyIo} from './io';
import {volumeOfPath} from './volumes';
import {GiB} from './space';

/** 判定は「媒体が遅い」ではなく「この素材の照合・読み込みに時間がかかる見込み」（設計 §1）: 外付けのボリューム上で、見積もり（大きさ ÷ 実測の読み取り速度）が 60 秒以上。 */
export const SLOW_SECONDS=60;
/** 追加時は登録の前に先頭から最大 64MB を読む（この分は追加の読み取り。案内の判断のための費用）。64MB 未満のファイルは測らない。 */
export const PROBE_BYTES=64*1024*1024,PROBE_CHUNK=4*1024*1024;
/** 書き先の照合の読みの速さの仮定（下限の計算だけに使う）。 */
export const ASSUMED_FAST_READ_BPS=GiB;
export interface ReadSpeed {bytes:number;ms:number}
export const bytesPerSecond=(speed:ReadSpeed)=>speed.ms>0?speed.bytes*1000/speed.ms:Number.POSITIVE_INFINITY;
/** 読み取り専用・リンクをたどらない（READ_ONLY）に、O_NONBLOCK を足す（差し替えられた FIFO で開くのを待ち続けない。通常のファイルの読みには効かない）。 */
const PROBE_FLAGS=READ_ONLY|constants.O_NONBLOCK;
/** 1回の読みがこの長さ戻らなければ諦めて失敗を返す（カードリーダーの不調・USB の再接続待ちで、追加の判定を止めない）。 */
export const PROBE_STALL_MS=30_000;
/** 試験専用（製品の経路からは書き換えない）。stallMs は見張りの長さ、probeBytes は読む上限（4MB の倍数でない値で端の切り方を試す）。 */
export const estimateTesting={stallMs:PROBE_STALL_MS,probeBytes:PROBE_BYTES};
const probeStalled=()=>Object.assign(new Error('元の媒体の読み取りが進みません'),{code:'ETIMEDOUT'});
/**
 * 諦めた（取り消し・見張り）のに OS の読み待ちから戻っていない試し読みの数（パスごと）。止まった読みは取り消せず作業用スレッドを1本塞ぐので、
 * 残っている間は同じファイルの試し読みを始めない（積み重ねて作業用スレッドを使い切らない。照合側の stuckDigestRead と同じ考え）。
 */
const stuckProbes=new Map<string,number>();
/** 諦めた読みが戻ったらファイルを閉じ、数を戻す（読み中の fd は閉じない: 閉じた番号が別のファイルに使い回されうる）。 */
function leaveStuck(path:string,pending:Promise<unknown>,file:CopyFile){
  stuckProbes.set(path,(stuckProbes.get(path)??0)+1);
  void pending.catch(()=>undefined).then(()=>file.close()).catch(()=>undefined).finally(()=>{const n=(stuckProbes.get(path)??1)-1;if(n>0)stuckProbes.set(path,n);else stuckProbes.delete(path);});
}
/** 読みを取り消しの合図・見張りの時計と競わせる。読みが戻る前に諦めた時だけ gaveUp を呼ぶ（読みが自分で失敗した時は呼ばない）。 */
function readWithin(pending:Promise<number>,signal:AbortSignal|undefined,gaveUp:()=>void):Promise<number>{
  return new Promise((resolve,reject)=>{
    let settled=false;const finish=(action:()=>void)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);action();};
    const abort=()=>finish(()=>{gaveUp();reject(signal!.reason);});
    const timer=setTimeout(()=>finish(()=>{gaveUp();reject(probeStalled());}),estimateTesting.stallMs);
    signal?.addEventListener('abort',abort,{once:true});
    pending.then(n=>finish(()=>resolve(n)),error=>finish(()=>reject(error)));
  });
}
/**
 * 実際に読んだバイト数 ÷ 単調時計の経過。測り始めは最初の read の直前（待ち行列の時間は含めない）。PROBE_BYTES を超えては読まない。
 * 64MB 未満のファイル・途中で縮んで 64MB を読めなかったファイルは測らない（undefined）。
 * 1回の読みは取り消し・見張り（PROBE_STALL_MS）と競わせ、戻らなければすぐ失敗を返す（読みが戻るまでファイルは閉じない）。
 */
export async function measureLeadingRead(io:CopyIo,path:string,signal?:AbortSignal):Promise<ReadSpeed|undefined>{
  signal?.throwIfAborted();if(stuckProbes.has(path))throw probeStalled();
  const limit=estimateTesting.probeBytes,file=await io.open(path,PROBE_FLAGS);let abandoned:Promise<number>|undefined;
  try{
    const info=await file.stat();if(!info.isFile())throw new Error('通常のファイルではありません');if(info.size<limit)return undefined;
    const buffer=Buffer.allocUnsafe(PROBE_CHUNK);let bytes=0;const started=io.now();
    while(bytes<limit){
      signal?.throwIfAborted();const pending=file.read(buffer.subarray(0,Math.min(PROBE_CHUNK,limit-bytes)),bytes);
      const n=await readWithin(pending,signal,()=>{abandoned=pending;});if(!n)break;
      bytes+=n;await io.throttle('probe',path,n,signal);
    }
    return bytes<limit?undefined:{bytes,ms:io.now()-started};
  }finally{if(abandoned)leaveStuck(path,abandoned,file);else await file.close();}
}
export interface SlowJudgement {slow:boolean;external:boolean;sizeBytes:number;measured:boolean;seconds?:number;bytesPerSecond?:number;volumeUuid?:string}
/**
 * 同じ束の判定で共有する覚え。stalledDrives: 試し読みが時間切れ（ETIMEDOUT: 1回の読みの見張り・判定の上限）になった外付けの取り付け先。
 * 同じ束の残りの項目はそのドライブを読まずに「測れない」として返す（止まったカードで1本ごとに 30 秒待つのを繰り返さない）。取り消しでは覚えない。
 */
export interface JudgeSession {stalledDrives:Set<string>}
const timedOut=(reason:unknown)=>(reason as {code?:unknown}|null|undefined)?.code==='ETIMEDOUT';
/**
 * 追加時の判定（短い工程。登録の実行枠は握らない）。実パスで判定する（リンクの先がどこにあるか）。通常のファイルでなければ開かずに断る。
 * 外付け（/Volumes の下の取り付け先）でなければ、読まず diskutil も呼ばない（mount の一覧だけを見る。このMac の上の素材で他のボリュームの識別を読みに行かない）。
 * 外付けでも 64MB 未満は開かない。ドライブの識別（diskutil。1台 0.1 秒ほど）は「遅い」と出た時だけ読む（「この接続先では今後出さない」の記録に使う）。
 * 識別を読めなくても判定は変えない（volumeUuid が無い＝記録できない）。session（同じ束の覚え）で時間切れになったドライブは読まない。
 */
export async function judgeAddedSource(io:CopyIo,path:string,signal?:AbortSignal,session?:JudgeSession):Promise<SlowJudgement>{
  const real=await io.realpath(path),info=await io.stat(real);if(!info.isFile())throw new Error('通常のファイルではありません');const sizeBytes=info.size;
  // 入れ子の取り付け先は一番深いものをそのドライブとする
  const drive=(await io.mounts()).filter(mount=>mount.kind==='external'&&(real===mount.mountPoint||real.startsWith(`${mount.mountPoint}/`)))
    .sort((a,b)=>b.mountPoint.length-a.mountPoint.length)[0]?.mountPoint;
  if(drive===undefined)return {slow:false,external:false,sizeBytes,measured:false};
  const unmeasured={slow:false,external:true,sizeBytes,measured:false};if(sizeBytes<estimateTesting.probeBytes||session?.stalledDrives.has(drive))return unmeasured;
  // 時間切れはこのドライブを覚える。判定の上限の合図は合図の時に覚える（諦めた側がファイルを閉じ終えるのを待たずに、束が次の項目へ進むため）
  const stalled=()=>{session?.stalledDrives.add(drive);},onAbort=()=>{if(timedOut(signal?.reason))stalled();};signal?.addEventListener('abort',onAbort,{once:true});
  let speed:ReadSpeed|undefined;
  try{speed=await measureLeadingRead(io,real,signal);}catch(error){if(timedOut(error))stalled();throw error;}finally{signal?.removeEventListener('abort',onAbort);}
  if(!speed)return unmeasured;
  // 経過が 0（速すぎて測れない）なら速さは無限大＝見積もり 0 秒。速さは有限の時だけ返す（JSON にできない値を持ち出さない）。
  const rate=bytesPerSecond(speed),seconds=sizeBytes/rate,slow=seconds>=SLOW_SECONDS;
  const volume=slow?await volumeOfPath(io,real).catch(error=>{if(isSimulatedCrash(error))throw error;return undefined;}):undefined;
  return {slow,external:true,sizeBytes,measured:true,seconds,...(Number.isFinite(rate)?{bytesPerSecond:rate}:{}),...(volume?{volumeUuid:volume.uuid}:{})};
}
/**
 * コピーの所要時間の幅（設計 §3）: 元の媒体の読み取り ＋ 書き込み ＋ 書き先の照合。書き込みと照合の速さは測っていないので「速い」とは断定しない。
 * 下限: 書き込みは読み取りと重なって終わり、照合は 1GB/s。上限: 書き込みも照合も元の読み取りと同じ遅さ（読み取りの3倍）。元の速さが分からなければ出さない。
 */
export function copyTimeRange(bytes:number,sourceBytesPerSecond?:number):CopyTimeRange|null{
  if(!sourceBytesPerSecond||!Number.isFinite(sourceBytesPerSecond)||sourceBytesPerSecond<=0)return null;
  const read=bytes/sourceBytesPerSecond;return {minSeconds:Math.ceil(read+bytes/ASSUMED_FAST_READ_BPS),maxSeconds:Math.ceil(read*3)};
}
