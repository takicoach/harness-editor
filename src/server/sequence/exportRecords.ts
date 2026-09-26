import { createHash,randomUUID } from 'node:crypto';
import { closeSync,existsSync,fsyncSync,linkSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { lstat,stat } from 'node:fs/promises';
import { basename,join } from 'node:path';
import { z } from 'zod';
import type { SequenceDocument } from '../../core/sequence/model';
import { parseSequence,serializeSequence } from '../../core/sequence/validate';
import { sequenceContentHash } from './store';
import { HttpError } from '../http';
import {isValidRenderOutputName,targetResolution} from '../../shared/renderPreset';

const id=z.string().min(1).max(128),integer=z.number().int().nonnegative().safe(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const exportSettingsSchema=z.object({resolution:z.enum(['full','1080p','720p']),quality:z.enum(['high','standard','light'])}).strict();
const outputResolutionSchema=z.object({width:integer.positive(),height:integer.positive()}).strict();
const oldRequestSchema=z.object({sessionId:id,expectedRevision:integer,executionId:id}).strict();
export const exportRequestSchema=oldRequestSchema.extend({settings:exportSettingsSchema.optional()});
export type ExportRequest=z.infer<typeof exportRequestSchema>;
/** An immutable legacy edit is not a saved native editing session. */
export const legacySnapshotRequestSchema=z.object({kind:z.literal('legacy-snapshot'),sourceFingerprint:hash,snapshotHash:hash,
  expectedRevision:integer,executionId:id,settings:exportSettingsSchema,outputName:z.string().refine(isValidRenderOutputName)}).strict();
export type LegacySnapshotExportRequest=z.infer<typeof legacySnapshotRequestSchema>;
const statusSchema=z.object({id,projectId:z.string().min(1).max(256),revision:integer,contentHash:hash,executionId:id.nullable(),
  phase:z.enum(['queued','preparing','audio','rendering','finalizing','complete','cancelled','failed']),completedFrames:integer,totalFrames:integer,
  createdAt:z.string().datetime(),finishedAt:z.string().datetime().optional(),audioProgress:z.number().min(0).max(1).optional(),error:z.string().optional(),downloadUrl:z.string().optional(),historical:z.boolean().optional(),settings:exportSettingsSchema.optional(),outputResolution:outputResolutionSchema.optional()}).strict();
const outputSchema=z.object({sha256:hash,bytes:integer,verificationHash:hash}).strict();
const recordSchema=z.discriminatedUnion('version',[
  z.object({version:z.literal(3),request:legacySnapshotRequestSchema,ownerPid:integer,status:statusSchema.extend({settings:exportSettingsSchema,outputResolution:outputResolutionSchema}),output:outputSchema.optional()}).strict(),
  z.object({version:z.literal(2),request:oldRequestSchema.extend({settings:exportSettingsSchema}),ownerPid:integer,status:statusSchema.extend({settings:exportSettingsSchema,outputResolution:outputResolutionSchema}),output:outputSchema.optional()}).strict(),
  z.object({version:z.literal(1),request:oldRequestSchema,ownerPid:integer,status:statusSchema,output:outputSchema.optional()}).strict(),
  z.object({version:z.literal(0),request:z.null(),ownerPid:z.literal(0),status:statusSchema,
    legacy:z.object({resultHash:hash.nullable(),inputHash:hash}).strict(),output:outputSchema.optional()}).strict(),
]);
export type ExportRecord=z.infer<typeof recordSchema>;
/** Version 2 and later froze the requested settings and output size when the export was admitted. */
export const hasFrozenSettings=(record:ExportRecord):record is Extract<ExportRecord,{version:2|3}>=>record.version===2||record.version===3;
export const exportJobId=(executionId:string)=>createHash('sha256').update(executionId).digest('hex').slice(0,32);
export const isLegacyExportId=(id:string)=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export const exportActive=(phase:string)=>!['complete','failed','cancelled'].includes(phase);
/** Files that exist only while a runner is alive. A stale owner's copies are removed on recovery. */
export const exportScratchFiles={audio:'audio.f32le',partial:'output.partial.mp4'} as const;
export const exportDownloadUrl=(projectId:string,jobId:string)=>`/api/sequence/export/download?${new URLSearchParams({id:projectId,job:jobId})}`;
export const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function exportFolder(root:string,create=false):string {
  for(const part of ['.harness','exports']) {
    root=join(root,part);if(create)mkdirSync(root,{recursive:true});
    if(!existsSync(root))continue;
    const info=lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('書き出し記録の保存先が不正です');
  }
  return root;
}
export function exportDirectory(root:string,id:string):string {
  if(!/^[a-f0-9]{32}$/.test(id)&&!isLegacyExportId(id))throw new HttpError(400,'書き出しのIDが不正です');
  const directory=join(exportFolder(root),id);
  if(!existsSync(directory))throw new HttpError(404,'書き出しジョブが見つかりません');
  const info=lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('書き出しの記録先が不正です');return directory;
}
export function syncFile(file:string,bytes:string,exclusive=false) {
  const fd=openSync(file,exclusive?'wx':'w',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
}
export function syncFolder(directory:string) {
  if(process.platform==='win32')return; // Same directory-fsync policy as SequenceStore.
  const fd=openSync(directory,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
export function persistExport(directory:string,record:ExportRecord,exclusive=false) {
  const parsed=recordSchema.parse(record),bytes=JSON.stringify(parsed),temporary=join(directory,`manifest.${randomUUID()}.tmp`);
  try{
    syncFile(temporary,JSON.stringify({record:parsed,hash:digest(bytes)}),true);
    if(exclusive){try{linkSync(temporary,join(directory,'manifest.json'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
    else renameSync(temporary,join(directory,'manifest.json'));
    syncFolder(directory);
  }
  finally{rmSync(temporary,{force:true});}
}
export function createExportRecord(root:string,record:ExportRecord,document:SequenceDocument):string {
  const parent=exportFolder(root,true),directory=join(parent,record.status.id),temporary=join(parent,`.pending-${randomUUID()}`);
  mkdirSync(temporary);
  try {
    syncFile(join(temporary,'input.json'),serializeSequence(document),true);persistExport(temporary,record);
    if(existsSync(directory))throw new HttpError(409,'同じ書き出しIDが既に存在します。記録を確認してください');
    renameSync(temporary,directory);syncFolder(parent);return directory;
  }finally{rmSync(temporary,{recursive:true,force:true});}
}
export function readRegular(file:string,maximum:number):string {
  const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>maximum)throw new Error('書き出し記録のファイルが不正です');
  return readFileSync(file,'utf8');
}
export function readExportRecord(root:string,id:string):ExportRecord {
  const directory=exportDirectory(root,id);
  if(isLegacyExportId(id)&&!existsSync(join(directory,'manifest.json')))return readLegacyExport(root,id);
  const envelope=JSON.parse(readRegular(join(directory,'manifest.json'),128*1024)),record=recordSchema.parse(envelope.record);
  if(envelope.hash!==digest(JSON.stringify(record))||record.status.id!==id||record.status.completedFrames>record.status.totalFrames
    ||record.status.phase==='complete'&&!record.output)throw new Error('書き出しの記録が変更されています');
  if(record.version!==0){
    if(exportJobId(record.request.executionId)!==id||record.status.executionId!==record.request.executionId||record.status.revision!==record.request.expectedRevision)
      throw new Error('書き出しの記録が変更されています');
    if(hasFrozenSettings(record)&&JSON.stringify(record.request.settings)!==JSON.stringify(record.status.settings))throw new Error('書き出し設定の記録が一致しません');
    if(record.version===3&&record.request.snapshotHash!==record.status.contentHash)throw new Error('旧案件の書き出し入力の記録が一致しません');
  }else {
    if(!isLegacyExportId(id)||!record.status.historical)throw new Error('以前の書き出し記録が不正です');
    const source=join(directory,'result.json');
    if((existsSync(source)?digest(readRegular(source,128*1024)):null)!==record.legacy.resultHash)throw new Error('以前の書き出し記録が変更されています');
  }
  return record;
}
/** Old releases did not save a session or MP4 digest. Never invent either as historic evidence. */
function readLegacyExport(root:string,id:string):ExportRecord {
  const directory=exportDirectory(root,id),input=readRegular(join(directory,'input.json'),64*1024*1024),document=parseSequence(input);
  const file=join(directory,'result.json'),bytes=existsSync(file)?readRegular(file,128*1024):null;
  const status:z.infer<typeof statusSchema>=bytes?statusSchema.parse(JSON.parse(bytes)):{id,projectId:basename(root),revision:document.revision,contentHash:sequenceContentHash(document),
    executionId:null,phase:'failed' as const,completedFrames:0,totalFrames:document.sequenceEndFrame,createdAt:lstatSync(join(directory,'input.json')).mtime.toISOString(),
    error:'以前の書き出しは完了記録がありません。元のファイルを残しています。内容を確認して、新しく書き出してください。'};
  if(status.id!==id||status.revision!==document.revision||status.contentHash!==sequenceContentHash(document)||status.totalFrames!==document.sequenceEndFrame
    ||status.completedFrames>status.totalFrames)throw new Error('以前の書き出しと入力が一致しません');
  if(exportActive(status.phase)){status.phase='failed';status.error='以前の書き出しは完了を確認できません。内容を確認して、新しく書き出してください。';}
  status.historical=true;delete status.downloadUrl;
  if(status.phase==='complete')status.downloadUrl=exportDownloadUrl(status.projectId,id);
  return {version:0,request:null,ownerPid:0,status,legacy:{resultHash:bytes===null?null:digest(bytes),inputHash:digest(input)}};
}
export function readExportInput(root:string,record:ExportRecord):SequenceDocument {
  const input=readRegular(join(exportDirectory(root,record.status.id),'input.json'),64*1024*1024),document=parseSequence(input);
  if(record.version===0&&digest(input)!==record.legacy.inputHash)throw new Error('以前の書き出し入力が変更されています');
  if(document.revision!==record.status.revision||sequenceContentHash(document)!==record.status.contentHash||document.sequenceEndFrame!==record.status.totalFrames)
    throw new Error('書き出し開始時の入力が変更されています');
  if(hasFrozenSettings(record)&&JSON.stringify(targetResolution(document.resolution.width,document.resolution.height,record.request.settings.resolution))!==JSON.stringify(record.status.outputResolution))throw new Error('書き出し寸法の記録が一致しません');
  if(record.version===3&&document.legacy?.sourceFingerprint!==record.request.sourceFingerprint)throw new Error('旧案件の書き出し元の記録が一致しません');
  return document;
}
export function exportIds(root:string):string[] {
  const directory=exportFolder(root);return existsSync(directory)?readdirSync(directory).filter(id=>/^[a-f0-9]{32}$/.test(id)||isLegacyExportId(id)):[];
}
/** Export owners run as this user, so EPERM means the number now belongs to another user's process. */
export function processAlive(pid:number):boolean {
  if(!pid)return false;try{process.kill(pid,0);return true;}catch(error){const code=(error as NodeJS.ErrnoException).code;return code!=='ESRCH'&&code!=='EPERM';}
}
/** A record naming this process is its own only while this process tracks the work: a restarted server can be given the crashed one's PID. */
export const ownerAlive=(pid:number,trackedHere:()=>boolean)=>pid===process.pid?trackedHere():processAlive(pid);
/** Work tracked for ownerAlive. Process-wide rather than module-wide: a bundled dev server and a
 * script importing the sources each load their own copy of these modules in one process. */
export function processRegistry(name:string):Set<string> {
  const scope=globalThis as unknown as Record<symbol,Set<string>|undefined>;
  return scope[Symbol.for(`harness-editor.${name}`)]??=new Set<string>();
}
export async function hashExportFile(file:string,signal?:AbortSignal) {
  const before=await lstat(file);if(!before.isFile()||before.isSymbolicLink())throw new Error('書き出した動画のファイルが不正です');
  const hash=createHash('sha256');for await(const chunk of createReadStream(file,{signal}))hash.update(chunk);
  const after=await lstat(file),signature=(info:typeof before)=>JSON.stringify([info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]);
  if(signature(before)!==signature(after)||after.isSymbolicLink())throw new Error('書き出した動画が確認中に変更されました');
  return {sha256:hash.digest('hex'),bytes:before.size,signature:signature(before)};
}
/** A runner's verification must describe the settings and output size frozen in its record. */
export function assertVerifiedSettings(verification:{settings?:unknown;outputResolution?:unknown},settings:unknown,outputResolution:unknown):void {
  if(JSON.stringify(verification.settings)!==JSON.stringify(settings)||JSON.stringify(verification.outputResolution)!==JSON.stringify(outputResolution))throw new Error('書き出しの検証結果と設定が一致しません');
}
const verified=new Map<string,string>();
export async function verifiedExportOutput(root:string,record:ExportRecord,signal?:AbortSignal):Promise<string> {
  if(record.status.phase!=='complete'||!record.output)throw new HttpError(409,'動画の書き出しはまだ完了していません');
  readExportInput(root,record);
  const directory=exportDirectory(root,record.status.id),file=join(directory,'output.mp4');
  const verificationBytes=readRegular(join(directory,'verification.json'),2*1024*1024);
  if(digest(verificationBytes)!==record.output.verificationHash)throw new Error('書き出しの検証結果が変更されています');
  if(hasFrozenSettings(record))assertVerifiedSettings(JSON.parse(verificationBytes),record.request.settings,record.status.outputResolution);
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('書き出した動画のファイルが不正です');
  const signature=JSON.stringify([record.output.sha256,info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs]);
  if(verified.get(file)!==signature) {
    const actual=await hashExportFile(file,signal);
    if(actual.sha256!==record.output.sha256||actual.bytes!==record.output.bytes)throw new Error('完成した動画ファイルが変更されています');
    const after=await stat(file);if(JSON.stringify([after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs])!==actual.signature)throw new Error('完成した動画ファイルが変更されています');
    verified.set(file,signature);while(verified.size>16)verified.delete(verified.keys().next().value!);
  }
  return file;
}
