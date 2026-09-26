import { spawn } from 'node:child_process';
import { lstat,readFile,writeFile,unlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import type { SequenceAsset,SourceTranscript } from '../../core/sequence/model';
import type { NativeTranscriptionStatus } from '../../shared/nativeTranscription';
import { parseGeneratedTranscript } from '../../core/sequence/transcript';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolvePythonBinAsync } from '../resolvePython';
import { openSequenceAsset } from './assets';

export interface TranscriptionRun { root:string;directory:string;asset:SequenceAsset;streamIndex:number;runId:string;signal:AbortSignal;progress(value:Partial<NativeTranscriptionStatus>):void }

/** Drain both pipes, and resolve only after process exit. Cancel waits for termination. */
export function runTranscriptionProcess(binary:string,args:string[],signal:AbortSignal,onLine:(line:string)=>void=()=>undefined,inputFd?:number):Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const process=spawn(binary,args,{stdio:['ignore','pipe','pipe',...(inputFd===undefined?[]:[inputFd])]}),parts:string[]=[];
    let buffered='',stderr='',failed:Error|undefined,timer:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{if(timer)return;process.kill('SIGTERM');timer=setTimeout(()=>process.kill('SIGKILL'),2000);timer.unref();};
    signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
    process.stdout!.setEncoding('utf8');process.stderr!.setEncoding('utf8');
    process.stdout!.on('data',(data:string)=>{
      buffered+=data;if(buffered.length>1024*1024){failed=new Error('文字起こしの進捗応答が大きすぎます');stop();return;}
      parts.push(...buffered.split('\n'));buffered=parts.pop()!;
      for(const line of parts.splice(0)){try{onLine(line);}catch(error){failed=error instanceof Error?error:new Error(String(error));stop();}}
    });
    process.stderr!.on('data',(data:string)=>{stderr=(stderr+data).slice(-4000);});
    process.on('error',error=>{failed=error;});
    process.on('close',code=>{
      signal.removeEventListener('abort',stop);if(timer)clearTimeout(timer);
      if(signal.aborted)reject(signal.reason??new Error('中止しました'));
      else if(failed)reject(failed);else if(code!==0)reject(new Error(stderr||`文字起こし処理が終了しました（${code}）`));else resolve();
    });
  });
}

export async function runSequenceTranscription(input:TranscriptionRun):Promise<SourceTranscript> {
  const {root,directory,asset,streamIndex,runId,signal,progress}=input;
  const stream=asset.streams.find(stream=>stream.index===streamIndex && stream.kind==='audio');if(!stream)throw new Error('原音の音声トラックがありません');
  const audio=join(directory,'source.wav'),output=join(directory,'raw-transcript.json');
  try {
    progress({phase:'preparing'});
    const ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
    const source=await openSequenceAsset(root,asset,signal);
    try{
      // Keep the verified descriptor until child close, including cancellation.
      // A mutable path must never be reopened between admission and extraction.
      await runTranscriptionProcess(ffmpeg.bin,['-hide_banner','-loglevel','error','-nostdin','-fd','3','-i','fd:','-map',`0:${streamIndex}`,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',audio],signal,undefined,source.handle.fd);
      await source.verify();
    }finally{await source.close();}
    let params:Record<string,unknown>={};
    try {
      const file=join(root,'transcribe_params.json'),info=await lstat(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024)throw new Error('文字起こし設定の形式が不正です');
      const value=JSON.parse(await readFile(file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('文字起こし設定の形式が不正です');params=value;
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await writeFile(join(directory,'params.json'),JSON.stringify({...params,word_timestamps:true}),{flag:'wx',mode:0o600});
    const python=await resolvePythonBinAsync(signal);let reportedError:string|undefined,completed=false;
    const args=[resolve(import.meta.dirname,'../../../scripts/transcribe.py'),'--video',audio,'--out',output,'--params',join(directory,'params.json')];
    if(process.env.SME_TRANSCRIBE_MOCK==='1')args.push('--mock-backend');
    progress({phase:'loading-model'});
    try {await runTranscriptionProcess(python,args,signal,line=>{
      let event:{phase?:string;percent?:unknown;error?:{message?:unknown}};try{event=JSON.parse(line);}catch{return;}
      if(event.phase==='failed')reportedError=typeof event.error?.message==='string'?event.error.message:'文字起こしに失敗しました';
      if(event.phase==='completed')completed=true;
      if(['loading-model','analyzing','writing'].includes(event.phase??''))progress({phase:event.phase as NativeTranscriptionStatus['phase'],
        ...(typeof event.percent==='number'&&Number.isFinite(event.percent)?{percent:Math.max(0,Math.min(100,event.percent))}:{})});
    });}catch(error){if(reportedError&&!signal.aborted)throw new Error(reportedError);throw error;}
    if(reportedError||!completed)throw new Error(reportedError??'文字起こしの完了を確認できませんでした');
    const info=await lstat(output);if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024)throw new Error('文字起こし結果の形式が不正です');
    return parseGeneratedTranscript(JSON.parse(await readFile(output,'utf8')),asset.id,stream,runId);
  }finally {await unlink(audio).catch(()=>undefined);}
}
