import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readdirSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {isValidRenderOutputName} from '../shared/renderPreset';
import {digest,exportFolder,exportJobId,exportSettingsSchema,readRegular,syncFile,syncFolder} from './sequence/exportRecords';

const integer=z.number().int().nonnegative().safe(),hash=z.string().regex(/^[a-f0-9]{64}$/);
const options=exportSettingsSchema.extend({outputName:z.string().refine(isValidRenderOutputName),
  ducking:z.object({enabled:z.boolean(),strength:z.enum(['weak','mid','strong'])}).strict().optional()}).strict();
const schema=z.object({version:z.literal(1),id:z.string().regex(/^[a-f0-9]{32}$/),executionId:z.string().min(1).max(128),ownerPid:integer,
  options,job:z.object({projectId:z.string().min(1).max(256),outputFile:z.string().refine(isValidRenderOutputName),startedAt:integer,
    phase:z.enum(['preparing','rendering','finalizing','done','failed','cancelled']),
    progress:z.object({frames:integer,total:integer,percent:z.number().min(0).max(100)}).strict().optional(),
    error:z.object({code:z.string(),message:z.string()}).strict().optional(),warning:z.string().optional()}).strict(),
  publication:z.object({sha256:hash,bytes:integer,device:z.string().regex(/^\d+$/),inode:z.string().regex(/^\d+$/)}).strict().optional(),
}).strict();
export type LegacyNativeRenderRecord=z.infer<typeof schema>;
export const legacyRenderActive=(phase:string)=>!['done','failed','cancelled'].includes(phase);
export function legacyRenderRecordFolder(root:string,create=false):string {
  const directory=join(exportFolder(root,create),'.legacy-renders');
  if(create)mkdirSync(directory,{recursive:true});
  if(existsSync(directory)){const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('書き出し履歴の保存先が不正です');}
  return directory;
}
export function validateLegacyRenderRecord(value:unknown):LegacyNativeRenderRecord {
  const record=schema.parse(value);
  if(exportJobId(record.executionId)!==record.id||record.job.outputFile!==record.options.outputName||
    record.job.progress&&record.job.progress.frames>record.job.progress.total||record.job.phase==='done'&&!record.publication)
    throw new Error('書き出し履歴の内容が一致しません');
  return record;
}
export function persistLegacyRenderRecord(root:string,value:LegacyNativeRenderRecord):void {
  const record=validateLegacyRenderRecord(value),directory=legacyRenderRecordFolder(root,true),temporary=join(directory,`.pending-${randomUUID()}`);
  try{syncFile(temporary,JSON.stringify({record,hash:digest(JSON.stringify(record))}),true);renameSync(temporary,join(directory,`${record.id}.json`));syncFolder(directory);}
  finally{if(existsSync(temporary))unlinkSync(temporary);}
}
export function readLegacyRenderRecords(root:string,tolerateInvalid=false):LegacyNativeRenderRecord[] {
  const directory=legacyRenderRecordFolder(root);if(!existsSync(directory))return [];
  const records:LegacyNativeRenderRecord[]=[];let invalid:unknown;
  for(const name of readdirSync(directory).filter(name=>/^[a-f0-9]{32}\.json$/.test(name))){
    try{const envelope=JSON.parse(readRegular(join(directory,name),128*1024)),record=validateLegacyRenderRecord(envelope.record);
      if(envelope.hash!==digest(JSON.stringify(record))||name!==`${record.id}.json`)throw new Error('書き出し履歴が変更されています');records.push(record);
    }catch(error){if(!tolerateInvalid)throw error;invalid=error;console.warn('[sme] 破損した書き出し履歴を表示対象から除外しました:',name);}
  }
  // Preserve the diagnostic when no valid history exists. A fresh run needs no history read.
  if(!records.length&&invalid)throw invalid;
  return records.sort((a,b)=>b.job.startedAt-a.job.startedAt||b.id.localeCompare(a.id));
}
const latestRecords=new Map<string,{signature:string;record:LegacyNativeRenderRecord|undefined}>();
/** Cache the latest-record index; atomic journal publication invalidates the directory stamp. */
export function readLatestLegacyRenderRecord(root:string,projectId:string):LegacyNativeRenderRecord|undefined {
  const directory=legacyRenderRecordFolder(root),key=JSON.stringify([root,projectId]),cached=latestRecords.get(key);
  const stamp=(file:string)=>{try{const stat=lstatSync(file,{bigint:true});if(stat.isSymbolicLink())throw new Error('書き出し履歴の保存先が不正です');return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].map(String);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  if(!existsSync(directory)){latestRecords.delete(key);return;}
  const directoryStamp=stamp(directory),signature=JSON.stringify([directoryStamp,cached?.record?stamp(join(directory,`${cached.record.id}.json`)):null]);
  if(cached?.signature===signature)return structuredClone(cached.record);
  const record=readLegacyRenderRecords(root,true).find(item=>item.job.projectId===projectId);
  latestRecords.set(key,{signature:JSON.stringify([directoryStamp,record?stamp(join(directory,`${record.id}.json`)):null]),record});
  while(latestRecords.size>16)latestRecords.delete(latestRecords.keys().next().value!);
  return structuredClone(record);
}
