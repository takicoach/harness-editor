import { createHash } from 'node:crypto';
import { existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SequenceAsset,SourceTranscript } from '../../core/sequence/model';
import { validateSourceSelection } from '../../core/sequence/validate';
import { NativeTranscriptionStatus,transcriptionActive } from '../../shared/nativeTranscription';
import { HttpError } from '../http';
import { runSequenceTranscription,type TranscriptionRun } from './transcriptionRunner';
import { verifiedSequenceAssetPath } from './assets';
import { SequenceService } from './service';

interface Request {sessionId:string;expectedRevision:number;executionId:string;occurrenceId:string}
interface RecordData {version:1;request:Request;status:NativeTranscriptionStatus;asset:SequenceAsset;before:SourceTranscript|null;resultHash?:string}
interface Job {root:string;directory:string;data:RecordData;controller:AbortController;completion:Promise<void>}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const jobId=(executionId:string)=>digest(executionId).slice(0,32);
function folder(root:string,create=false):string {
  let current=root;
  for(const part of ['.harness','transcriptions']) {
    current=join(current,part);if(create)mkdirSync(current,{recursive:true});
    if(!existsSync(current))return join(root,'.harness','transcriptions');
    const info=lstatSync(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('文字起こしの保存先が不正です');
  }
  return current;
}
function jsonFile(path:string,max=64*1024*1024):unknown {
  const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw new Error('文字起こしの記録が不正です');
  return JSON.parse(readFileSync(path,'utf8'));
}
function persist(job:Job):void {
  const temporary=join(job.directory,'manifest.tmp');
  writeFileSync(temporary,JSON.stringify(job.data),{mode:0o600});renameSync(temporary,join(job.directory,'manifest.json'));
}

/** Results survive reload/restart; only an explicit command may change the sequence. */
export class SequenceTranscriptions {
  private jobs=new Map<string,Job>();
  constructor(private runner:(input:TranscriptionRun)=>Promise<SourceTranscript>=runSequenceTranscription){}
  private key(root:string,id:string){return `${root}\0${id}`;}
  private load(root:string,id:string):Job|undefined {
    if(!/^[a-f0-9]{32}$/.test(id))throw new HttpError(400,'文字起こしのIDが不正です');
    const cached=this.jobs.get(this.key(root,id));if(cached)return cached;
    const directory=join(folder(root),id);if(!existsSync(directory))return undefined;
    if(!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())throw new Error('文字起こしの記録先が不正です');
    const data=jsonFile(join(directory,'manifest.json')) as RecordData;
    if(data.version!==1||data.status?.id!==id||jobId(data.request?.executionId??'')!==id||!data.asset||!Array.isArray(data.asset.streams))throw new Error('文字起こしの記録を読み取れません');
    const job:Job={root,directory,data,controller:new AbortController(),completion:Promise.resolve()};
    if(transcriptionActive(data.status)){data.status.phase='failed';data.status.error='サーバーが停止したため文字起こしを中断しました。もう一度生成してください。';persist(job);}
    return job;
  }
  job(directory:string,id:string):Job {
    const job=this.load(realpathSync(directory),id);if(!job)throw new HttpError(404,'文字起こしが見つかりません');return job;
  }
  list(directory:string):NativeTranscriptionStatus[] {
    const root=realpathSync(directory),path=folder(root);if(!existsSync(path))return [];
    return readdirSync(path).filter(id=>/^[a-f0-9]{32}$/.test(id)).map(id=>({...this.load(root,id)!.data.status})).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  get(projectId:string):NativeTranscriptionStatus|undefined {
    return [...this.jobs.values()].find(job=>job.data.status.projectId===projectId&&transcriptionActive(job.data.status))?.data.status;
  }
  activeCount(){return [...this.jobs.values()].filter(job=>transcriptionActive(job.data.status)).length;}
  start(directory:string,projectId:string,request:Request,sessions:SequenceService,admit:()=>void=()=>undefined):NativeTranscriptionStatus {
    const root=realpathSync(directory),id=jobId(request.executionId),previous=this.load(root,id);
    if(previous){if(JSON.stringify(previous.data.request)!==JSON.stringify(request))throw new HttpError(409,'同じ実行IDに異なる文字起こし要求があります');return {...previous.data.status};}
    if(this.activeCount())throw new HttpError(409,'別の文字起こしが進行中です。完了を待ってください');
    admit();
    const state=sessions.open(root),doc=state.document;
    if(state.sessionId!==request.sessionId||doc.revision!==request.expectedRevision)throw new HttpError(409,'編集内容が変わりました。現在の原音を選び直してください');
    const clip=doc.clips.find(clip=>clip.id===request.occurrenceId);
    if(!clip||clip.content.kind!=='audio'||clip.content.role!=='speech')throw new HttpError(400,'文字起こしする原音の使用箇所を選択してください');
    validateSourceSelection(doc,clip);const content=clip.content,asset=doc.assets.find(asset=>asset.id===content.assetId)!;
    const status:NativeTranscriptionStatus={id,projectId,executionId:request.executionId,assetId:asset.id,assetName:asset.name,streamIndex:content.streamIndex,phase:'queued',createdAt:new Date().toISOString()};
    const destination=join(folder(root,true),id);mkdirSync(destination);
    const job:Job={root,directory:destination,data:{version:1,request:structuredClone(request),status,asset:structuredClone(asset),
      before:structuredClone(doc.transcripts.find(item=>item.assetId===asset.id&&item.streamIndex===content.streamIndex)??null)},controller:new AbortController(),completion:Promise.resolve()};
    persist(job);this.jobs.set(this.key(root,id),job);job.completion=this.run(job);return {...status};
  }
  private async run(job:Job):Promise<void> {
    const {data,controller}=job;
    try {
      const transcript=await this.runner({root:job.root,directory:job.directory,asset:data.asset,streamIndex:data.status.streamIndex,runId:data.status.id,signal:controller.signal,
        progress:value=>{if(!controller.signal.aborted){Object.assign(data.status,value);persist(job);}}});
      controller.signal.throwIfAborted();
      const bytes=JSON.stringify(transcript);writeFileSync(join(job.directory,'result.json'),bytes,{flag:'wx',mode:0o600});data.resultHash=digest(bytes);
      Object.assign(data.status,{phase:'completed',percent:100,wordCount:transcript.words.length,excerpt:transcript.words.map(word=>word.text).join('').slice(0,1000)});
    }catch(error){data.status.phase=controller.signal.aborted?'cancelled':'failed';if(!controller.signal.aborted)data.status.error=error instanceof Error?error.message:String(error);}
    finally {
      try{persist(job);this.jobs.delete(this.key(job.root,data.status.id));}
      catch(error){data.status.phase='failed';data.status.error=`生成結果の記録を保存できません: ${String(error)}`;}
    }
  }
  result(directory:string,id:string):SourceTranscript {
    const job=this.job(directory,id);if(job.data.status.phase!=='completed')throw new HttpError(409,'文字起こしが完了していません');
    const result=jsonFile(join(job.directory,'result.json')) as SourceTranscript;
    if(digest(JSON.stringify(result))!==job.data.resultHash)throw new HttpError(409,'文字起こしの結果ファイルが変更されています');return result;
  }
  async apply(directory:string,id:string,request:Omit<Request,'occurrenceId'>,sessions:SequenceService) {
    const job=this.job(directory,id),transcript=this.result(directory,id);
    await verifiedSequenceAssetPath(job.root,job.data.asset);
    return sessions.execute(directory,{...request,command:{type:'set-transcript',transcript,before:job.data.before,assetFingerprint:job.data.asset.fingerprint}});
  }
  cancel(directory:string,id:string):NativeTranscriptionStatus {
    const job=this.job(directory,id);if(transcriptionActive(job.data.status))job.controller.abort();return {...job.data.status};
  }
  killAll(){for(const job of this.jobs.values())if(transcriptionActive(job.data.status))job.controller.abort();}
}
export const sequenceTranscriptions=new SequenceTranscriptions();
