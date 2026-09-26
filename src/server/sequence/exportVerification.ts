import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { SequenceDocument } from '../../core/sequence/model';
import { compareTime,rational } from '../../core/sequence/time';

const probeSchema=z.object({streams:z.array(z.object({codec_type:z.string(),codec_name:z.string().optional(),
  width:z.number().optional(),height:z.number().optional(),nb_frames:z.string().optional(),avg_frame_rate:z.string().optional(),
  color_space:z.string().optional(),color_primaries:z.string().optional(),color_transfer:z.string().optional(),color_range:z.string().optional(),
  time_base:z.string().optional(),duration_ts:z.number().optional(),sample_rate:z.string().optional(),channels:z.number().optional()}).passthrough())}).passthrough();
/** Shared by a new encode and verification of a pre-manifest completed export. */
export function verifyExportProbe(document:SequenceDocument,input:unknown,sampleCount:number,outputResolution=document.resolution):void {
  const probe=probeSchema.parse(input),videos=probe.streams.filter(stream=>stream.codec_type==='video'),audios=probe.streams.filter(stream=>stream.codec_type==='audio');
  const video=videos[0],audio=audios[0];
  if(videos.length!==1||!video||video.codec_name!=='h264'||Number(video.nb_frames)!==document.sequenceEndFrame||video.width!==outputResolution.width||video.height!==outputResolution.height)
    throw new Error('書き出した動画の形式・寸法またはフレーム数が一致しません');
  const [num,den]=String(video.avg_frame_rate).split('/').map(Number);
  if(!num||!den||compareTime(rational(num,den),document.fps)!==0)throw new Error('書き出した動画のfpsが一致しません');
  if(video.color_space!=='bt709'||video.color_primaries!=='bt709'||video.color_transfer!=='iec61966-2-1'||video.color_range!=='tv')
    throw new Error('書き出した動画の色の記録が一致しません');
  if(audios.length!==1||!audio||audio.codec_name!=='aac'||audio.sample_rate!=='48000'||audio.channels!==2||audio.time_base!=='1/48000'
    ||!Number.isSafeInteger(audio.duration_ts)||!Number.isSafeInteger(sampleCount)||Math.abs(audio.duration_ts!-sampleCount)>1)
    throw new Error('書き出した動画の音声の形式または長さが一致しません');
}
/** Probing a finished local file takes well under a second; past this limit FFprobe is stalled, not slow. */
export const EXPORT_PROBE_TIMEOUT_MS=30000;
/** Streams and container of a finished export, as FFprobe reports them. */
export async function probeExportFile(ffprobe:string,file:string,{signal,timeout=EXPORT_PROBE_TIMEOUT_MS,maxBuffer}:{signal?:AbortSignal;timeout?:number;maxBuffer:number}):Promise<unknown> {
  let stdout:string;
  try{({stdout}=await promisify(execFile)(ffprobe,['-v','error','-show_streams','-show_format','-of','json',file],{signal,timeout,maxBuffer}));}
  catch(error){
    // execFile marks only its own timeout kill; a cancellation stays an AbortError.
    if(!signal?.aborted&&(error as {killed?:boolean}).killed===true)throw new Error(`完成した動画を検査できませんでした。FFprobe が ${timeout/1000} 秒以内に終わりませんでした`,{cause:error});
    throw error;
  }
  return JSON.parse(stdout);
}
