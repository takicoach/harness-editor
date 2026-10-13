import {randomUUID} from 'node:crypto';
import {lstat,readFile,readdir,rename,rm,stat,unlink,utimes} from 'node:fs/promises';
import {join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {rational,type Rational} from '../../core/sequence/time';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {openSequenceAsset,verifiedSequenceAssetPath} from './assets';
import {cacheDirectory,run} from './media';
import {SharedPreparations} from './sharedPreparation';
import {FfmpegBusyError,withFfmpegSlot} from './ffmpegGate';
import {FRAME_CACHE_VERSION,frameAtTime,frameCacheFolder,frameExtractionArgs,framePresentationIndex,type FramePresentation} from './framePresentation';
import {FRAME_HEIGHTS,FRAME_REQUEST_MAX_TIMES} from '../../shared/filmstripHeight';

/** 設計 §2-1。確定値は事前の測定で決めた。 */
export const FRAME_MIN_HEIGHT=16,FRAME_MAX_HEIGHT=240;
export {FRAME_REQUEST_MAX_TIMES};
export const FRAME_CACHE_LIMIT_BYTES=300*1024*1024,FRAME_CACHE_TARGET_BYTES=270*1024*1024;
export interface FrameRequest {assetId:string;streamIndex:number;height:number;times:Array<{key:string;time:Rational}>}
/** failed の busy: 混雑（待ち行列があふれて落とした）。画面は 503 と同じく取り直し続ける。印の無い失敗は切り出せなかったコマ。 */
export interface FrameResponse {version:1;frames:Array<{time:string;frame:number;data:string}>;failed:Array<{time:string;error:string;busy?:true}>}
/** 試験用の数: 実際に FFmpeg で切り出した回数（キャッシュ命中・合流では増えない）。 */
export const frameExtractions={count:0};

export function frameRequestFromQuery(query:URLSearchParams):FrameRequest{
  const integer=(name:string,label:string)=>{const raw=query.get(name)??'';if(!/^\d{1,6}$/.test(raw))throw new Error(`コマ絵の${label}が不正です`);return Number(raw);};
  const assetId=query.get('asset')??'';if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(assetId))throw new Error('コマ絵の素材IDが不正です');
  const streamIndex=integer('stream','ストリーム番号');if(streamIndex>1023)throw new Error('コマ絵のストリーム番号が範囲外です');
  const height=integer('height','高さ');if(!FRAME_HEIGHTS.includes(height))throw new Error(`コマ絵の高さは ${FRAME_HEIGHTS.join('・')} のいずれかで指定してください`);
  const tokens=(query.get('times')??'').split(',').filter(Boolean);
  if(!tokens.length||tokens.length>FRAME_REQUEST_MAX_TIMES)throw new Error(`コマ絵の時刻は1〜${FRAME_REQUEST_MAX_TIMES}個で指定してください`);
  const times=tokens.map(key=>{const match=/^(\d+)\/(\d+)$/.exec(key);if(!match)throw new Error('コマ絵の時刻は 分子/分母 で指定してください');
    const num=Number(match[1]),den=Number(match[2]);if(!Number.isSafeInteger(num)||!Number.isSafeInteger(den)||den<=0)throw new Error('コマ絵の時刻が不正です');return {key,time:rational(num,den)};});
  return {assetId,streamIndex,height,times};
}
const PROCESS_STARTED=Date.now();
/** 案件ごとの上限（300MB）。最後に使った順で古いものから消す。起動後の最初の利用で、他の版と前のプロセスの作りかけを消す。
 * コマの応答は走査（ready）も削除も待たない: 一覧の更新と削除は走査の後ろに1本で並べる。 */
export class FrameCacheBudget {
  private readonly files=new Map<string,number>();private total=0;private queue:Promise<void>;
  /** 起動後の走査（他の版・前のプロセスの作りかけの回収）。 */
  readonly ready:Promise<void>;
  constructor(private readonly root:string,private readonly limitBytes=FRAME_CACHE_LIMIT_BYTES,private readonly targetBytes=FRAME_CACHE_TARGET_BYTES){this.ready=this.queue=this.scan();}
  get bytes(){return this.total;}
  private later(work:()=>void|Promise<void>):Promise<void>{return this.queue=this.queue.then(work).catch(()=>undefined);}
  // 掃除に失敗しても（権限など）コマ絵は出す。ready が失敗すると、このプロセスの間ずっと全てのコマが失敗になるため。
  private async scan():Promise<void>{
    for(const name of await readdir(this.root).catch(()=>[] as string[]))if(name!==FRAME_CACHE_VERSION)await rm(join(this.root,name),{recursive:true,force:true}).catch(()=>undefined);
    const found:Array<{file:string;size:number;at:number}>=[];
    const walk=async(folder:string):Promise<void>=>{
      for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[])){
        const path=join(folder,entry.name);
        if(entry.isDirectory()){await walk(path);continue;}
        if(!entry.isFile())continue;
        const info=await stat(path).catch(()=>null);if(!info)continue;
        if(entry.name.endsWith('.tmp')){if(info.mtimeMs<PROCESS_STARTED)await unlink(path).catch(()=>undefined);continue;}
        if(entry.name.endsWith('.jpg'))found.push({file:path,size:info.size,at:info.mtimeMs});
      }
    };
    await walk(join(this.root,FRAME_CACHE_VERSION));
    for(const item of found.sort((a,b)=>a.at-b.at)){this.files.set(item.file,item.size);this.total+=item.size;}
    await this.evict();
  }
  /** 使った時刻はすぐディスクに残し（再起動後の順番）、一覧の並べ替えは走査の後に回す。 */
  async touch(file:string):Promise<void>{
    void this.later(()=>{const size=this.files.get(file);if(size!==undefined){this.files.delete(file);this.files.set(file,size);}});
    const now=new Date();await utimes(file,now,now).catch(()=>undefined);
  }
  /** 返す promise は削除まで終わった時（試験用）。応答の経路は待たない。 */
  add(file:string,size:number):Promise<void>{
    return this.later(async()=>{const previous=this.files.get(file);if(previous!==undefined){this.total-=previous;this.files.delete(file);}
      this.files.set(file,size);this.total+=size;await this.evict();});
  }
  private async evict():Promise<void>{
    if(this.total<=this.limitBytes)return;
    for(const [file,size] of this.files){if(this.total<=this.targetBytes)break;this.files.delete(file);this.total-=size;await unlink(file).catch(()=>undefined);}
  }
}
const budgets=new Map<string,FrameCacheBudget>(),extractions=new SharedPreparations<Buffer>();
async function cacheBudget(directory:string):Promise<FrameCacheBudget>{
  const root=await cacheDirectory(directory,'frames');let budget=budgets.get(root);if(!budget){budget=new FrameCacheBudget(root);budgets.set(root,budget);}return budget;
}
async function readCached(file:string):Promise<Buffer|null>{
  try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<4||info.size>2*1024*1024)return null;const data=await readFile(file);return data[0]===0xff&&data[1]===0xd8?data:null;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
async function frameImage(directory:string,asset:SequenceAsset,index:FramePresentation,streamIndex:number,height:number,frame:number,folder:string,budget:FrameCacheBudget,signal?:AbortSignal):Promise<Buffer>{
  const file=join(folder,`${frame}.jpg`),cached=await readCached(file);if(cached){await budget.touch(file);return cached;}
  // 同じフレームの切り出しが重なったら1本（鍵: 指紋・ストリーム・高さ・フレーム番号・版＝このファイルの場所）。
  return extractions.get(file,async(work,lane)=>{
    const again=await readCached(file);if(again)return again;
    const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
    const lease=await openSequenceAsset(directory,asset,work),temporary=`${file}.${randomUUID()}.tmp`;
    try{
      await withFfmpegSlot(lane,work,async()=>{frameExtractions.count++;await run(ffmpeg.bin,frameExtractionArgs(index,frame,streamIndex,height,temporary),work,lease.handle.fd);});
      await lease.verify();
      const data=await readFile(temporary);if(data.length<4||data[0]!==0xff||data[1]!==0xd8)throw new Error('コマ絵を作れませんでした');
      await rename(temporary,file);void budget.add(file,data.length);return data;
    }finally{await lease.close();await unlink(temporary).catch(()=>undefined);}
  },signal,'filmstrip');
}
/** 応答は保存済みのフレームから組み立てる。表示の組み合わせが変わっても同じフレームは使い回す。
 * 混雑（FfmpegBusyError）で1コマも出せなかった時だけ混雑として投げる（経路は 503）。一部でも出せたら残りは failed に入れて返す。 */
export async function prepareSequenceFrames(directory:string,asset:SequenceAsset,request:FrameRequest,signal?:AbortSignal):Promise<FrameResponse>{
  if(asset.id!==request.assetId)throw new Error('コマ絵の素材が一致しません');
  if(!Number.isSafeInteger(request.streamIndex)||request.streamIndex<0||!Number.isSafeInteger(request.height)||request.height<FRAME_MIN_HEIGHT||request.height>FRAME_MAX_HEIGHT)throw new Error('コマ絵の指定が不正です');
  // 保存済みの索引・コマ絵だけで答えられる時も、原素材が消えた・変わったら音声・波形と同じ失敗にする（古い絵を正常なコマとして出さない）。
  // 要求ごとに1回。確認済みの記憶が当たれば stat だけで、切り出し側の openSequenceAsset もその記憶で全体読みをしない。
  await verifiedSequenceAssetPath(directory,asset,signal);
  const index=await framePresentationIndex(directory,asset,request.streamIndex,signal);
  const [folder,budget]=await Promise.all([frameCacheFolder(directory,asset,request.streamIndex,request.height),cacheBudget(directory)]);
  const wanted=request.times.map(item=>({key:item.key,frame:frameAtTime(index,item.time)})),images=new Map<number,Buffer|Error>();
  await Promise.all([...new Set(wanted.map(item=>item.frame))].map(async frame=>{
    try{images.set(frame,await frameImage(directory,asset,index,request.streamIndex,request.height,frame,folder,budget,signal));}
    catch(error){if(signal?.aborted)throw error;images.set(frame,error instanceof Error?error:new Error(String(error)));}
  }));
  const response:FrameResponse={version:1,frames:[],failed:[]};
  for(const item of wanted){const image=images.get(item.frame)!;
    if(image instanceof Error)response.failed.push({time:item.key,error:image.message,...(image instanceof FfmpegBusyError?{busy:true as const}:{})});
    else response.frames.push({time:item.key,frame:item.frame,data:`data:image/jpeg;base64,${image.toString('base64')}`});}
  if(!response.frames.length&&[...images.values()].some(image=>image instanceof FfmpegBusyError))throw new FfmpegBusyError();
  return response;
}
