import {randomUUID} from 'node:crypto';
import {constants,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {copyFile,lstat,open,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import type {RenderJob,RenderJobEvent} from './renderJobTypes';
import {parseRenderOptions,renderOutputName,type RenderOptions} from '../shared/renderPreset';
import {HttpError} from './http';
import {SequenceExports,sequenceExports,type LegacySnapshotExportReservation} from './sequence/exports';
import {prepareLegacySequenceSnapshot} from './sequence/migration';
import {sequenceContentHash} from './sequence/store';
import {exportFolder,hashExportFile,ownerAlive,processRegistry,readExportInput,readExportRecord,syncFolder} from './sequence/exportRecords';
import {publishRenderOutput} from './publishRenderOutput';
import {legacyRenderActive,persistLegacyRenderRecord,readLatestLegacyRenderRecord,type LegacyNativeRenderRecord} from './legacyNativeRenderRecords';

interface Run {root:string;record:LegacyNativeRenderRecord;reservation:LegacySnapshotExportReservation;completion:Promise<void>;storageError?:boolean;finished?:boolean}
type Preparation=typeof prepareLegacySequenceSnapshot;
type VerificationResult={signature:string;result:boolean}|{signature:string;error:unknown};
/** Record ids this process is rendering, for recognizing this PID on records of a crashed server. */
const runningHere=processRegistry('legacy-renders.running');
/** Legacy API/SSE facade. SequenceExports alone owns/counts the underlying work. */
export class LegacyNativeRenderJobs {
  private readonly running=new Map<string,Run>();
  private readonly snapshots=new Map<string,{root:string;record:LegacyNativeRenderRecord}>();
  private readonly restoreGeneration=new Map<string,number>();
  private readonly verified=new Map<string,VerificationResult>();
  private readonly verifying=new Map<string,{signature:string;promise:Promise<boolean>}>();
  private readonly events=new EventEmitter();
  constructor(private readonly exports:SequenceExports=sequenceExports,private readonly prepare:Preparation=prepareLegacySequenceSnapshot){}
  exists(id:string){return this.running.has(id);}
  // Project deletion and heavy-job counts already observe SequenceExports' reservation.
  get(_id:string):undefined{return undefined;}
  activeCount(){return 0;}
  getSnapshot(id:string):RenderJob|undefined {const record=this.running.get(id)?.record??this.snapshots.get(id)?.record;return record?structuredClone(record.job):undefined;}
  subscribe(id:string,listener:(event:RenderJobEvent)=>void){this.events.on(id,listener);return ()=>{this.events.off(id,listener);};}
  discard(_id:string):void {/* Durable terminal state is retained for returning tabs. */}
  warn(_id:string,_message:string):boolean{return false;}
  private persist(run:Run):void {persistLegacyRenderRecord(run.root,run.record);run.storageError=false;}
  private emit(run:Run):void {for(const listener of this.events.listeners(run.record.job.projectId))try{listener(structuredClone(run.record.job));}catch{/* A disconnected observer cannot cancel the export. */}}
  private outputDirectory(root:string,create=true):string {
    const directory=join(root,'out');if(create)mkdirSync(directory,{recursive:true});
    let stat;try{stat=lstatSync(directory);}catch(error){if(!create&&(error as NodeJS.ErrnoException).code==='ENOENT')return directory;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('動画の保存先フォルダが不正です');return directory;
  }
  private temporary(root:string,id:string){return join(this.outputDirectory(root,false),`.sme-native-${id}.mp4`);}
  private async ownsTemporary(file:string,record:LegacyNativeRenderRecord):Promise<boolean> {
    const expected=record.publication;if(!expected)return false;
    try{const stat=await lstat(file,{bigint:true});return stat.isFile()&&!stat.isSymbolicLink()&&String(stat.dev)===expected.device&&String(stat.ino)===expected.inode;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  }
  private async matchesPublication(file:string,record:LegacyNativeRenderRecord):Promise<boolean> {
    const expected=record.publication;if(!expected)return false;
    try {const stat=await lstat(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||String(stat.dev)!==expected.device||String(stat.ino)!==expected.inode)return false;
      const actual=await hashExportFile(file);return actual.sha256===expected.sha256&&actual.bytes===expected.bytes;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
  }
  private async verifyNativeBinding(root:string,record:LegacyNativeRenderRecord):Promise<void> {
    const native=readExportRecord(root,record.id),published=record.publication;
    if(!published||native.version!==3||native.request.executionId!==record.executionId||native.request.outputName!==record.options.outputName||
      native.request.settings.resolution!==record.options.resolution||native.request.settings.quality!==record.options.quality||
      native.output?.sha256!==published.sha256||native.output.bytes!==published.bytes)throw new Error('公開した動画と書き出し記録が一致しません');
    if(record.options.ducking){const ducking=readExportInput(root,native).ducking;
      if(ducking.enabled!==record.options.ducking.enabled||ducking.strength!==record.options.ducking.strength)throw new Error('公開した動画の音声設定が一致しません');}
    await this.exports.download(root,record.id);
  }
  private async verifyPublication(root:string,record:LegacyNativeRenderRecord):Promise<boolean> {
    const key=JSON.stringify([root,record.id]),directory=join(exportFolder(root),record.id),output=join(this.outputDirectory(root,false),record.options.outputName);
    const signature=async()=>JSON.stringify([record.executionId,record.options,record.publication,await Promise.all(
      ['manifest.json','input.json','verification.json','output.mp4'].map(file=>join(directory,file)).concat(directory,output).map(async file=>{
        try{const stat=await lstat(file,{bigint:true});return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.isSymbolicLink(),stat.isFile(),stat.isDirectory()].map(String);}
        catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
      }))]);
    const before=await signature(),cached=this.verified.get(key);
    if(cached?.signature===before){if('error' in cached)throw cached.error;return cached.result;}
    const pending=this.verifying.get(key);if(pending?.signature===before)return pending.promise;
    const remember=(value:VerificationResult)=>{this.verified.set(key,value);while(this.verified.size>16)this.verified.delete(this.verified.keys().next().value!);};
    const promise=(async()=>{
      try{await this.verifyNativeBinding(root,record);const matches=await this.matchesPublication(output,record);
        if(before!==await signature())throw new Error('動画の確認中に保存先が変更されています');
        remember({signature:before,result:matches});return matches;
      }catch(error){if(before===await signature())remember({signature:before,error});throw error;}
    })();
    this.verifying.set(key,{signature:before,promise});
    try{return await promise;}finally{if(this.verifying.get(key)?.promise===promise)this.verifying.delete(key);}
  }
  /** Resolve durable state before connecting SSE or revealing output. Never re-prepare. */
  async restore(id:string,directory:string):Promise<void> {
    const root=realpathSync(directory),generation=(this.restoreGeneration.get(id)??0)+1;this.restoreGeneration.set(id,generation);
    this.reconcile(id,root);if(this.running.has(id))return;
    if(this.snapshots.get(id)?.root!==root)this.snapshots.delete(id);
    const record=readLatestLegacyRenderRecord(root,id);if(!record){this.snapshots.delete(id);return;}
    if(legacyRenderActive(record.job.phase)&&!ownerAlive(record.ownerPid,()=>runningHere.has(record.id))){
      let published=false;
      if(record.publication){
        published=await this.verifyPublication(root,record);
      }
      record.job.phase=published?'done':'failed';
      if(!published)record.job.error={code:'server-stopped',message:'サーバーが停止したため書き出しを中断しました。内容を確認して、新しく書き出してください。'};
      persistLegacyRenderRecord(root,record);
      const temporary=this.temporary(root,record.id);if(await this.ownsTemporary(temporary,record))await unlink(temporary);
    }
    if(record.job.phase==='done'||record.job.phase==='failed'&&record.publication){
      if(await this.verifyPublication(root,record)){
        if(record.job.phase!=='done'){record.job.phase='done';delete record.job.error;persistLegacyRenderRecord(root,record);}
      }else if(record.job.phase==='done'){
        record.job.phase='failed';record.job.error={code:'output-changed',message:'完成後に保存先の動画が変更または削除されています。書き出し履歴を確認してください。'};persistLegacyRenderRecord(root,record);
      }
    }
    // A slow restore cannot replace a newer run or a more recent restoration.
    if(!this.running.has(id)&&this.restoreGeneration.get(id)===generation)this.snapshots.set(id,{root,record});
  }
  /** Starting/cancelling work must not depend on observing old terminal files. */
  reconcile(id:string,directory:string):void {
    const active=this.running.get(id);if(!active)return;
    if(active.root!==realpathSync(directory))throw new HttpError(409,'別の保存先で書き出しが進行中です');
    if(active.storageError&&active.finished){
      try{this.persist(active);
        // lookup retries a native terminal record write before the shared lease is released.
        this.exports.lookup(active.root,active.record.executionId);active.reservation.release();this.running.delete(id);runningHere.delete(active.record.id);this.snapshots.set(id,{root:active.root,record:active.record});
      }catch(error){active.storageError=true;throw error;}
    }
  }
  start(id:string,input:{projectDir:string;origin:string;options:RenderOptions}):RenderJob {
    if(this.exists(id))throw new HttpError(409,'already-running');
    this.restoreGeneration.set(id,(this.restoreGeneration.get(id)??0)+1);
    const options=parseRenderOptions(input.options);if(!options)throw new HttpError(400,'invalid-render-options');
    const root=realpathSync(input.projectDir),outputName=renderOutputName(options),out=this.outputDirectory(root);
    try{lstatSync(join(out,outputName));throw new HttpError(409,'同じ名前の動画があります。別のファイル名を指定してください。');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const executionId=randomUUID(),reservation=this.exports.reserveLegacySnapshot(root,id,executionId);
    const record:LegacyNativeRenderRecord={version:1,id:reservation.id,executionId,ownerPid:process.pid,options:{...options,outputName},
      job:{projectId:id,startedAt:Date.now(),outputFile:outputName,phase:'preparing'}};
    const run:Run={root,record,reservation,completion:Promise.resolve()};
    try {this.persist(run);this.running.set(id,run);runningHere.add(record.id);this.snapshots.delete(id);this.emit(run);run.completion=this.run(run,input.origin);return structuredClone(record.job);}
    catch(error){reservation.release();throw error;}
  }
  private async run(run:Run,origin:string):Promise<void> {
    const {root,record,reservation}=run,signal=reservation.signal;let timer:ReturnType<typeof setInterval>|undefined,published=false;
    try {
      const {document}=await this.prepare(root,signal);signal.throwIfAborted();
      if(record.options.ducking)document.ducking=structuredClone(record.options.ducking);
      reservation.start(origin,{kind:'legacy-snapshot',executionId:record.executionId,sourceFingerprint:document.legacy!.sourceFingerprint,
        snapshotHash:sequenceContentHash(document),expectedRevision:document.revision,settings:{resolution:record.options.resolution,quality:record.options.quality},outputName:record.options.outputName},document);
      const native=this.exports.job(root,record.id);
      const progress=()=>{
        const status=native.status;record.job.phase=status.phase==='rendering'?'rendering':status.phase==='finalizing'||status.phase==='complete'?'finalizing':'preparing';
        record.job.progress={frames:status.completedFrames,total:status.totalFrames,percent:status.totalFrames?Math.min(100,Math.round(status.completedFrames/status.totalFrames*100)):0};
        this.persist(run);this.emit(run);
      };
      timer=setInterval(()=>{try{progress();}catch(error){run.storageError=true;reservation.cancel();record.job.error={code:'storage-error',message:String(error)};}},250);
      await native.completion;clearInterval(timer);timer=undefined;if(native.status.phase==='cancelled')reservation.cancel();signal.throwIfAborted();
      if(native.status.phase!=='complete')throw new Error(native.status.error??'動画の書き出しに失敗しました');
      progress();const source=await this.exports.download(root,record.id,signal),temporary=this.temporary(root,record.id);
      const expected=readExportRecord(root,record.id).output;if(!expected)throw new Error('書き出した動画の検証記録がありません');
      await copyFile(source,temporary,constants.COPYFILE_EXCL|constants.COPYFILE_FICLONE);
      const stat=await lstat(temporary,{bigint:true});record.publication={sha256:expected.sha256,bytes:expected.bytes,device:String(stat.dev),inode:String(stat.ino)};this.persist(run);
      const file=await open(temporary,'r');try{await file.sync();}finally{await file.close();}
      const bytes=await hashExportFile(temporary,signal);
      if(bytes.sha256!==expected.sha256||bytes.bytes!==expected.bytes)throw new Error('保存先へコピーした動画を確認できません');
      this.persist(run);signal.throwIfAborted();
      publishRenderOutput(temporary,join(this.outputDirectory(root),record.options.outputName));published=true;syncFolder(join(root,'out'));
      record.job.phase='done';this.persist(run);
    }catch(error){
      if(published){record.job.phase='done';delete record.job.error;record.job.warning='動画は保存されましたが、書き出し履歴の保存を再試行しています。';}
      else {record.job.phase=signal.aborted&&record.job.error?.code!=='storage-error'?'cancelled':'failed';
        record.job.error??={code:signal.aborted?'cancelled':'native-render-failed',message:error instanceof Error?error.message:String(error)};}
      try{this.persist(run);}catch{run.storageError=true;}
    }finally {
      if(timer)clearInterval(timer);
      try{const temporary=this.temporary(root,record.id);if(await this.ownsTemporary(temporary,record))await unlink(temporary);}
      catch(error){record.job.error??={code:'cleanup-failed',message:String(error)};}
      run.finished=true;
      try{this.persist(run);reservation.release();this.snapshots.set(record.job.projectId,{root,record});this.running.delete(record.job.projectId);runningHere.delete(record.id);}
      catch{run.storageError=true;}
      this.emit(run);
    }
  }
  cancel(id:string):boolean {const run=this.running.get(id);if(!run)return false;run.reservation.cancel();return true;}
  killAll():void {for(const run of this.running.values())run.reservation.cancel();}
  async wait(id:string):Promise<void> {await this.running.get(id)?.completion;}
}
