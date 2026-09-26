import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';
import {verifiedSequenceAssetPath} from './assets';
import {PreviewProxyJobManager,type PreviewProxyJob} from '../previewProxyJob';
import {analyzeProxyNeed,probeDurationSeconds} from '../previewProxyAnalysis';
import {resolveFfmpegBin} from '../resolveFfmpeg';

const jobs=new PreviewProxyJobManager();
const preparing=new Map<string,PreviewProxyJob>();
const active=new Set<string>();
export interface NativeProxyStatus {
  assetId:string;name:string;recommended:boolean;reasons:string[];ready:boolean;
  job?:PreviewProxyJob;error?:string;
}
const key=(project:string,asset:SequenceAsset)=>createHash('sha256').update(project+'\0'+asset.fingerprint).digest('hex');
function directory(project:string):string {
  let path=project;
  for(const segment of ['.harness','preview-proxies']){
    path=join(path,segment);mkdirSync(path,{recursive:true});
    const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('軽量版の保存先が不正です');
  }
  return path;
}
export function nativeProxyPath(project:string,asset:SequenceAsset):string|null {
  const folder=join(project,'.harness','preview-proxies');
  if(!existsSync(folder))return null;
  if(!lstatSync(folder).isDirectory()||lstatSync(folder).isSymbolicLink())throw new Error('軽量版の保存先が不正です');
  const file=join(folder,key(project,asset)+'.mp4');
  if(!existsSync(file))return null;
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('軽量版のファイルが不正です');
  return file;
}
export function nativeProxyStatus(project:string,asset:SequenceAsset):NativeProxyStatus {
  const video=asset.streams.filter(stream=>stream.kind==='video'),stream=video[0];
  const base={assetId:asset.id,name:asset.name,ready:!!nativeProxyPath(project,asset),job:preparing.get(key(project,asset))??jobs.get(key(project,asset))};
  if(video.length!==1||!stream?.width||!stream.height||!stream.frameRate)return {...base,recommended:false,reasons:[],error:'映像ストリームが1本の素材に対応しています'};
  const recommendation=analyzeProxyNeed({sizeBytes:0,durationSeconds:timeNumber(stream.duration),width:stream.width,height:stream.height,
    fps:timeNumber(stream.frameRate),avgFps:null,codecName:stream.codec});
  if(timeNumber(stream.frameRate)>30)recommendation.reasons.push('高フレームレート');
  return {...base,...recommendation,recommended:recommendation.reasons.length>0};
}
/** Return immediately; hashing a large external reference belongs to the preparing phase. */
export function startNativeProxy(project:string,asset:SequenceAsset):NativeProxyStatus {
  const status=nativeProxyStatus(project,asset),id=key(project,asset);
  if(status.error)throw new Error(status.error);
  if(status.ready||status.job&&!['failed','cancelled','done'].includes(status.job.phase))return status;
  if(active.size)throw new Error('ほかの素材の軽量化が終わるまでお待ちください');
  active.add(id);
  const job:PreviewProxyJob={projectId:id,startedAt:Date.now(),phase:'preparing',percent:null};
  preparing.set(id,job);
  void (async()=>{
    try{
      const source=await verifiedSequenceAssetPath(project,asset);
      const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
      const stream=asset.streams.find(stream=>stream.kind==='video')!;
      const folder=directory(project),output=join(folder,id+'.mp4'),temporary=join(folder,id+'.tmp.mp4');
      jobs.discard(id);
      const stop=jobs.subscribe(id,event=>{if(['done','failed','cancelled'].includes(event.phase)){active.delete(id);stop();}});
      jobs.start(id,{ffmpeg:ffmpeg.bin,ffmpegArgs:['-y','-progress','pipe:1','-nostats','-i',source,'-map',`0:${stream.index}`,
        '-an','-vf',"scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-fps_mode','passthrough','-c:v','libx264','-preset','veryfast','-crf','26','-pix_fmt','yuv420p',
        '-force_key_frames','expr:gte(t,n_forced*1)','-movflags','+faststart',temporary],
        tmpOutput:temporary,finalOutput:output,durationSeconds:timeNumber(stream.duration),probeDuration:path=>{const duration=probeDurationSeconds(path);return duration!==null&&Math.abs(duration-timeNumber(stream.duration))<=Math.max(.05,1/timeNumber(stream.frameRate!))?duration:null;}});
      preparing.delete(id);
    }catch(error){active.delete(id);job.phase='failed';job.error={code:'PROXY_PREPARATION_FAILED',message:error instanceof Error?error.message:String(error)};}
  })();
  return {...status,job};
}
