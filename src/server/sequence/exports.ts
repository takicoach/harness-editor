import { randomUUID } from 'node:crypto';
import { readFile,rename,unlink,writeFile } from 'node:fs/promises';
import { realpathSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { sequenceContentHash } from './store';
import type { SequenceSessionState } from './service';
import type { SequenceDocument } from '../../core/sequence/model';
import { assertLegacySequenceAuthority } from './authority';
import { HttpError } from '../http';
import type { NativeExportStatus } from '../../shared/nativeExport';
import {nativeExportSettings} from '../../shared/nativeExport';
import {targetResolution} from '../../shared/renderPreset';
import { runSequenceExport,type ExportRunInput } from './exportRunner';
import { acquireExportAdmission,activeExportAdmission } from './exportAdmission';
import { prepareLegacyExport } from './legacyExports';
import { assertVerifiedSettings,createExportRecord,digest,exportActive,exportDirectory,exportDownloadUrl,exportIds,exportScratchFiles,exportJobId,exportRequestSchema,legacySnapshotRequestSchema,hasFrozenSettings,hashExportFile,ownerAlive,persistExport,processRegistry,readExportInput,readExportRecord,verifiedExportOutput,type ExportRecord,type ExportRequest,type LegacySnapshotExportRequest } from './exportRecords';

interface ExportJob {record:ExportRecord;readonly status:NativeExportStatus;readonly plan:ScenePlan;projectDirectory:string;directory:string;controller:AbortController;completion:Promise<void>;storageError?:boolean;releaseAdmission?():void}
interface LegacyReservation {root:string;projectId:string;id:string;controller:AbortController;releaseAdmission:()=>void;started:boolean}
export interface LegacySnapshotExportReservation {
  readonly id:string;readonly signal:AbortSignal;
  start(origin:string,request:LegacySnapshotExportRequest,document:SequenceDocument):NativeExportStatus;
  cancel():void;
  /** Call after preparation settles, the native runner stops, and out/ publication finishes. */
  release():void;
}
/** Every export this process is running, for recognizing this PID on records of a crashed server. */
const runningHere=processRegistry('exports.running');
/** Unreadable records already reported, so polling does not repeat the warning. */
const unreadable=new Set<string>();
/** The map owns running work only; completed plans and output bytes are read on demand. */
export class SequenceExports {
  private readonly jobs=new Map<string,ExportJob>();
  private readonly reservations=new Map<string,LegacyReservation>();
  constructor(private readonly runner:(input:ExportRunInput)=>Promise<void>=runSequenceExport){}
  private key(root:string,id:string){return `${root}\0${id}`;}
  private track(key:string,job:ExportJob){this.jobs.set(key,job);runningHere.add(key);}
  private untrack(key:string){this.jobs.delete(key);runningHere.delete(key);}
  private wrap(root:string,record:ExportRecord):ExportJob {
    return {record,get status(){return record.status;},get plan(){return new ScenePlan(readExportInput(root,record));},projectDirectory:root,
      directory:exportDirectory(root,record.status.id),controller:new AbortController(),completion:Promise.resolve()};
  }
  private load(root:string,id:string):ExportJob {
    const cached=this.jobs.get(this.key(root,id));
    if(cached){
      if(cached.storageError){
        try{persistExport(cached.directory,cached.record);cached.releaseAdmission?.();this.untrack(this.key(root,id));cached.storageError=false;}catch{/* Keep the explicit storage error and block new work until storage recovers. */}
      }
      return cached;
    }
    const record=readExportRecord(root,id),job=this.wrap(root,record);
    if(exportActive(record.status.phase)&&!ownerAlive(record.ownerPid,()=>runningHere.has(this.key(root,id)))) {
      record.status.phase='failed';record.status.finishedAt=new Date().toISOString();record.status.error='サーバーが停止したため書き出しを中断しました。内容を確認して、新しく書き出してください。';
      delete record.status.downloadUrl;persistExport(job.directory,record);
      for(const file of Object.values(exportScratchFiles)){
        try{unlinkSync(join(job.directory,file));}catch(error){
          if((error as NodeJS.ErrnoException).code!=='ENOENT'){
            record.status.error+=' 一時ファイルを削除できませんでした。保存先を確認してください。';persistExport(job.directory,record);
          }
        }
      }
    }
    return job;
  }
  start(projectDirectory:string,projectId:string,origin:string,input:ExportRequest,snapshot:()=>SequenceSessionState,admit:()=>void=()=>undefined):NativeExportStatus {
    const parsed=exportRequestSchema.parse(input),request={...parsed,settings:nativeExportSettings(parsed.settings)};
    return this.startPrepared(projectDirectory,projectId,origin,request,()=>{
      const state=snapshot();
      if(state.sessionId!==request.sessionId||state.document.revision!==request.expectedRevision||state.dirty)throw new HttpError(409,'編集内容が変わっています。現在の編集を保存してから書き出してください');
      return state.document;
    },admit);
  }
  /** The caller owns cancellable preparation. Accept only its immutable legacy
   * snapshot, without manufacturing a native session or saving editing data.
   * Retries must reuse the persisted request and snapshot: preparing again creates
   * a new document identity even when the source files have not changed. */
  startLegacySnapshot(projectDirectory:string,projectId:string,origin:string,input:LegacySnapshotExportRequest,document:SequenceDocument,admit:()=>void=()=>undefined):NativeExportStatus {
    return this.startLegacySnapshotPrepared(projectDirectory,projectId,origin,input,document,admit);
  }
  /** One admission covers asynchronous preparation, native rendering, and the
   * legacy facade's final publication. No release/reacquire window or second count. */
  reserveLegacySnapshot(projectDirectory:string,projectId:string,executionId:string,admit:()=>void=()=>undefined):LegacySnapshotExportReservation {
    const root=realpathSync(projectDirectory),id=exportJobId(executionId),key=this.key(root,id);
    assertLegacySequenceAuthority(root);
    if(this.activeCount()||this.list(root).some(job=>exportActive(job.phase)))throw new HttpError(409,'別の書き出しが進行中です。完了を待ってください');
    if(exportIds(root).includes(id))throw new HttpError(409,'この書き出しIDは保存済みです。保存された要求から結果を確認してください');
    admit();const releaseAdmission=acquireExportAdmission(root,id);
    const state:LegacyReservation={root,projectId,id,controller:new AbortController(),releaseAdmission,started:false};
    this.reservations.set(key,state);
    return Object.freeze({id,signal:state.controller.signal,
      start:(origin:string,request:LegacySnapshotExportRequest,document:SequenceDocument)=>{
        if(this.reservations.get(key)!==state||state.started||request.executionId!==executionId)throw new HttpError(409,'書き出しの準備状態が変わっています');
        state.controller.signal.throwIfAborted();state.started=true;
        return this.startLegacySnapshotPrepared(root,projectId,origin,request,document,()=>undefined,state);
      },
      cancel:()=>{if(this.reservations.get(key)!==state)return;state.controller.abort();this.jobs.get(key)?.controller.abort();},
      release:()=>{
        if(this.reservations.get(key)!==state)return;
        const job=this.jobs.get(key);
        if(job&&(exportActive(job.status.phase)||job.storageError))throw new HttpError(503,'書き出しの終了処理を待っています');
        releaseAdmission();this.reservations.delete(key);
      }});
  }
  private startLegacySnapshotPrepared(projectDirectory:string,projectId:string,origin:string,input:LegacySnapshotExportRequest,document:SequenceDocument,admit:()=>void,reservation?:LegacyReservation):NativeExportStatus {
    const parsed=legacySnapshotRequestSchema.parse(input),request={...parsed,settings:nativeExportSettings(parsed.settings)};
    return this.startPrepared(projectDirectory,projectId,origin,request,()=>{
      assertLegacySequenceAuthority(projectDirectory);
      if(document.revision!==request.expectedRevision||document.legacy?.sourceFingerprint!==request.sourceFingerprint||sequenceContentHash(document)!==request.snapshotHash)
        throw new HttpError(409,'旧案件の書き出し用データが変更されています。現在の内容からやり直してください');
      return document;
    },admit,reservation);
  }
  private startPrepared(projectDirectory:string,projectId:string,origin:string,request:(ExportRequest&{settings:ReturnType<typeof nativeExportSettings>})|LegacySnapshotExportRequest,snapshot:()=>SequenceDocument,admit:()=>void,reservation?:LegacyReservation):NativeExportStatus {
    const root=realpathSync(projectDirectory),id=exportJobId(request.executionId);
    const replay=()=>{
      if(!exportIds(root).includes(id))return;
      const previous=this.load(root,id);
      const old=previous.record.request,normalized=old?{...old,settings:nativeExportSettings('settings' in old?old.settings:undefined)}:null;
      if(JSON.stringify(normalized)!==JSON.stringify(request)||previous.status.projectId!==projectId)throw new HttpError(409,'同じ書き出しIDに異なる要求があります');
      return {...previous.status};
    };
    const existing=replay();if(existing)return existing;
    const historical=this.list(root).find(job=>job.historical&&job.executionId===request.executionId);
    if(historical)throw new HttpError(409,'以前の書き出しには開始要求の記録がありません。履歴から結果を確認してください');
    if([...this.jobs.values()].some(job=>job.storageError))throw new HttpError(503,'書き出し結果の記録を保存できません。保存先を確認してください');
    if(this.activeCount()>(reservation?1:0)||this.list(root).some(job=>exportActive(job.phase))){
      const accepted=replay();if(accepted)return accepted;
      throw new HttpError(409,'別の書き出しが進行中です。完了を待ってください');
    }
    admit();const plan=new ScenePlan(snapshot());
    if(!plan.document.sequenceEndFrame)throw new HttpError(400,'出力する内容がありません');
    const outputResolution=targetResolution(plan.document.resolution.width,plan.document.resolution.height,request.settings.resolution);
    if(outputResolution.width%2||outputResolution.height%2)throw new HttpError(400,'MP4の幅と高さは偶数で指定してください');
    const status={id,projectId,revision:plan.document.revision,contentHash:sequenceContentHash(plan.document),settings:request.settings,outputResolution,
      executionId:request.executionId,phase:'queued' as const,completedFrames:0,totalFrames:plan.document.sequenceEndFrame,createdAt:new Date().toISOString()};
    const record:ExportRecord='kind' in request?{version:3,request,ownerPid:process.pid,status}:{version:2,request,ownerPid:process.pid,status};
    let release:()=>void;
    try{
      if(reservation){
        if(this.reservations.get(this.key(root,id))!==reservation)throw new HttpError(409,'書き出しの準備状態が変わっています');
        reservation.controller.signal.throwIfAborted();
        release=()=>undefined;
      }else release=acquireExportAdmission(root,id);
    }catch(error){const accepted=replay();if(accepted)return accepted;throw error;}
    try {
      const accepted=replay();if(accepted){release();return accepted;}
      // Admission covers publication as well as encoding, including another server's start.
      if(this.list(root).some(job=>exportActive(job.phase)))throw new HttpError(409,'別の書き出しが進行中です。完了を待ってください');
      createExportRecord(root,record,plan.document);
      const job=this.wrap(root,record);job.releaseAdmission=release;this.track(this.key(root,id),job);
      job.completion=this.run(job,plan,origin);return {...job.status};
    }catch(error){release();throw error;}
  }
  private async run(job:ExportJob,plan:ScenePlan,origin:string):Promise<void> {
    const {record,controller,directory}=job,status=record.status;let lastProgress=0,published=false;
    const progress=()=>{if(Date.now()-lastProgress>=250){persistExport(directory,record);lastProgress=Date.now();}};
    try {
      controller.signal.throwIfAborted();
      const settings=nativeExportSettings(hasFrozenSettings(record)?record.request.settings:undefined);
      await this.runner({plan,settings,projectDirectory:job.projectDirectory,directory,status,origin,signal:controller.signal,progress});
      controller.signal.throwIfAborted();
      const verificationBytes=await readFile(join(directory,'verification.json'),'utf8'),verification=JSON.parse(verificationBytes);
      if(verification.revision!==status.revision||verification.contentHash!==status.contentHash)throw new Error('書き出しの検証結果と入力が一致しません');
      if(hasFrozenSettings(record))assertVerifiedSettings(verification,settings,status.outputResolution);
      const output=await hashExportFile(join(directory,'output.mp4'),controller.signal);
      record.output={sha256:output.sha256,bytes:output.bytes,verificationHash:digest(verificationBytes)};
      controller.signal.throwIfAborted();status.phase='complete';status.completedFrames=status.totalFrames;status.finishedAt=new Date().toISOString();
      status.downloadUrl=exportDownloadUrl(status.projectId,status.id);
      persistExport(directory,record);
      published=true;
      const receipt=join(job.projectDirectory,'.harness',`last-export.${randomUUID()}.tmp`);
      try {
        await writeFile(receipt,JSON.stringify({jobId:status.id,revision:status.revision,contentHash:status.contentHash}),{flag:'wx',mode:0o600});
        await rename(receipt,join(job.projectDirectory,'.harness','last-export.json'));
      }catch(error){
        status.error=`動画は完成しましたが、一覧の更新に失敗しました: ${String(error).slice(0,2000)}`;
        try{persistExport(directory,record);}catch{/* The completed manifest is already durable; do not downgrade a published output. */}
      }
      finally{await unlink(receipt).catch(()=>undefined);}
    }catch(error) {
      status.phase=controller.signal.aborted?'cancelled':'failed';status.finishedAt=new Date().toISOString();delete status.downloadUrl;delete record.output;
      if(!controller.signal.aborted)status.error=error instanceof Error?error.message.slice(0,4000):String(error).slice(0,4000);
    }finally {
      try{if(!published)persistExport(directory,record);job.releaseAdmission?.();this.untrack(this.key(job.projectDirectory,status.id));}
      catch(error){if(!published){status.phase='failed';delete status.downloadUrl;}job.storageError=true;status.error=`書き出し結果の記録を保存できません: ${String(error).slice(0,2000)}`;}
    }
  }
  job(projectDirectory:string,id:string):ExportJob {return this.load(realpathSync(projectDirectory),id);}
  lookup(projectDirectory:string,executionId:string):NativeExportStatus|undefined {
    const root=realpathSync(projectDirectory),id=exportJobId(executionId);
    return exportIds(root).includes(id)?{...this.load(root,id).status}:this.list(root).find(job=>job.historical&&job.executionId===executionId);
  }
  list(projectDirectory:string):NativeExportStatus[] {
    const root=realpathSync(projectDirectory);
    return exportIds(root).flatMap(id=>{
      // One unreadable record must not block history, busy checks, or new exports. The admission
      // still serializes exports across servers, and downloading that record stays refused.
      try{return [{...this.load(root,id).status}];}
      catch(error){
        if(!unreadable.has(this.key(root,id))){unreadable.add(this.key(root,id));console.warn('[sme] 読み取れない書き出し記録を一覧と進行中の判定から除外しました:',id,error);}
        return [];
      }
    }).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  }
  page(projectDirectory:string,offset=0,limit=20) {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new HttpError(400,'履歴の取得範囲が不正です');
    const jobs=this.list(projectDirectory).reverse();return {jobs:jobs.slice(offset,offset+limit),total:jobs.length,nextOffset:offset+limit<jobs.length?offset+limit:null};
  }
  get(projectId:string,directory?:string):{phase:string}|undefined {
    const reserved=[...this.reservations.values()].find(item=>item.projectId===projectId&&(!directory||item.root===realpathSync(directory)));
    if(reserved)return {phase:reserved.started?'finalizing':'preparing'};
    const active=[...this.jobs.values()].find(job=>job.status.projectId===projectId&&exportActive(job.status.phase));
    if(active)return {...active.status};
    if(directory){
      if(activeExportAdmission(directory))return {phase:'queued'};
      return this.list(directory).find(job=>exportActive(job.phase));
    }
  }
  activeCount(){return new Set([...this.reservations.keys(),...[...this.jobs.entries()].filter(([,job])=>exportActive(job.status.phase)).map(([key])=>key)]).size;}
  killAll(){for(const reservation of this.reservations.values())reservation.controller.abort();for(const job of this.jobs.values())if(exportActive(job.status.phase))job.controller.abort();}
  async download(projectDirectory:string,id:string,signal?:AbortSignal) {
    const job=this.job(projectDirectory,id),record=await prepareLegacyExport(job.projectDirectory,job.record,signal);
    return verifiedExportOutput(job.projectDirectory,record,signal);
  }
  cancel(projectDirectory:string,id:string):NativeExportStatus {
    const root=realpathSync(projectDirectory),job=this.load(root,id);
    if(exportActive(job.status.phase)) {
      if(!this.jobs.has(this.key(root,id)))throw new HttpError(409,'別のサーバーで書き出しが進行中です。実行中のサーバーで中止してください');
      job.controller.abort();
    }
    return {...job.status};
  }
}
export const sequenceExports=new SequenceExports();
