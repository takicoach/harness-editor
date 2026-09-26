import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import type {SequenceDocument} from '../../core/sequence/model';
import {SequenceError} from '../../core/sequence/errors';
import {SequenceStore, sequenceContentHash, type SavedSequence} from './store';

const hash = (value:string) => createHash('sha256').update(value).digest('hex');
const identity = z.object({savedRevision:z.number().int().nonnegative(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const externalEditMetadata = z.object({operationId:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  kind:z.enum(['ai','external']),source:z.string().min(1).max(120),summary:z.string().min(1).max(2000)}).strict();
const recordSchema = externalEditMetadata.extend({at:z.string(),before:identity,after:identity,
  status:z.enum(['pending','saved','conflict','failed']),requestHash:z.string(),error:z.string().optional()}).strict();
export type ExternalEditRecord = z.infer<typeof recordSchema>;

function folder(project:string):string {
  // Reuse the store's project/.harness validation before touching a journal.
  new SequenceStore(project);
  const path=join(project,'.harness','external-edits');
  mkdirSync(path,{recursive:true});
  if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw new Error('外部編集履歴の保存先が不正です');
  return path;
}
function read(path:string):unknown {
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024)throw new Error('外部編集履歴のファイルが不正です');
  return JSON.parse(readFileSync(path,'utf8'));
}
function write(path:string,value:unknown):void {
  const temporary=path+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,path);
}
function stamp(saved:SavedSequence){return {savedRevision:saved.savedRevision,contentHash:saved.contentHash};}
function same(a:z.infer<typeof identity>,b:z.infer<typeof identity>){return a.savedRevision===b.savedRevision&&a.contentHash===b.contentHash;}
function recordPath(directory:string,operationId:string){return join(directory,hash(operationId)+'.json');}

/** Observe committed disk changes, including changes made while the app was closed.
 * Own saves advance the baseline explicitly and do not become inferred AI work. */
export function observeExternalEdits(project:string,saved:SavedSequence,own=false):void {
  const directory=folder(project),path=join(directory,'baseline.json'),after=stamp(saved);
  const before=existsSync(path)?identity.parse(read(path)):null;
  if(before&&!same(before,after)&&!own){
    const known=listExternalEdits(project).some(record=>record.status==='saved'&&same(record.after,after));
    if(!known){
      const operationId='observed:'+hash(JSON.stringify([before,after]));
      const target=recordPath(directory,operationId);
      if(!existsSync(target))write(target,{operationId,kind:'external',source:'外部（実行元不明）',summary:'保存済みの編集データが外部で変更されました',
        at:new Date().toISOString(),before,after,status:'saved',requestHash:''} satisfies ExternalEditRecord);
    }
  }
  if(!before||!same(before,after))write(path,after);
}

/** Optional atomic sidecar for AI work performed while the server is stopped.
 * Attribution is explicit; committed state is checked against the document/receipt. */
function importManifest(project:string,directory:string,store:SequenceStore):void {
  const path=join(project,'.harness','external-edit.json');if(!existsSync(path))return;
  const manifest=externalEditMetadata.extend({before:identity,after:identity,at:z.string().datetime().optional()}).strict().parse(read(path));
  const target=recordPath(directory,manifest.operationId);
  const existing=existsSync(target)?recordSchema.parse(read(target)):null;
  const requestHash=hash(JSON.stringify({...manifest,at:undefined}));
  if(existing){
    if(existing.requestHash!==requestHash)throw new Error('外部編集の来歴で操作IDが重複しています');
    if(existing.status==='saved')return;
  }
  const saved=store.load();
  const committed=!!saved&&same(stamp(saved),manifest.after)||store.hasReceipt(manifest.operationId,manifest.after.savedRevision,manifest.after.contentHash);
  const record:ExternalEditRecord={...manifest,at:manifest.at??existing?.at??new Date().toISOString(),requestHash,
    status:committed?'saved':saved&&same(stamp(saved),manifest.before)?'pending':'conflict'};
  write(target,record);
}

export function listExternalEdits(project:string):ExternalEditRecord[] {
  const directory=folder(project),store=new SequenceStore(project);
  importManifest(project,directory,store);
  return readdirSync(directory).filter(file=>/^[a-f0-9]{64}\.json$/.test(file)).map(file=>{
    const path=join(directory,file),record=recordSchema.parse(read(path));
    // Recover a crash/lost response between the atomic document commit and journal update.
    if(record.status==='pending'&&store.hasReceipt(record.operationId,record.after.savedRevision,record.after.contentHash)){
      record.status='saved';write(path,record);
    }
    return record;
  }).filter((record,_index,records)=>!record.operationId.startsWith('observed:')||!records.some(other=>!other.operationId.startsWith('observed:')&&other.status==='saved'&&same(other.after,record.after)))
    .sort((a,b)=>b.at.localeCompare(a.at));
}

export function applyExternalEdit(project:string,input:{metadata:unknown;document:SequenceDocument;before:unknown},assertWritable:()=>void):ExternalEditRecord {
  const metadata=externalEditMetadata.parse(input.metadata),before=identity.parse(input.before);
  const after={savedRevision:input.document.revision,contentHash:sequenceContentHash(input.document)};
  const requestHash=hash(JSON.stringify({metadata,before,after}));
  const directory=folder(project),path=recordPath(directory,metadata.operationId);
  if(existsSync(path)){
    const existing=listExternalEdits(project).find(record=>record.operationId===metadata.operationId)!;
    if(existing.requestHash!==requestHash)throw new SequenceError('REVISION_CONFLICT','同じ外部操作IDの内容が異なります');
    if(existing.status!=='pending')return existing;
  }
  const record:ExternalEditRecord={...metadata,at:new Date().toISOString(),before,after,status:'pending',requestHash};
  write(path,record);
  try{
    assertWritable();
    new SequenceStore(project).save({expectedSavedRevision:before.savedRevision,expectedContentHash:before.contentHash,
      executionId:metadata.operationId,document:input.document});
    record.status='saved';write(path,record);
    const saved=new SequenceStore(project).load()!;observeExternalEdits(project,saved);
  }catch(error){
    // A post-rename failure is resolved using the atomic receipt, never labelled a failed save.
    if(new SequenceStore(project).hasReceipt(metadata.operationId,after.savedRevision,after.contentHash))record.status='saved';
    else {record.status=error instanceof SequenceError&&error.code==='REVISION_CONFLICT'?'conflict':'failed';record.error=error instanceof Error?error.message:String(error);}
    write(path,record);
  }
  return record;
}
