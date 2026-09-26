import {createHash,randomUUID} from 'node:crypto';
import {lstat,readFile,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {ceilTime,compareTime,divideTime,isRational,multiplyTime,rational,subtractTime,timeNumber,type Rational} from '../../core/sequence/time';
import {resolveFfmpegBin} from '../resolveFfmpeg';
import {cacheDirectory,run,publishSequenceAudio} from './media';
import {openSequenceAsset} from './assets';
import {isSequenceReferenceFile} from './references';
import {SharedPreparations} from './sharedPreparation';

export interface SourceWindowAudioRequest {
  version:'source-window-v1';
  /** Half-open source interval, in seconds. No implicit source-end inference. */
  start:Rational;
  end:Rational;
}
// Native-rate atrim -> reset timestamps -> native-rate atempo -> 48kHz resample.
// Changing filter order or boundary interpretation requires a new cache version.
export const SOURCE_WINDOW_DSP_VERSION='source-window-pcm-v1-native-trim-tempo-resample';

export interface SourceWindowTiming {
  request:SourceWindowAudioRequest;
  rate:Rational;
  sourceSampleRate:number;
  firstSourceSample:number;
  afterLastSourceSample:number;
  /** Physical first allowed source sample, not the requested start. */
  sampleOrigin:Rational;
  /** Source seconds; retained even below one output sample. */
  sourcePhase:Rational;
  outputSampleRate:48000;
  /** Output-sample coordinates measured from the requested intent start. */
  originOffsetSamples:Rational;
  supportEndSamples:Rational;
  /** End measured from raw PCM index zero, excluding the initial phase gap. */
  rawSupportEndSamples:Rational;
  requiredRawSamples:number;
}

export interface PreparedSourceWindowAudio extends SourceWindowTiming {
  kind:'source-window-pcm';
  dspVersion:typeof SOURCE_WINDOW_DSP_VERSION;
  file:string;
  channels:2;
  /** Actual FFmpeg length, never a clip duration or quality decision. No padding. */
  dspSampleCount:number;
  shortfallSamples:number;
  excessSamples:number;
  assessment:
    | {status:'insufficient';reason:'dsp-shortfall'}
    | {status:'unassessed';reason:'quality-not-validated'};
}

function exact(value:unknown):Rational {
  if(!isRational(value))throw new Error('素材区間の時刻または速度が不正です');
  return rational(value.num,value.den);
}

/** Exact sampling lattice; rejects unrepresentable metadata instead of losing phase. */
export function sourceWindowTiming(request:SourceWindowAudioRequest,sourceSampleRate:number,rate:Rational):SourceWindowTiming {
  if(!request||request.version!=='source-window-v1'||Object.keys(request).some(key=>!['version','start','end'].includes(key)))throw new Error('未対応の素材区間方式です');
  const start=exact(request.start),end=exact(request.end),normalizedRate=exact(rate);
  if(compareTime(start,rational(0))<0||compareTime(start,end)>=0||compareTime(end,rational(86400))>0)throw new Error('素材区間は0〜24時間の正の範囲で指定してください');
  if(!Number.isSafeInteger(sourceSampleRate)||sourceSampleRate<=0||sourceSampleRate>768000)throw new Error('元音声のサンプルレートが不正です');
  if(compareTime(normalizedRate,rational(1,100))<0||compareTime(normalizedRate,rational(100))>0)throw new Error('音声の再生速度は0.01〜100倍に対応しています');
  const sr=rational(sourceSampleRate),firstSourceSample=ceilTime(multiplyTime(start,sr)),afterLastSourceSample=ceilTime(multiplyTime(end,sr));
  if(firstSourceSample>=afterLastSourceSample)throw new Error('指定区間に音声サンプルがありません');
  const sampleOrigin=divideTime(rational(firstSourceSample),sr),sourcePhase=subtractTime(sampleOrigin,start);
  const outputSamples=(seconds:Rational)=>multiplyTime(divideTime(seconds,normalizedRate),rational(48000));
  const originOffsetSamples=outputSamples(sourcePhase),supportEndSamples=outputSamples(subtractTime(end,start));
  const rawSupportEndSamples=outputSamples(subtractTime(end,sampleOrigin));
  return {request:{version:'source-window-v1',start,end},rate:normalizedRate,sourceSampleRate,firstSourceSample,afterLastSourceSample,
    sampleOrigin,sourcePhase,outputSampleRate:48000,originOffsetSamples,supportEndSamples,rawSupportEndSamples,requiredRawSamples:ceilTime(rawSupportEndSamples)};
}

const preparations=new SharedPreparations<PreparedSourceWindowAudio>();
function completed(timing:SourceWindowTiming,file:string,sampleCount:number):PreparedSourceWindowAudio {
  const shortfallSamples=Math.max(0,timing.requiredRawSamples-sampleCount);
  return {...timing,kind:'source-window-pcm',dspVersion:SOURCE_WINDOW_DSP_VERSION,file,channels:2,dspSampleCount:sampleCount,
    shortfallSamples,excessSamples:Math.max(0,sampleCount-timing.requiredRawSamples),assessment:shortfallSamples?
      {status:'insufficient',reason:'dsp-shortfall'}:{status:'unassessed',reason:'quality-not-validated'}};
}

/** Foundation only: callers must handle phase, support and assessment before playback. */
export async function prepareSequenceSourceWindowAudio(projectDirectory:string,asset:SequenceAsset,streamIndex:number,rate:Rational,
  request:SourceWindowAudioRequest,signal?:AbortSignal):Promise<PreparedSourceWindowAudio> {
  signal?.throwIfAborted();
  const stream=asset.streams.find(s=>s.index===streamIndex&&s.kind==='audio');
  if(!stream)throw new Error('音声ストリームが不正です');
  const timing=sourceWindowTiming(request,stream.sampleRate!,rate);
  if(compareTime(timing.request.end,stream.duration)>0)throw new Error('素材区間が音声ストリームの終端を超えています');
  const fingerprint=asset.fingerprint;
  const caller=await openSequenceAsset(projectDirectory,asset,signal);
  try{
  const info=await caller.handle.stat();
  signal?.throwIfAborted();
  const key=createHash('sha256').update(JSON.stringify([fingerprint,streamIndex,timing,info.size,isSequenceReferenceFile(asset.file)?0:info.mtimeMs,SOURCE_WINDOW_DSP_VERSION])).digest('hex');
  const directory=await cacheDirectory(projectDirectory,'source-window-audio'),destination=join(directory,`${key}.f32le`);
  const result=await preparations.get(destination,async workSignal=>{
    workSignal.throwIfAborted();
    const source=await openSequenceAsset(projectDirectory,asset,workSignal);
    try{
    try {
      const metadata=JSON.parse(await readFile(destination+'.json','utf8')) as PreparedSourceWindowAudio;
      const cached=await lstat(destination);
      if(cached.isSymbolicLink()||!cached.isFile())throw new Error('音声キャッシュが通常のファイルではありません');
      const count=metadata?.dspSampleCount;
      if(Number.isSafeInteger(count)&&count>=0&&cached.size===count*8) {
        const expected=completed(timing,destination,count);
        if(JSON.stringify(metadata)===JSON.stringify(expected)){await source.verify();return expected;}
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
    const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
    const filters=[`atrim=start_sample=${timing.firstSourceSample}:end_sample=${timing.afterLastSourceSample}`,'asetpts=PTS-STARTPTS'];
    let tempo=timeNumber(timing.rate);
    while(tempo>2){filters.push('atempo=2');tempo/=2;}
    while(tempo<.5){filters.push('atempo=0.5');tempo/=.5;}
    if(tempo!==1)filters.push(`atempo=${tempo}`);
    filters.push('aresample=48000');
    const temporary=join(directory,`${key}.${randomUUID()}.tmp`);
    try {
      await run(ffmpeg.bin,['-hide_banner','-loglevel','error','-nostdin','-fd','3','-i','fd:','-map',`0:${streamIndex}`,'-vn',
        '-af',filters.join(','),'-ac','2','-ar','48000','-f','f32le',temporary],workSignal,source.handle.fd);
      workSignal.throwIfAborted();
      const size=(await stat(temporary)).size;
      if(!Number.isSafeInteger(size)||size%8!==0)throw new Error('準備した音声PCMの長さが不正です');
      const prepared=completed(timing,destination,size/8);
      await publishSequenceAudio(temporary,destination,prepared,()=>source.verify(),workSignal);
      return prepared;
    } finally {
      await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
    }finally{await source.close();}
  },signal);
  // Shared work must not share mutable caller metadata.
  await caller.verify();signal?.throwIfAborted();return structuredClone(result);
  }finally{await caller.close();}
}
