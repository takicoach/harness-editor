import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SequenceExports } from './exports';
import { SequenceStore, sequenceContentHash } from './store';
import { digest, readExportInput, readExportRecord, type LegacySnapshotExportRequest } from './exportRecords';
import type { SequenceDocument } from '../../core/sequence/model';
import type { ExportRunInput } from './exportRunner';

let directory:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'legacy-snapshot-export-'));});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
function fixture():SequenceDocument {
  return {schemaVersion:2,id:'legacy-export',name:'旧案件',revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:30,
    background:'#000000',tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    assets:[{id:'main',kind:'media',name:'原本',file:'.harness/assets/main.mp4',fingerprint:'b'.repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:{num:1,den:1},frameRate:{num:30,den:1},width:320,height:180}]}],
    legacy:{sourceFingerprint:'a'.repeat(64),primaryAssetId:'main',originalEndFrame:30}};
}
function request(doc:SequenceDocument,executionId='legacy-run'):LegacySnapshotExportRequest {
  return {kind:'legacy-snapshot',sourceFingerprint:doc.legacy!.sourceFingerprint,snapshotHash:sequenceContentHash(doc),expectedRevision:doc.revision,
    executionId,settings:{resolution:'full',quality:'high'},outputName:'旧案件.mp4'};
}
// Lifecycle bytes only; actual codec/frame/audio are exercised by the browser audit.
async function complete(input:ExportRunInput) {
  await writeFile(join(input.directory,'output.mp4'),'lifecycle-output');
  await writeFile(join(input.directory,'verification.json'),JSON.stringify({revision:input.status.revision,contentHash:input.status.contentHash,settings:input.settings,outputResolution:input.status.outputResolution}));
}
it('records a legacy snapshot without a fake session or native save, and replays its verified output after restart',async()=>{
  const doc=fixture(),input=request(doc),jobs=new SequenceExports(complete);
  const started=jobs.startLegacySnapshot(directory,'case','unused',input,doc);
  const completion=jobs.job(directory,started.id).completion;
  doc.background='#ffffff';await completion;
  expect(new SequenceStore(directory).load()).toBeNull();
  const record=readExportRecord(directory,started.id);
  expect(record).toMatchObject({version:3,request:input,status:{phase:'complete'}});
  expect(record.request).not.toHaveProperty('sessionId');
  expect(readExportInput(directory,record).background).toBe('#000000');
  const restored=new SequenceExports(async()=>{throw new Error('replay must not render');});
  expect(restored.startLegacySnapshot(directory,'case','unused',input,doc)).toMatchObject({id:started.id,phase:'complete'});
  expect(await readFile(await restored.download(directory,started.id),'utf8')).toBe('lifecycle-output');
  expect(new SequenceStore(directory).load()).toBeNull();
});
it('rejects changed snapshot, fingerprint, settings, output name and export kind on the same execution ID',async()=>{
  const doc=fixture(),input=request(doc),jobs=new SequenceExports(complete),started=jobs.startLegacySnapshot(directory,'case','unused',input,doc);
  await jobs.job(directory,started.id).completion;
  for(const patch of [{snapshotHash:'c'.repeat(64)},{sourceFingerprint:'d'.repeat(64)},{outputName:'other.mp4'},{settings:{resolution:'720p' as const,quality:'high' as const}}])
    expect(()=>jobs.startLegacySnapshot(directory,'case','unused',{...input,...patch},doc)).toThrow(/異なる要求/);
  expect(()=>jobs.start(directory,'case','unused',{sessionId:'session',expectedRevision:0,executionId:input.executionId},()=>{throw new Error('must reject before session lookup');})).toThrow(/異なる要求/);
});
it('rejects a mismatched document before creating an export, and keeps the native authority gate',async()=>{
  const doc=fixture(),input=request(doc),jobs=new SequenceExports(complete);
  for(const changed of [{...doc,revision:1},{...doc,background:'#fff'},{...doc,legacy:{...doc.legacy!,sourceFingerprint:'f'.repeat(64)}}])
    expect(()=>jobs.startLegacySnapshot(directory,'case','unused',input,changed)).toThrow(/変更されています/);
  expect(jobs.list(directory)).toEqual([]);
  new SequenceStore(directory).save({document:doc,executionId:'save',expectedSavedRevision:null});
  expect(()=>jobs.startLegacySnapshot(directory,'case','unused',input,doc)).toThrow(/新形式で保存/);
  expect(jobs.list(directory)).toEqual([]);
});
it.each(['../escape.mp4','CON.mp4','hidden/movie.mp4','.private.mp4'])('rejects an unsafe output name %s',outputName=>{
  const doc=fixture(),jobs=new SequenceExports(complete);
  expect(()=>jobs.startLegacySnapshot(directory,'case','unused',{...request(doc),outputName},doc)).toThrow();
  expect(jobs.list(directory)).toEqual([]);
});
it('retains cancellation and releases admission without publishing a completed output',async()=>{
  const doc=fixture(),jobs=new SequenceExports(input=>new Promise((_resolve,reject)=>{input.signal.addEventListener('abort',()=>reject(input.signal.reason),{once:true});}));
  const started=jobs.startLegacySnapshot(directory,'case','unused',request(doc),doc),completion=jobs.job(directory,started.id).completion;
  expect(jobs.activeCount()).toBe(1);jobs.cancel(directory,started.id);await completion;
  expect(jobs.activeCount()).toBe(0);expect(readExportRecord(directory,started.id)).toMatchObject({version:3,status:{phase:'cancelled'}});
  await expect(jobs.download(directory,started.id)).rejects.toThrow(/完了していません/);
  const next=new SequenceExports(complete),again=next.startLegacySnapshot(directory,'case','unused',request(doc,'next'),doc);
  await next.job(directory,again.id).completion;expect(next.lookup(directory,'next')?.phase).toBe('complete');
});
it('checks source binding even when a modified manifest has a recomputed envelope hash',async()=>{
  const doc=fixture(),jobs=new SequenceExports(complete),started=jobs.startLegacySnapshot(directory,'case','unused',request(doc),doc);
  await jobs.job(directory,started.id).completion;
  const path=join(directory,'.harness/exports',started.id,'manifest.json'),envelope=JSON.parse(await readFile(path,'utf8'));
  envelope.record.request.sourceFingerprint='f'.repeat(64);envelope.hash=digest(JSON.stringify(envelope.record));await writeFile(path,JSON.stringify(envelope));
  const restored=new SequenceExports(complete);
  await expect(restored.download(directory,started.id)).rejects.toThrow(/書き出し元の記録/);
});
