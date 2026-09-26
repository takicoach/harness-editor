import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {constants,type Stats} from 'node:fs';
import {link,lstat,mkdir,open,readdir,readlink,realpath,rename,stat,symlink,unlink,type FileHandle} from 'node:fs/promises';
import {basename,extname,isAbsolute,join} from 'node:path';
import {z} from 'zod';
import type {SequenceAsset} from '../../core/sequence/model';
import {validateSequenceDocument} from '../../core/sequence/validate';
import {probeSequenceAssetSource} from './media';
import type {RegisteredSequenceAsset} from './assets';
import {HttpError} from '../http';

const filePattern=/^\.harness\/references\/([a-f0-9]{64})\.(mp4|mov|m4v|mkv|webm|avi|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif|avif|bmp)$/;
const recordSchema=z.object({format:z.literal('harness-reference'),version:z.literal(1),asset:z.unknown(),target:z.string().min(1),
 generation:z.string().uuid(),sizeBytes:z.number().int().nonnegative().safe()}).strict();
type ReferenceRecord=Omit<z.infer<typeof recordSchema>,'asset'>&{asset:SequenceAsset};
export interface SequenceReferenceLease {path:string;handle:FileHandle;verify():Promise<void>;close():Promise<void>}
export interface SequenceReferenceStatus {state:'ok'|'missing'|'mismatch'|'invalid';message?:string}
const identity=(s:Stats)=>JSON.stringify([s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs]);
type Inode=Pick<Stats,'dev'|'ino'>;
const sameInode=(a:Inode,b:Inode)=>a.dev===b.dev&&a.ino===b.ino;
const absent=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
const error=(message:string)=>new Error(message);
export function isSequenceReferenceFile(file:string):boolean{return filePattern.test(file);}
export function expectedReferenceFingerprint(value:unknown):string|undefined {
 if(value===undefined)return undefined;
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new HttpError(400,'素材の指紋は全体SHA-256で指定してください');
 return value;
}

async function directory(project:string,create=false):Promise<string>{
 let dir=await realpath(project);
 for(const part of ['.harness','references']){
  dir=join(dir,part);
  if(create)await mkdir(dir,{recursive:false}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const info=await lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())throw error('参照台帳のディレクトリが不正です');
 }
 return dir;
}
async function unlocked(dir:string){await recoverMutation(dir);}
function assetIdentity(a:SequenceAsset){return [a.id,a.file,a.kind,a.fingerprint,a.streams];}
function validateAsset(a:SequenceAsset){
 if(!a||!['media','image'].includes(a.kind)||!isSequenceReferenceFile(a.file)||filePattern.exec(a.file)?.[1]!==a.fingerprint)
  throw error('参照素材の登録情報が不正です');
 validateSequenceDocument({schemaVersion:2,id:'reference',name:'参照',revision:0,fps:{num:1,den:1},resolution:{width:1,height:1},
  sequenceEndFrame:0,background:'#000',assets:[a],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}});
}
async function readRecord(dir:string,file:string,recordPath=join(dir,basename(file)+'.json')):Promise<{record:ReferenceRecord;bytes:string;info:Stats}>{
 if(!isSequenceReferenceFile(file))throw error('参照素材の保存先が不正です');
 const handle=await open(recordPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await handle.stat();if(!info.isFile()||info.size>128*1024)throw error('参照台帳が通常のファイルではありません');
  const bytes=await handle.readFile('utf8'),parsed=recordSchema.parse(JSON.parse(bytes)),asset=parsed.asset as SequenceAsset;
  validateAsset(asset);if(asset.file!==file||!isAbsolute(parsed.target))throw error('参照台帳の接続先が不正です');
  if(identity(info)!==identity(await handle.stat()))throw error('読み取り中に参照台帳が変更されました');
  return {record:{...parsed,asset},bytes,info};
 }finally{await handle.close();}
}
async function hashHandle(handle:FileHandle,signal?:AbortSignal){
 const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;
 while(true){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
 return hash.digest('hex');
}
// A cached digest is valid only for the exact file/stat identity, never for its name alone.
const verified=new Map<string,string>();
async function verifyHash(path:string,handle:FileHandle,expected:string,signal?:AbortSignal){
 const before=await handle.stat();if(!before.isFile())throw error('参照先が通常のファイルではありません');
 const key=JSON.stringify([expected,identity(before)]);
 if(verified.get(path)!==key){
  if(await hashHandle(handle,signal)!==expected)throw error('参照素材の内容が保存時と一致しません');
  if(identity(before)!==identity(await handle.stat()))throw error('読み取り中に参照素材が変更されました');
  verified.set(path,key);while(verified.size>128)verified.delete(verified.keys().next().value!);
 }
 return before;
}

/** No absolute source path is exposed in the document or status. The caller owns browse authorization. */
export async function openSequenceReference(project:string,asset:SequenceAsset,signal?:AbortSignal):Promise<SequenceReferenceLease>{
 signal?.throwIfAborted();validateAsset(asset);const dir=await directory(project);await unlocked(dir);
 const initial=await readRecord(dir,asset.file);if(!isDeepStrictEqual(assetIdentity(initial.record.asset),assetIdentity(asset)))throw error('参照素材の文書と台帳が一致しません');
 const leaf=join(dir,basename(asset.file)),link=await lstat(leaf);
 if(!link.isSymbolicLink()||await readlink(leaf)!==initial.record.target)throw error('参照素材のリンクが登録時と一致しません');
 const path=await realpath(leaf);if(path!==initial.record.target)throw error('参照素材の接続先が変更されています');
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let closed=false;
 try{
  const before=await verifyHash(path,handle,asset.fingerprint,signal);
  if(before.size!==initial.record.sizeBytes)throw error('参照素材の大きさが一致しません');
  const verify=async()=>{
   signal?.throwIfAborted();if(closed)throw error('参照素材の読み取りは終了しています');
   if(await directory(project)!==dir)throw error('参照台帳の場所が変更されました');await unlocked(dir);
   const current=await readRecord(dir,asset.file),nowLink=await lstat(leaf);
   if(current.bytes!==initial.bytes||!sameInode(current.info,initial.info)||!nowLink.isSymbolicLink()||!sameInode(nowLink,link)
    ||await readlink(leaf)!==path||await realpath(leaf)!==path||identity(await stat(path))!==identity(before)||identity(await handle.stat())!==identity(before))
    throw error('読み取り中に参照素材または接続が変更されました');
  };
  await verify();return {path,handle,verify,close:async()=>{if(!closed){closed=true;await handle.close();}}};
 }catch(e){await handle.close();throw e;}
}

export async function registeredSequenceReferences(project:string):Promise<SequenceAsset[]>{
 let dir:string;try{dir=await directory(project);}catch(e){if(absent(e))return [];throw e;}await unlocked(dir);
 const assets:SequenceAsset[]=[];
 for(const name of (await readdir(dir)).sort())if(isSequenceReferenceFile(`.harness/references/${name.replace(/\.json$/,'')}`)&&name.endsWith('.json')){
  assets.push((await readRecord(dir,`.harness/references/${name.slice(0,-5)}`)).record.asset);
 }
 return assets;
}
export async function sequenceReferenceStatus(project:string,asset:SequenceAsset,signal?:AbortSignal):Promise<SequenceReferenceStatus>{
 try{const lease=await openSequenceReference(project,asset,signal);await lease.close();return {state:'ok'};}
 catch(e){signal?.throwIfAborted();const message=(e as NodeJS.ErrnoException).code?'参照素材を読み取れません。接続と登録情報を確認してください':e instanceof Error?e.message:'参照素材を確認できません';
  return {state:absent(e)?'missing':/未完了|完了後に再試行/.test(message)?'invalid':/一致|変更/.test(message)?'mismatch':'invalid',message:absent(e)?'参照先が見つかりません。ドライブの接続を確認してください':message};}
}

async function removeOwned(path:string,expected:Inode){
 try{const now=await lstat(path);if(sameInode(now,expected))await unlink(path);}catch(e){if(!absent(e))throw e;}
}
const inodeSchema=z.object({dev:z.number().int().nonnegative(),ino:z.number().int().nonnegative()}).strict();
const transactionSchema=z.object({file:z.string().refine(isSequenceReferenceFile),backup:z.string().regex(/^\.previous-[a-f0-9-]{36}$/).optional(),
 before:z.object({record:inodeSchema,link:inodeSchema.optional()}).strict().optional(),
 owned:z.object({record:inodeSchema.optional(),link:inodeSchema.optional()}).strict(),committed:z.boolean().optional()}).strict();
const lockSchema=z.object({format:z.literal('harness-reference-mutation'),version:z.literal(1),pid:z.number().int().positive(),startedAt:z.number().nonnegative(),token:z.string().uuid(),retired:z.boolean().optional(),transaction:transactionSchema.optional()}).strict();
type Journal=z.infer<typeof lockSchema>;type Transaction=z.infer<typeof transactionSchema>;
const inode=(info:Inode):Inode=>({dev:info.dev,ino:info.ino});
const newJournal=():Journal=>({format:'harness-reference-mutation',version:1,pid:process.pid,startedAt:Date.now()-process.uptime()*1000,token:randomUUID()});
const recoveryMessage=(reason:string)=>error(`参照素材の接続変更が未完了です（.harness/references/.mutation-lock）。${reason}。素材と退避記録は削除していません。エディターを終了して再起動してください。再起動後も続く場合は、この案件の参照記録の修復が必要です`);
async function optionalStat(path:string){return lstat(path).catch(e=>{if(absent(e))return null;throw e;});}
async function readJournal(path:string){
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const info=await handle.stat();if(!info.isFile()||info.size>32*1024)throw recoveryMessage('所有者を確認できません');
  const value=lockSchema.parse(JSON.parse(await handle.readFile('utf8')));if(identity(info)!==identity(await handle.stat()))throw recoveryMessage('所有者記録が更新中です');return {value,info};
 }catch(e){if(e instanceof Error&&e.message.includes('未完了'))throw e;throw recoveryMessage('所有者のない旧形式または破損した記録です');}finally{await handle.close();}
}
function deadOwner(pid:number){try{process.kill(pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}}
// Publish a fully written owner record atomically; an empty marker can never be a new lock.
async function publishJournal(path:string,value:Journal,replace?:Inode){
 const temporary=path+'.owner-'+randomUUID(),handle=await open(temporary,'wx',0o600),owned=await handle.stat();
 try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();
  if(replace){const current=await optionalStat(path);if(!current||!sameInode(current,replace))throw recoveryMessage('所有者記録が置き換わっています');await rename(temporary,path);}
  else await link(temporary,path);
  return owned;
 }finally{await handle.close();await removeOwned(temporary,owned);}
}
async function recoverTransaction(dir:string,t:Transaction){
 const leaf=join(dir,basename(t.file)),metadata=leaf+'.json',backup=t.backup?join(dir,t.backup):undefined;
 // Inspect all leaves before any removal. Unknown objects are never adopted or overwritten.
 const currentLink=await optionalStat(leaf),currentRecord=await optionalStat(metadata),oldLink=backup?await optionalStat(backup):null,oldRecord=backup?await optionalStat(backup+'.json'):null;
 const known=(actual:Stats|null,...owners:(Inode|undefined)[])=>!actual||owners.some(owner=>owner&&sameInode(actual,owner));
 if(!known(currentLink,t.owned.link,t.before?.link)||!known(currentRecord,t.owned.record,t.before?.record)
  ||!known(oldLink,t.before?.link)||!known(oldRecord,t.before?.record))throw recoveryMessage('所有不明のファイルがあり自動修復を中止しました');
 if(t.before){
  const savedPath=oldRecord&&backup?backup+'.json':metadata;
  if(oldRecord||currentRecord&&sameInode(currentRecord,t.before.record)){
   const saved=await readRecord(dir,t.file,savedPath);if(!sameInode(saved.info,t.before.record))throw recoveryMessage('復旧用の台帳が置き換わっています');
   if(t.before.link){const savedLink=oldLink&&backup?backup:currentLink&&sameInode(currentLink,t.before.link)?leaf:undefined;
    if(savedLink&&await readlink(savedLink)!==saved.record.target)throw recoveryMessage('復旧用リンクと台帳が一致しません');}
  }
 }
 if(t.committed){
  if(!currentLink||!currentRecord||!t.owned.link||!t.owned.record||!sameInode(currentLink,t.owned.link)||!sameInode(currentRecord,t.owned.record))throw recoveryMessage('公開済みの参照対が不足しています');
  const record=await readRecord(dir,t.file);if(!currentLink.isSymbolicLink()||await readlink(leaf)!==record.record.target)throw recoveryMessage('公開済みの参照対が一致しません');
  if(backup&&oldLink&&t.before?.link)await removeOwned(backup,t.before.link);if(backup&&oldRecord&&t.before)await removeOwned(backup+'.json',t.before.record);return;
 }
 if(t.before){
  // A missing backup is safe only if the corresponding original is still in place.
  if(!oldRecord&&(!currentRecord||!sameInode(currentRecord,t.before.record)))throw recoveryMessage('復旧用の台帳が不足しています');
  if(t.before.link&&!oldLink&&(!currentLink||!sameInode(currentLink,t.before.link)))throw recoveryMessage('復旧用のリンクが不足しています');
 }
 if(currentRecord&&t.owned.record&&sameInode(currentRecord,t.owned.record))await removeOwned(metadata,t.owned.record);
 if(currentLink&&t.owned.link&&sameInode(currentLink,t.owned.link))await removeOwned(leaf,t.owned.link);
 if(backup&&oldLink&&t.before?.link){
  // Create into an empty path without overwriting; retain backups on conflicts.
  if(await optionalStat(leaf))throw recoveryMessage('復旧先のリンクが使用されています');await symlink(await readlink(backup),leaf);await removeOwned(backup,t.before.link);
 }
 if(backup&&oldRecord&&t.before){await link(backup+'.json',metadata);await removeOwned(backup+'.json',t.before.record);}
}
const recoveries=new Map<string,Promise<void>>();
async function recoverMutation(dir:string):Promise<void>{
 const pending=recoveries.get(dir);if(pending)return pending;
 const recovery=(async()=>{
  const path=join(dir,'.mutation-lock');if(!await optionalStat(path))return;
  const initial=await readJournal(path);
  if(!deadOwner(initial.value.pid)&&!initial.value.retired){
   if(initial.value.pid===process.pid)throw error('参照素材の接続を変更しています。完了後に再試行してください');
   throw error(`参照素材の接続変更が未完了です（.harness/references/.mutation-lock、PID ${initial.value.pid}、記録開始時刻 ${new Date(initial.value.startedAt).toUTCString()} / startedAt=${initial.value.startedAt}）。別のエディターが処理中なら完了までお待ちください。処理していない場合はエディターを終了して再起動してください。再起動後も続く場合は、この表示を添えて案件の参照記録の修復を依頼してください。所有者を確認できないため、記録や素材は削除していません`);
  }
  // A separate atomically published live owner prevents two editor processes recovering together.
  const guard=join(dir,'.mutation-recovery');const stale=await optionalStat(guard);
  if(stale){const holder=await readJournal(guard);if(!deadOwner(holder.value.pid))throw recoveryMessage('別のエディターが自動修復中です');await removeOwned(guard,holder.info);}
  let owner:Stats;try{owner=await publishJournal(guard,newJournal());}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw recoveryMessage('別のエディターが自動修復中です');throw e;}
  try{const current=await readJournal(path);if(!sameInode(initial.info,current.info)||(!deadOwner(current.value.pid)&&!current.value.retired))throw recoveryMessage('所有者が変わりました');
   if(current.value.transaction){try{await recoverTransaction(dir,current.value.transaction);}catch(e){if(e instanceof Error&&e.message.includes('未完了'))throw e;throw recoveryMessage('退避記録の整合性を確認できません');}}
   else if((await readdir(dir)).some(name=>name.startsWith('.previous-')))throw recoveryMessage('出典が未記録の退避ファイルがあります');
   await removeOwned(path,current.info);
  }finally{await removeOwned(guard,owner);}
 })();recoveries.set(dir,recovery);try{await recovery;}finally{if(recoveries.get(dir)===recovery)recoveries.delete(dir);}
}
async function mutation<T>(project:string,body:(dir:string,journal:(transaction:Transaction)=>Promise<void>)=>Promise<T>):Promise<T>{
 const dir=await directory(project,true),path=join(dir,'.mutation-lock');await recoverMutation(dir);
 const value=newJournal();let info:Stats;
 try{info=await publishJournal(path,value);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw error('参照素材の接続変更が未完了です。完了後に再試行してください');throw e;}
 const journal=async(transaction:Transaction)=>{value.transaction=transaction;info=await publishJournal(path,value,info);};
 let incomplete=false;
 try{return await body(dir,journal);}catch(e){incomplete=!!(e as {incomplete?:boolean}).incomplete;throw e;}finally{if(!incomplete)await removeOwned(path,info);else{value.retired=true;await publishJournal(path,value,info);}}
}
async function inspectSource(source:string,file:string,name:string,signal?:AbortSignal){
 signal?.throwIfAborted();const path=await realpath(source),handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat();if(!before.isFile())throw error('参照先が通常のファイルではありません');
  const probed=await probeSequenceAssetSource(path,file,name,signal),asset=probed.asset;
  if(await hashHandle(handle,signal)!==asset.fingerprint||identity(before)!==identity(await handle.stat())||identity(before)!==identity(await stat(path)))
   throw error('確認中に参照先が変更されました');
  return {asset,path,sizeBytes:before.size,image:probed.image};
 }finally{await handle.close();}
}
async function writeRecord(path:string,record:ReferenceRecord){
 const handle=await open(path,'wx',0o600),owned=await handle.stat();
 try{await handle.writeFile(JSON.stringify(record)+'\n');await handle.sync();return await handle.stat();}
 catch(e){await removeOwned(path,owned);throw e;}finally{await handle.close();}
}

/** Publishes only new owned leaves. Existing regular files or incomplete registrations are never replaced. */
export async function registerSequenceReference(project:string,source:string,name=basename(source),signal?:AbortSignal,expectedFingerprint?:string):Promise<SequenceAsset>{
 return (await registerSequenceReferenceDetailed(project,source,name,signal,expectedFingerprint)).asset;
}
export async function registerSequenceReferenceDetailed(project:string,source:string,name=basename(source),signal?:AbortSignal,expectedFingerprint?:string):Promise<RegisteredSequenceAsset>{
 const expected=expectedReferenceFingerprint(expectedFingerprint);
 const extension=(extname(name)||extname(source)).toLowerCase();if(!isSequenceReferenceFile(`.harness/references/${'0'.repeat(64)}${extension}`))throw error('参照できない素材形式です');
 const inspected=await inspectSource(source,`.harness/references/${'0'.repeat(64)}${extension}`,name,signal);
 const verifyExpected=()=>{if(expected!==undefined&&inspected.asset.fingerprint!==expected)throw error('選択した素材の指紋と現在の参照先が一致しません');};
 verifyExpected();
 const asset={...inspected.asset,file:`.harness/references/${inspected.asset.fingerprint}${extension}`};validateAsset(asset);
 let published:{leaf:string;metadata:string;link:Stats;record:Stats}|undefined;
 const result=await mutation(project,async(dir,journal)=>{
  const leaf=join(dir,basename(asset.file)),metadata=leaf+'.json';
  const existing=await lstat(metadata).catch(e=>{if(absent(e))return null;throw e;});
  if(existing){const old=await readRecord(dir,asset.file);if(old.record.asset.fingerprint!==asset.fingerprint||old.record.asset.kind!==asset.kind||old.record.sizeBytes!==inspected.sizeBytes)throw error('既存の参照素材と一致しません');
   const info=await lstat(leaf);if(!info.isSymbolicLink()||await readlink(leaf)!==old.record.target)throw error('既存の参照リンクが不正です');
   // Keep the original target; choosing another path is an explicit reconnect operation.
   return old.record.asset;
  }
  signal?.throwIfAborted();let ownedLink:Stats|undefined,ownedRecord:Stats|undefined;
  const transaction:Transaction={file:asset.file,owned:{}};await journal(transaction);
  try{
   verifyExpected();await symlink(inspected.path,leaf);ownedLink=await lstat(leaf);transaction.owned.link=inode(ownedLink);await journal(transaction);
   ownedRecord=await writeRecord(metadata,{format:'harness-reference',version:1,asset,target:inspected.path,generation:randomUUID(),sizeBytes:inspected.sizeBytes});
   transaction.owned.record=inode(ownedRecord);transaction.committed=true;await journal(transaction);
   published={leaf,metadata,link:ownedLink,record:ownedRecord};
   signal?.throwIfAborted();return asset;
  }catch(e){try{if(ownedRecord)await removeOwned(metadata,ownedRecord);if(ownedLink)await removeOwned(leaf,ownedLink);}catch(cleanup){throw Object.assign(cleanup as Error,{incomplete:true});}throw e;}
 });
 try{const lease=await openSequenceReference(project,result,signal);await lease.close();return {asset:result,...(inspected.image?{image:inspected.image}:{})};}
 catch(e){
  // A failed final verification must not leave this request's newly published registration.
  // The mutation lock and inode checks preserve pre-existing or subsequently replaced leaves.
  if(published){const owned=published;await mutation(project,async(_dir,journal)=>{await journal({file:asset.file,owned:{record:inode(owned.record),link:inode(owned.link)}});try{await removeOwned(owned.metadata,owned.record);await removeOwned(owned.leaf,owned.link);}catch(error){throw Object.assign(error as Error,{incomplete:true});}});}
  throw e;
 }
}

/** Same bytes, size and kind; saved exact streams remain authoritative. Backups are private leaves, never recursive deletion. */
export async function reconnectSequenceReference(project:string,asset:SequenceAsset,source:string,signal?:AbortSignal):Promise<SequenceAsset>{
 validateAsset(asset);const inspected=await inspectSource(source,asset.file,asset.name,signal);
 if(inspected.asset.fingerprint!==asset.fingerprint||inspected.asset.kind!==asset.kind)throw error('再接続する素材が保存時と一致しません');
 const result=await mutation(project,async(dir,journal)=>{
  const leaf=join(dir,basename(asset.file)),metadata=leaf+'.json',old=await readRecord(dir,asset.file);
  if(!isDeepStrictEqual(assetIdentity(old.record.asset),assetIdentity(asset)))throw error('参照素材の文書と台帳が一致しません');
  if(old.record.sizeBytes!==inspected.sizeBytes)throw error('再接続する素材の大きさが保存時と一致しません');
  const oldLink=await lstat(leaf).catch(e=>{if(absent(e))return null;throw e;});
  if(oldLink&&(!oldLink.isSymbolicLink()||await readlink(leaf)!==old.record.target))throw error('既存の参照リンクが不正です');
  const token=randomUUID(),backup=join(dir,`.previous-${token}`),backupRecord=backup+'.json';
  let movedLink=false,movedRecord=false,newLink:Stats|undefined,newRecord:Stats|undefined;
  const transaction:Transaction={file:asset.file,backup:basename(backup),before:{record:inode(old.info),...(oldLink?{link:inode(oldLink)}:{})},owned:{}};await journal(transaction);
  try{
   signal?.throwIfAborted();if(oldLink){await rename(leaf,backup);movedLink=true;}
   await rename(metadata,backupRecord);movedRecord=true;
   await symlink(inspected.path,leaf);newLink=await lstat(leaf);transaction.owned.link=inode(newLink);await journal(transaction);
   newRecord=await writeRecord(metadata,{...old.record,target:inspected.path,generation:randomUUID(),sizeBytes:inspected.sizeBytes});
   transaction.owned.record=inode(newRecord);transaction.committed=true;await journal(transaction);
   signal?.throwIfAborted();
  }catch(e){
   try{if(newRecord)await removeOwned(metadata,newRecord);if(newLink)await removeOwned(leaf,newLink);}catch(cleanup){throw Object.assign(cleanup as Error,{incomplete:true});}
   // Do not overwrite an unexpected object added during failure recovery.
   try{
    if(movedLink&&oldLink){await symlink(await readlink(backup),leaf);await removeOwned(backup,oldLink);}
    if(movedRecord){await link(backupRecord,metadata);await removeOwned(backupRecord,old.info);}
   }catch{throw Object.assign(error('参照の再接続が未完了です。既存の記録と退避ファイルを保持しました'),{incomplete:true});}
   throw e;
  }
  try{if(movedLink&&oldLink)await removeOwned(backup,oldLink);if(movedRecord)await removeOwned(backupRecord,old.info);}catch(error){throw Object.assign(error as Error,{incomplete:true});}
  return old.record.asset;
 });
 const lease=await openSequenceReference(project,result,signal);await lease.close();return result;
}
