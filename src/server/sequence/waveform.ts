import {constants} from 'node:fs';
import {open,lstat,rename,unlink,type FileHandle} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {rational,type Rational} from '../../core/sequence/time';
import {prepareSequenceAudio,type PreparedAudioFile} from './media';
import type {SequenceAsset} from '../../core/sequence/model';
import {verifiedSequenceAssetPath} from './assets';
import {SharedPreparations} from './sharedPreparation';

export interface WaveformRequest {
  assetId:string;streamIndex:number;rate:Rational;sourceIn:Rational;fps:Rational;
  startFrame:number;frameCount:number;clipFrames:number;bins:number;loop:boolean;
}
export interface WaveformBin {peak:number;rms:number;samples:number}
export interface WaveformResponse {
  version:1;precision:'prepared-pcm-sample-floor';sampleRate:number;sourceSampleCount:number;
  request:WaveformRequest;bins:WaveformBin[];
}
export const MAX_WAVEFORM_BINS=2400;
const MAX_SECONDS=86400,BLOCK=1024,HEADER=512,RECORD=16,READ_BYTES=512*1024;
const preparations=new SharedPreparations<string>();
let activeRequests=0;
const waiting:Array<{start():void;abort():void}>=[];
function acquire(signal?:AbortSignal):Promise<()=>void>{
  signal?.throwIfAborted();
  if(activeRequests>=4&&waiting.length>=16)return Promise.reject(new Error('波形の同時取得上限に達しました'));
  return new Promise((resolve,reject)=>{
    const release=()=>{activeRequests--;waiting.shift()?.start();};
    const entry={start(){signal?.removeEventListener('abort',entry.abort);activeRequests++;resolve(release);},abort(){const index=waiting.indexOf(entry);if(index>=0)waiting.splice(index,1);reject(signal?.reason??new Error('波形取得を中止しました'));}};
    if(activeRequests<4)entry.start();else{waiting.push(entry);signal?.addEventListener('abort',entry.abort,{once:true});}
  });
}
const integer=(value:number)=>Number.isSafeInteger(value);
function positive(value:Rational){return integer(value.num)&&integer(value.den)&&value.num>0&&value.den>0;}
export function validateWaveformRequest(value:WaveformRequest):WaveformRequest {
  if(!value.assetId||!integer(value.streamIndex)||value.streamIndex<0||!positive(value.rate)||!positive(value.fps)
    ||BigInt(value.fps.num)>240n*BigInt(value.fps.den)||!integer(value.sourceIn.num)||!integer(value.sourceIn.den)||value.sourceIn.den<=0
    ||!integer(value.startFrame)||!integer(value.frameCount)||value.frameCount<=0||!integer(value.clipFrames)||value.clipFrames<=0
    ||!integer(value.bins)||value.bins<1||value.bins>MAX_WAVEFORM_BINS||typeof value.loop!=='boolean')throw new Error('波形の範囲・速度・分割数が不正です');
  for(const frames of [Math.abs(value.startFrame),value.frameCount,value.clipFrames]){
    if(BigInt(frames)*BigInt(value.fps.den)>BigInt(MAX_SECONDS)*BigInt(value.fps.num))throw new Error('波形の範囲は24時間以内にしてください');
  }
  if(value.rate.num/value.rate.den<.01||value.rate.num/value.rate.den>100)throw new Error('音声の再生速度は0.01〜100倍に対応しています');
  return {...value,rate:rational(value.rate.num,value.rate.den),sourceIn:rational(value.sourceIn.num,value.sourceIn.den),fps:rational(value.fps.num,value.fps.den)};
}
export function waveformRequestFromQuery(query:URLSearchParams):WaveformRequest {
  const number=(name:string,fallback?:number)=>{
    const raw=query.get(name);if(raw===null&&fallback!==undefined)return fallback;
    if(raw===null||! /^-?\d+$/.test(raw))throw new Error(`波形の${name}は整数で指定してください`);
    return Number(raw);
  };
  const loop=query.get('loop')??'0';if(loop!=='0'&&loop!=='1')throw new Error('波形のloopは0か1で指定してください');
  return validateWaveformRequest({assetId:query.get('asset')??'',streamIndex:number('stream'),
    rate:{num:number('rateNum',1),den:number('rateDen',1)},sourceIn:{num:number('sourceInNum',0),den:number('sourceInDen',1)},
    fps:{num:number('fpsNum'),den:number('fpsDen',1)},startFrame:number('startFrame'),frameCount:number('frameCount'),clipFrames:number('clipFrames'),bins:number('bins'),loop:loop==='1'});
}
async function readExactly(file:FileHandle,buffer:Buffer,position:number,signal?:AbortSignal){
  let offset=0;while(offset<buffer.length){signal?.throwIfAborted();const read=await file.read(buffer,offset,buffer.length-offset,position+offset);if(!read.bytesRead)throw new Error('波形の音声データが途中で終了しました');offset+=read.bytesRead;}
}
interface Summary {peak:number;energy:number}
const empty=():Summary=>({peak:0,energy:0});
const merge=(a:Summary,b:Summary,times=1)=>{a.peak=Math.max(a.peak,b.peak);a.energy+=b.energy*times;};
function accumulate(summary:Summary,left:number,right:number){
  if(!Number.isFinite(left)||!Number.isFinite(right))throw new Error('音声PCMに有限でない値があります');
  summary.peak=Math.max(summary.peak,Math.abs(left),Math.abs(right));summary.energy+=(left*left+right*right)/2;
}
async function identity(pcm:PreparedAudioFile){
  const info=await lstat(pcm.file);
  if(info.isSymbolicLink()||!info.isFile()||pcm.channels!==2||pcm.sampleRate!==48000||!integer(pcm.sampleCount)||pcm.sampleCount<=0||pcm.sampleCount>MAX_SECONDS*48000||info.size!==pcm.sampleCount*8)throw new Error('波形用PCMは48kHzステレオ・24時間以内の通常ファイルが必要です');
  return JSON.stringify({format:'waveform-v1',block:BLOCK,size:info.size,mtime:info.mtimeMs,ctime:info.ctimeMs,samples:pcm.sampleCount,rate:pcm.rate});
}
// PCM names already include the managed fingerprint, stream, rational rate and
// source stat identity. This sidecar also validates PCM stat/format on every use.
async function indexFile(pcm:PreparedAudioFile,signal?:AbortSignal):Promise<string>{
  const signature=await identity(pcm),destination=pcm.file+'.waveform-v1';
  return preparations.get(destination,async signal=>{
    signal.throwIfAborted();let cached:FileHandle|undefined;
    try{
      cached=await open(destination,constants.O_RDONLY|constants.O_NOFOLLOW);
      if((await cached.stat()).size===HEADER+Math.ceil(pcm.sampleCount/BLOCK)*RECORD){
        const header=Buffer.alloc(HEADER);await readExactly(cached,header,0,signal);
        if(header.toString('utf8').trim()===signature)return destination;
      }
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    finally{await cached?.close();}
    const temporary=destination+'.'+randomUUID()+'.tmp';let source:FileHandle|undefined,target:FileHandle|undefined;
    try{
      source=await open(pcm.file,constants.O_RDONLY|constants.O_NOFOLLOW);target=await open(temporary,'wx',0o600);
      const header=Buffer.alloc(HEADER,32);if(Buffer.byteLength(signature)>HEADER)throw new Error('波形キャッシュ情報が大きすぎます');header.write(signature);await target.writeFile(header);
      const input=Buffer.alloc(READ_BYTES);
      for(let frame=0;frame<pcm.sampleCount;){
        signal.throwIfAborted();const count=Math.min(READ_BYTES/8,pcm.sampleCount-frame),data=input.subarray(0,count*8);
        await readExactly(source,data,frame*8,signal);const output=Buffer.alloc(Math.ceil(count/BLOCK)*RECORD);
        for(let i=0;i<count;i+=BLOCK){
          const summary=empty();for(let j=i;j<Math.min(count,i+BLOCK);j++)accumulate(summary,data.readFloatLE(j*8),data.readFloatLE(j*8+4));
          output.writeDoubleLE(summary.peak,i/BLOCK*RECORD);output.writeDoubleLE(summary.energy,i/BLOCK*RECORD+8);
        }
        await target.writeFile(output);frame+=count;
      }
      signal.throwIfAborted();if(await identity(pcm)!==signature)throw new Error('波形の準備中にPCMが変わりました');
      await target.close();target=undefined;await rename(temporary,destination);return destination;
    }finally{await source?.close();await target?.close();await unlink(temporary).catch(()=>undefined);}
  },signal);
}
/** Fixed-size page cache: queries never allocate the complete PCM or index. */
function pages(file:FileHandle,size:number,signal?:AbortSignal){
  let start=-1,data=Buffer.alloc(0);
  return async(position:number,bytes:number)=>{
    signal?.throwIfAborted();if(position<start||position+bytes>start+data.length){
      start=Math.floor(position/65536)*65536;data=Buffer.alloc(Math.min(65536,size-start));await readExactly(file,data,start,signal);
    }
    return data.subarray(position-start,position-start+bytes);
  };
}
const floor=(num:bigint,den:bigint)=>num>=0n?num/den:-((-num+den-1n)/den);
/** Source envelope, before gain/fades/mute and mixer fractional interpolation.
 * Bin boundaries use exact rational position then floor to a prepared PCM sample.
 * Silence outside the clip/source contributes to the RMS denominator. */
export async function readSequenceWaveform(pcm:PreparedAudioFile,input:WaveformRequest,signal?:AbortSignal):Promise<WaveformResponse>{
  const request=validateWaveformRequest(input);signal?.throwIfAborted();
  if(pcm.rate.num!==request.rate.num||pcm.rate.den!==request.rate.den)throw new Error('波形のPCM速度が一致しません');
  const release=await acquire(signal);
  try{return await readWaveform(pcm,request,signal);}finally{release();}
}
/** The same 4-active/16-waiting budget includes verification and FFmpeg work,
 * not just the inexpensive final JSON. SharedPreparations coalesces equal PCM
 * and index builds; one disconnected consumer cannot cancel another consumer. */
export async function prepareSequenceWaveform(directory:string,asset:SequenceAsset,input:WaveformRequest,signal?:AbortSignal):Promise<WaveformResponse>{
  const request=validateWaveformRequest(input),stream=asset.streams.find(stream=>stream.index===request.streamIndex&&stream.kind==='audio');
  if(asset.id!==request.assetId||!stream)throw new Error('波形の音声ストリームがありません');
  if(BigInt(stream.duration.num)*BigInt(request.rate.den)>BigInt(MAX_SECONDS)*BigInt(stream.duration.den)*BigInt(request.rate.num))throw new Error('波形の音声は速度適用後24時間以内にしてください');
  const release=await acquire(signal);
  try{
    await verifiedSequenceAssetPath(directory,asset,signal);
    const pcm=await prepareSequenceAudio(directory,asset,request.streamIndex,request.rate,signal);
    return await readWaveform(pcm,request,signal);
  }finally{release();}
}
async function readWaveform(pcm:PreparedAudioFile,request:WaveformRequest,signal?:AbortSignal):Promise<WaveformResponse>{
  const file=await indexFile(pcm,signal),source=await open(pcm.file,constants.O_RDONLY|constants.O_NOFOLLOW);
  let index:FileHandle|undefined;
  try{
    index=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    const raw=pages(source,pcm.sampleCount*8,signal),indexed=pages(index,HEADER+Math.ceil(pcm.sampleCount/BLOCK)*RECORD,signal);
    const range=async(from:number,to:number):Promise<Summary>=>{
      const result=empty();
      while(from<to){
        signal?.throwIfAborted();
        if(from%BLOCK===0&&to-from>=BLOCK){
          const data=await indexed(HEADER+from/BLOCK*RECORD,RECORD),peak=data.readDoubleLE(0),energy=data.readDoubleLE(8);
          if(!Number.isFinite(peak)||peak<0||!Number.isFinite(energy)||energy<0)throw new Error('波形キャッシュの値が不正です');
          merge(result,{peak,energy});from+=BLOCK;
        }else{
          const toRead=Math.min(to,Math.floor(from/BLOCK+1)*BLOCK),data=await raw(from*8,(toRead-from)*8);
          for(let i=0;i<data.length;i+=8)accumulate(result,data.readFloatLE(i),data.readFloatLE(i+4));from=toRead;
        }
      }
      return result;
    };
    let cycle:Summary|undefined;
    const mapped=async(from:bigint,to:bigint):Promise<Summary>=>{
      const result=empty(),length=BigInt(pcm.sampleCount);if(from>=to)return result;
      if(!request.loop){const a=from<0n?0n:from,b=to>length?length:to;return a<b?range(Number(a),Number(b)):result;}
      let count=to-from,start=Number((from%length+length)%length);
      const leading=Math.min(Number(count),pcm.sampleCount-start);merge(result,await range(start,start+leading));count-=BigInt(leading);
      if(count>=length){cycle??=await range(0,pcm.sampleCount);merge(result,cycle,Number(count/length));count%=length;}
      if(count)merge(result,await range(0,Number(count)));return result;
    };
    const {sourceIn,rate,fps}=request,divisor=BigInt(request.bins),clipEnd=BigInt(request.clipFrames)*divisor;
    const sampleAt=(frame:bigint)=>floor((BigInt(sourceIn.num)*BigInt(rate.den)*BigInt(fps.num)*divisor+frame*BigInt(fps.den)*BigInt(sourceIn.den)*BigInt(rate.num))*BigInt(pcm.sampleRate),BigInt(sourceIn.den)*BigInt(rate.num)*BigInt(fps.num)*divisor);
    const bins:WaveformBin[]=[];
    for(let i=0;i<request.bins;i++){
      const a=BigInt(request.startFrame)*divisor+BigInt(request.frameCount)*BigInt(i),b=a+BigInt(request.frameCount);
      const samples=Number(sampleAt(b)-sampleAt(a)),from=a<0n?0n:a,to=b>clipEnd?clipEnd:b;
      const summary=from<to?await mapped(sampleAt(from),sampleAt(to)):empty();
      bins.push({peak:summary.peak,rms:samples?Math.sqrt(summary.energy/samples):0,samples});
    }
    return {version:1,precision:'prepared-pcm-sample-floor',sampleRate:pcm.sampleRate,sourceSampleCount:pcm.sampleCount,request,bins};
  }finally{await source.close();await index?.close();}
}
