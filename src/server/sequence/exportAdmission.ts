import { randomUUID } from 'node:crypto';
import { existsSync,linkSync,lstatSync,mkdirSync,readdirSync,unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HttpError } from '../http';
import { exportFolder,ownerAlive,processRegistry,readRegular,syncFile,syncFolder } from './exportRecords';

const schema=z.object({version:z.literal(1),epoch:z.number().int().positive().safe(),pid:z.number().int().positive().safe(),
  token:z.string().uuid(),jobId:z.string().regex(/^[a-f0-9]{32}$/)}).strict();
type Admission=z.infer<typeof schema>;
/** Tokens this process acquired and has not released. */
const held=processRegistry('exports.admissions');
const name=(epoch:number)=>`${String(epoch).padStart(16,'0')}.json`;
function folder(root:string,create=false){
  const directory=join(exportFolder(root,create),'.admissions');
  if(create)mkdirSync(directory,{recursive:true});
  if(existsSync(directory)){const info=lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('書き出しの開始記録の保存先が不正です');}
  return directory;
}
function latest(directory:string):Admission|undefined {
  if(!existsSync(directory))return;
  const files=readdirSync(directory).filter(file=>/^\d{16}\.json$/.test(file)).sort(),file=files.at(-1);if(!file)return;
  const record=schema.parse(JSON.parse(readRegular(join(directory,file),4096)));
  if(name(record.epoch)!==file)throw new Error('書き出しの開始記録が不正です');return record;
}
function live(directory:string,record:Admission){
  if(!ownerAlive(record.pid,()=>held.has(record.token)))return false;
  const done=join(directory,`${name(record.epoch)}.done`);
  if(existsSync(done)){
    if(readRegular(done,128)!==record.token)throw new Error('書き出しの終了記録が不正です');return false;
  }
  return true;
}
export function activeExportAdmission(root:string):Admission|undefined {
  const directory=folder(root),record=latest(directory);return record&&live(directory,record)?record:undefined;
}
function busy(record:Admission|undefined,jobId:string):never {
  // An identical request may be between admission and durable input publication.
  // It is unresolved (503), not a rejected new request (409).
  throw new HttpError(record?.jobId===jobId?503:409,'別の書き出しが進行中です。開始状況を再確認してください');
}
/**
 * Append-only epochs avoid deleting a stale lock that another process just replaced.
 * A synced, complete candidate is hard-linked exclusively to the next epoch name.
 * Contenders for the same epoch cannot both win; a dead owner permits the next epoch.
 * No deadline/mtime heuristic can evict a paused but live renderer.
 */
export function acquireExportAdmission(root:string,jobId:string):()=>void {
  const directory=folder(root,true),previous=latest(directory);
  if(previous&&live(directory,previous))busy(previous,jobId);
  const record=schema.parse({version:1,epoch:(previous?.epoch??0)+1,pid:process.pid,token:randomUUID(),jobId});
  const temporary=join(directory,`.pending-${process.pid}-${record.token}`),target=join(directory,name(record.epoch));
  let published=false;
  const release=()=>{
    const done=target+'.done';
    if(existsSync(done)){if(readRegular(done,128)!==record.token)throw new Error('書き出しの終了記録が不正です');held.delete(record.token);return;}
    const ready=`${done}.pending-${process.pid}-${randomUUID()}`;
    try {
      syncFile(ready,record.token,true);
      try{linkSync(ready,done);}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST'||readRegular(done,128)!==record.token)throw error;
      }
      syncFolder(directory);
    }finally{if(existsSync(ready))unlinkSync(ready);}
    held.delete(record.token);
  };
  try {
    syncFile(temporary,JSON.stringify(record),true);
    try{linkSync(temporary,target);published=true;held.add(record.token);}catch(error){
      if((error as NodeJS.ErrnoException).code==='EEXIST')busy(latest(directory),jobId);throw error;
    }
    syncFolder(directory);return release;
  }catch(error){if(published)release();throw error;}
  finally{if(existsSync(temporary))unlinkSync(temporary);}
}
