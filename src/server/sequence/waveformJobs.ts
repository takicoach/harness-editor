import {createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import type {SequenceAsset} from '../../core/sequence/model';
import {rational,type Rational} from '../../core/sequence/time';
import {verifiedSequenceAssetPath} from './assets';
import {FfmpegBusyError} from './ffmpegGate';
import {prepareSequenceAudio,type PreparedAudioFile} from './media';
import {prepareWaveformIndex,readSequenceWaveform,validateWaveformRequest,type WaveformRequest,type WaveformResponse} from './waveform';

/** 設計 §2-2: 波形の要求は音声の準備を待たずに答える。準備（素材ごとの取り出しと索引）はサーバの仕事として続き、ブラウザは識別子ごとに状態を問う。 */
export type WaveformApiResponse=({state:'ready'}&WaveformResponse)|{state:'preparing';preparationId:string}|{state:'failed';preparationId:string;error:string};
export type WaveformPreparationStatus={state:'preparing'|'ready'|'missing'}|{state:'failed';error:string};
interface Job {directory:string;promise:Promise<PreparedAudioFile>;pcm?:PreparedAudioFile;error?:string;busy?:FfmpegBusyError;finishedAt?:number}
const jobs=new Map<string,Job>(),MAX_SECONDS=86400,MAX_JOBS=64;
/** 準備済みの素材（ディスクの音声キャッシュ）ならこの間に終わることが多い。待つのはこれだけで、接続を握り続けない。 */
export const WAVEFORM_READY_GRACE_MS=150,WAVEFORM_FAILED_RETRY_MS=10_000;
export function waveformPreparationId(directory:string,asset:SequenceAsset,streamIndex:number,rate:Rational):string{
  return createHash('sha256').update(JSON.stringify([realpathSync(directory),asset.id,asset.fingerprint,streamIndex,rational(rate.num,rate.den)])).digest('hex').slice(0,32);
}
function startJob(id:string,directory:string,asset:SequenceAsset,streamIndex:number,rate:Rational):Job{
  // 要求の取り消しと切り離す: ブラウザは「準備中」を受け取ったら接続を返す。
  const job:Job={directory:realpathSync(directory),promise:(async()=>{
    await verifiedSequenceAssetPath(directory,asset);
    const pcm=await prepareSequenceAudio(directory,asset,streamIndex,rate,undefined,'waveform');
    await prepareWaveformIndex(pcm);return pcm;
  })()};
  job.promise.then(pcm=>{job.pcm=pcm;job.finishedAt=Date.now();},error=>{
    // 待ち行列の満杯は一時的: 失敗として覚えない（問い合わせには 'missing'、次の要求で準備し直す）。
    if(error instanceof FfmpegBusyError){job.busy=error;if(jobs.get(id)===job)jobs.delete(id);return;}
    job.error=error instanceof Error?error.message:String(error);job.finishedAt=Date.now();});
  jobs.delete(id);jobs.set(id,job);
  for(const [key,old] of jobs){if(jobs.size<=MAX_JOBS)break;if(old.finishedAt!==undefined)jobs.delete(key);}
  return job;
}
export async function respondWaveform(directory:string,asset:SequenceAsset,input:WaveformRequest,signal?:AbortSignal):Promise<WaveformApiResponse>{
  const request=validateWaveformRequest(input),stream=asset.streams.find(stream=>stream.index===request.streamIndex&&stream.kind==='audio');
  if(asset.id!==request.assetId||!stream)throw new Error('波形の音声ストリームがありません');
  if(BigInt(stream.duration.num)*BigInt(request.rate.den)>BigInt(MAX_SECONDS)*BigInt(stream.duration.den)*BigInt(request.rate.num))throw new Error('波形の音声は速度適用後24時間以内にしてください');
  const preparationId=waveformPreparationId(directory,asset,request.streamIndex,request.rate);
  for(let attempt=0;;attempt++){
    const existing=jobs.get(preparationId);
    const job=existing&&!(existing.error&&Date.now()-existing.finishedAt!>=WAVEFORM_FAILED_RETRY_MS)?existing:startJob(preparationId,directory,asset,request.streamIndex,request.rate);
    if(!job.pcm&&!job.error&&!job.busy)await Promise.race([job.promise.catch(()=>undefined),sleep(WAVEFORM_READY_GRACE_MS,undefined,{signal})]);
    if(job.busy)throw job.busy;
    if(job.error)return {state:'failed',preparationId,error:job.error};
    if(!job.pcm)return {state:'preparing',preparationId};
    try{
      // 準備済みでも素材が変わっていないことは毎回確かめる（記憶が当たれば stat だけ）。
      await verifiedSequenceAssetPath(directory,asset,signal);
      return {state:'ready',...await readSequenceWaveform(job.pcm,request,signal)};
    }catch(error){
      // 準備済みの PCM がキャッシュから消えた: 以前と同じく黙って準備し直す（1回だけ）。ほかの失敗は共有の準備を消さない。
      if(attempt||signal?.aborted||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      if(jobs.get(preparationId)===job)jobs.delete(preparationId);
    }
  }
}
export function waveformPreparationStatuses(directory:string,ids:readonly string[]):Record<string,WaveformPreparationStatus>{
  const owner=realpathSync(directory),result:Record<string,WaveformPreparationStatus>={};
  for(const id of ids){const job=jobs.get(id);result[id]=!job||job.directory!==owner?{state:'missing'}:job.error?{state:'failed',error:job.error}:job.pcm?{state:'ready'}:{state:'preparing'};}
  return result;
}
/** 試験用: プロセス内の準備の記録を消す（サーバの再起動に相当）。 */
export function forgetWaveformPreparations():void{jobs.clear();}
