import {constants} from 'node:fs';
import {open,rename,unlink,readdir,lstat,utimes} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {prepareSequenceAudio,cacheDirectory,type PreparedAudioFile} from './media';
import {verifiedSequenceAssetPath} from './assets';
import {SharedPreparations} from './sharedPreparation';
import {rational} from '../../core/sequence/time';
import type {SequenceAsset} from '../../core/sequence/model';
import type {SilenceEnvelope} from '../../core/sequence/silenceCutPlan';

export const SILENCE_DSP_VERSION='rms-20ms-10ms-channel-max-v1';
const HOP=480,MAX_SAMPLES=48000*43200,CHUNK=128*1024,BUDGET=256*1024*1024;
const pins=new Map<string,number>();
const preparations=new SharedPreparations<SilenceEnvelope>();
const progress=new Map<string,Set<(percent:number)=>void>>();
let writes:Promise<void>=Promise.resolve();
async function serializeWrite<T>(work:()=>Promise<T>):Promise<T>{const previous=writes;let unlock!:()=>void;writes=new Promise(resolve=>{unlock=resolve;});await previous;try{return await work();}finally{unlock();}}
const hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');

/** 10ms blocks retain their squared channel sums. Two consecutive blocks form the centered window. */
export async function readSilenceEnvelope(pcm:PreparedAudioFile,signal:AbortSignal,onProgress:(percent:number)=>void=()=>{}):Promise<SilenceEnvelope>{
  if(pcm.sampleRate!==48000||pcm.channels!==2||!Number.isSafeInteger(pcm.sampleCount)||pcm.sampleCount<1||pcm.sampleCount>MAX_SAMPLES)throw new Error('無音解析の音声形式・長さが対応範囲外です');
  const rms=new Float32Array(Math.ceil(pcm.sampleCount/HOP)),file=await open(pcm.file,constants.O_RDONLY|constants.O_NOFOLLOW);
  let left=0,right=0,count=0,prevL=0,prevR=0,prevN=0,index=0,offset=0;
  const emit=()=>{rms[index++]=Math.sqrt(Math.max(left+prevL,right+prevR)/(count+prevN));prevL=left;prevR=right;prevN=count;left=0;right=0;count=0;};
  try{
    const info=await file.stat();if(!info.isFile()||info.size!==pcm.sampleCount*8)throw new Error('解析する音声が欠損しています');
    const buf=Buffer.alloc(CHUNK);
    while(offset<info.size){
      signal.throwIfAborted();const length=Math.min(CHUNK,info.size-offset);let read=0;
      while(read<length){const part=await file.read(buf,read,length-read,offset+read);if(!part.bytesRead)throw new Error('音声の読取が途中で終了しました');read+=part.bytesRead;}
      for(let i=0;i<length;i+=8){const l=buf.readFloatLE(i),r=buf.readFloatLE(i+4);if(!Number.isFinite(l)||!Number.isFinite(r))throw new Error('音声に不正なサンプルがあります');left+=l*l;right+=r*r;if(++count===HOP)emit();}
      offset+=length;onProgress(offset/info.size*100);await yieldLoop();
    }
    if(count)emit();signal.throwIfAborted();return {sampleRate:48000,hopSamples:HOP,windowSamples:HOP*2,sampleCount:pcm.sampleCount,rms};
  }finally{await file.close();}
}

async function evict(directory:string,needed:number):Promise<void>{
  const entries=[];let total=0;
  for(const name of await readdir(directory)){if(!/^[a-f0-9]{64}\.rms$/.test(name))continue;const path=join(directory,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())continue;total+=stat.size;entries.push({path,size:stat.size,time:stat.mtimeMs});}
  for(const e of entries.sort((a,b)=>a.time-b.time)){if(total+needed<=BUDGET)break;if(pins.has(e.path))continue;await unlink(e.path);total-=e.size;}
  if(total+needed>BUDGET)throw new Error('音量キャッシュが使用中です。別の解析の完了を待ってください');
}

/** Pin lifetime covers the complete job, including threshold recalculation using its memory view. */
export async function acquireSilenceEnvelope(root:string,asset:SequenceAsset,streamIndex:number,signal:AbortSignal,onProgress:(p:number)=>void):Promise<{envelope:SilenceEnvelope;release:()=>void}>{
  const stream=asset.streams.find(s=>s.index===streamIndex&&s.kind==='audio');
  if(!stream||!stream.channels||stream.channels>2)throw new Error('モノラル/ステレオの原音を指定してください');
  await verifiedSequenceAssetPath(root,asset,signal);
  const dir=await cacheDirectory(root,'silence-rms-v1'),key=hash(JSON.stringify([asset.fingerprint,streamIndex,SILENCE_DSP_VERSION])),path=join(dir,`${key}.rms`);
  pins.set(path,(pins.get(path)??0)+1);let released=false;
  const release=()=>{if(released)return;released=true;const n=(pins.get(path)??1)-1;if(n)pins.set(path,n);else pins.delete(path);};
  const listeners=progress.get(path)??new Set<(percent:number)=>void>();progress.set(path,listeners);listeners.add(onProgress);
  try{
    const envelope=await preparations.get(path,async signal=>{
    let envelope:SilenceEnvelope|undefined;
    try{
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
      try{const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.size<4||stat.size>MAX_SAMPLES/HOP*4+1024)throw new Error('invalid cache');
        bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){signal.throwIfAborted();const read=await file.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw new Error('invalid cache');offset+=read.bytesRead;}
      }finally{await file.close();}
      const n=bytes.readUInt32LE(0);if(n>1000)throw new Error('invalid header');
      const meta=JSON.parse(bytes.subarray(4,4+n).toString()),data=bytes.subarray(4+n);
      if(meta.key!==key||meta.sha!==hash(data)||!Number.isSafeInteger(meta.samples)||meta.samples<1||meta.samples>MAX_SAMPLES||data.length!==Math.ceil(meta.samples/HOP)*4)throw new Error('invalid cache');
      const rms=new Float32Array(data.length/4);for(let i=0;i<rms.length;i++){rms[i]=data.readFloatLE(i*4);if(!Number.isFinite(rms[i])||rms[i]!<0)throw new Error('invalid levels');}
      envelope={sampleRate:48000,hopSamples:HOP,windowSamples:HOP*2,sampleCount:meta.samples,rms};await utimes(path,new Date(),new Date());
    }catch{/* Cache is disposable; only verified source audio may rebuild it. */}
    if(!envelope){
      const pcm=await prepareSequenceAudio(root,asset,streamIndex,rational(1),signal);
      envelope=await readSilenceEnvelope(pcm,signal,p=>progress.get(path)?.forEach(f=>f(p)));
      const data=Buffer.from(envelope.rms.buffer,envelope.rms.byteOffset,envelope.rms.byteLength);
      const meta=Buffer.from(JSON.stringify({key,samples:envelope.sampleCount,sha:hash(data)})),header=Buffer.alloc(4);header.writeUInt32LE(meta.length);
      await serializeWrite(async()=>{
      await evict(dir,data.length+meta.length+4);signal.throwIfAborted();
      const temp=join(dir,`${key}.${randomUUID()}.tmp`);
      try{const file=await open(temp,'wx',0o600);try{await file.writeFile(header);await file.writeFile(meta);await file.writeFile(data);}finally{await file.close();}signal.throwIfAborted();await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}
      });
    }
    return envelope;
    },signal);
    signal.throwIfAborted();await verifiedSequenceAssetPath(root,asset,signal);onProgress(100);return {envelope,release};
  }catch(error){release();throw error;}finally{listeners.delete(onProgress);if(!listeners.size)progress.delete(path);}
}
