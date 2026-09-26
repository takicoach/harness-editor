import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdir,mkdtemp,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LegacyNativeRenderJobs} from './legacyNativeRenderJobs';
import {persistLegacyRenderRecord,readLegacyRenderRecords} from './legacyNativeRenderRecords';
import * as records from './legacyNativeRenderRecords';
import {SequenceExports} from './sequence/exports';
import {SequenceStore} from './sequence/store';
import {activeExportAdmission} from './sequence/exportAdmission';
import {readExportInput,readExportRecord} from './sequence/exportRecords';
import type {SequenceDocument} from '../core/sequence/model';
import type {ExportRunInput} from './sequence/exportRunner';

let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'legacy-native-facade-'));});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
function document():SequenceDocument {
  return {schemaVersion:2,id:'legacy',name:'旧案件',revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',
    tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
    assets:[{id:'main',kind:'media',name:'原本',file:'.harness/assets/main.mp4',fingerprint:'b'.repeat(64),streams:[{index:0,kind:'video',codec:'h264',duration:{num:1,den:1},frameRate:{num:30,den:1},width:320,height:180}]}],
    legacy:{sourceFingerprint:'a'.repeat(64),primaryAssetId:'main',originalEndFrame:30}};
}
const prepare=async()=>({document:document(),notices:[]});
const input=()=>({projectDir:root,origin:'unused',options:{resolution:'full' as const,quality:'high' as const,outputName:'旧案件.mp4'}});
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {resolve,promise};};
// Protocol/lifecycle bytes only. Real codec/HTTP behavior has a separate audit.
async function complete(run:ExportRunInput){
  await writeFile(join(run.directory,'output.mp4'),'verified-native-output');
  await writeFile(join(run.directory,'verification.json'),JSON.stringify({revision:run.status.revision,contentHash:run.status.contentHash,settings:run.settings,outputResolution:run.status.outputResolution}));
}
it('owns preparation through publication, counts once and keeps native editing unsaved',async()=>{
  const preparing=gate(),engine=new SequenceExports(complete),jobs=new LegacyNativeRenderJobs(engine,async()=>{await preparing.promise;return prepare();});
  const seen:string[]=[];jobs.subscribe('p',event=>{seen.push(event.phase);});jobs.subscribe('p',()=>{throw new Error('disconnected observer');});
  const afterThrow:string[]=[];jobs.subscribe('p',event=>{afterThrow.push(event.phase);});
  const start=jobs.start('p',{...input(),options:{...input().options,ducking:{enabled:true,strength:'strong'}}});
  expect(start.phase).toBe('preparing');expect(seen).toEqual(['preparing']);expect(jobs.activeCount()+engine.activeCount()).toBe(1);
  expect(engine.get('p',root)?.phase).toBe('preparing');expect(activeExportAdmission(root)).toBeDefined();
  expect(()=>new SequenceExports(complete).reserveLegacySnapshot(root,'other','another')).toThrow();
  preparing.resolve();await jobs.wait('p');
  expect(afterThrow).toEqual(seen);expect(afterThrow[0]).toBe('preparing');expect(afterThrow.at(-1)).toBe('done');
  expect(jobs.getSnapshot('p')?.phase).toBe('done');expect(jobs.activeCount()+engine.activeCount()).toBe(0);expect(activeExportAdmission(root)).toBeUndefined();
  expect(new SequenceStore(root).load()).toBeNull();
  const [record]=readLegacyRenderRecords(root);expect(record).toBeDefined();const native=readExportRecord(root,record!.id);
  expect(readExportInput(root,native).ducking).toEqual({enabled:true,strength:'strong'});
  expect(await readFile(join(root,'out','旧案件.mp4'),'utf8')).toBe('verified-native-output');
  const restored=new LegacyNativeRenderJobs(new SequenceExports(async()=>{throw new Error('must not render');}),async()=>{throw new Error('must not prepare');});
  await restored.restore('p',root);expect(restored.getSnapshot('p')).toEqual(jobs.getSnapshot('p'));restored.discard('p');expect(restored.getSnapshot('p')?.phase).toBe('done');
  await writeFile(join(root,'out','旧案件.mp4'),'user changed published copy');
  expect(await readFile(await engine.download(root,record!.id),'utf8')).toBe('verified-native-output');
});
it('cancels preparation and releases its reservation only after preparation settles',async()=>{
  const preparing=gate(),engine=new SequenceExports(async()=>{throw new Error('must not render');});
  const jobs=new LegacyNativeRenderJobs(engine,async(_root,signal)=>{await preparing.promise;signal?.throwIfAborted();return prepare();});
  jobs.start('p',input());expect(jobs.cancel('p')).toBe(true);expect(engine.activeCount()).toBe(1);expect(activeExportAdmission(root)).toBeDefined();
  preparing.resolve();await jobs.wait('p');expect(jobs.getSnapshot('p')?.phase).toBe('cancelled');expect(engine.activeCount()).toBe(0);expect(engine.list(root)).toEqual([]);
  expect(await readdir(join(root,'out'))).toEqual([]);
});
it('cancels the actual native runner and never publishes its partial output',async()=>{
  const entered=gate(),engine=new SequenceExports(run=>new Promise((_done,reject)=>{run.signal.addEventListener('abort',()=>reject(run.signal.reason),{once:true});entered.resolve();}));
  const jobs=new LegacyNativeRenderJobs(engine,prepare);jobs.start('p',input());await entered.promise;expect(engine.activeCount()).toBe(1);
  jobs.cancel('p');await jobs.wait('p');expect(jobs.getSnapshot('p')?.phase).toBe('cancelled');expect(engine.activeCount()).toBe(0);expect(await readdir(join(root,'out'))).toEqual([]);
});
it('does not replace an output created by another writer while native rendering runs',async()=>{
  const entered=gate(),finish=gate(),engine=new SequenceExports(async run=>{entered.resolve();await finish.promise;await complete(run);});
  const jobs=new LegacyNativeRenderJobs(engine,prepare);jobs.start('p',input());await entered.promise;
  await writeFile(join(root,'out','旧案件.mp4'),'another writer');finish.resolve();await jobs.wait('p');
  expect(jobs.getSnapshot('p')?.phase).toBe('failed');expect(await readFile(join(root,'out','旧案件.mp4'),'utf8')).toBe('another writer');
  expect(await readdir(join(root,'out'))).toEqual(['旧案件.mp4']);expect(engine.activeCount()).toBe(0);
  const [record]=readLegacyRenderRecords(root);expect(await readFile(await engine.download(root,record!.id),'utf8')).toBe('verified-native-output');
});
it('recovers a crash after exclusive output publication without preparing or rendering again',async()=>{
  const jobs=new LegacyNativeRenderJobs(new SequenceExports(complete),prepare);jobs.start('p',input());await jobs.wait('p');
  const [record]=readLegacyRenderRecords(root);record!.ownerPid=2147483647;record!.job.phase='finalizing';persistLegacyRenderRecord(root,record!);
  const restored=new LegacyNativeRenderJobs(new SequenceExports(async()=>{throw new Error('must not render');}),async()=>{throw new Error('must not prepare');});
  await restored.restore('p',root);expect(restored.getSnapshot('p')?.phase).toBe('done');expect(readLegacyRenderRecords(root)[0]!.job.phase).toBe('done');
});
it('marks its own PID on an untracked active render as a stopped server',async()=>{
  const jobs=new LegacyNativeRenderJobs(new SequenceExports(complete),prepare);jobs.start('p',input());await jobs.wait('p');
  const [record]=readLegacyRenderRecords(root);record!.ownerPid=process.pid;record!.job.phase='rendering';delete record!.publication;persistLegacyRenderRecord(root,record!);
  const restored=new LegacyNativeRenderJobs(new SequenceExports(async()=>{throw new Error('must not render');}),async()=>{throw new Error('must not prepare');});
  await restored.restore('p',root);expect(restored.getSnapshot('p')).toMatchObject({phase:'failed',error:{code:'server-stopped'}});
});
it('keeps both actual subscribers through discard and a second export',async()=>{
  const jobs=new LegacyNativeRenderJobs(new SequenceExports(complete),prepare),first:string[]=[],second:string[]=[];
  jobs.subscribe('p',event=>{first.push(event.phase);if(event.phase==='done')jobs.discard('p');});jobs.subscribe('p',event=>{second.push(event.phase);});
  jobs.start('p',input());await jobs.wait('p');
  jobs.start('p',{...input(),options:{...input().options,outputName:'second.mp4'}});await jobs.wait('p');
  expect(first.filter(phase=>phase==='done')).toHaveLength(2);expect(second.filter(phase=>phase==='done')).toHaveLength(2);
});
it('marks a changed completed output as failed on reconnect without altering native output',async()=>{
  const engine=new SequenceExports(complete),jobs=new LegacyNativeRenderJobs(engine,prepare);jobs.start('p',input());await jobs.wait('p');
  await jobs.restore('p',root);
  const [record]=readLegacyRenderRecords(root);await writeFile(join(root,'out','旧案件.mp4'),'changed');await jobs.restore('p',root);
  expect(jobs.getSnapshot('p')).toMatchObject({phase:'failed',error:{code:'output-changed'}});
  expect(await readFile(await engine.download(root,record!.id),'utf8')).toBe('verified-native-output');
});
it('keeps a published video complete when the first done journal write fails',async()=>{
  const persist=records.persistLegacyRenderRecord;let failed=false;
  vi.spyOn(records,'persistLegacyRenderRecord').mockImplementation((directory,record)=>{
    if(record.job.phase==='done'&&!failed){failed=true;throw new Error('ENOSPC after publication');}persist(directory,record);
  });
  const jobs=new LegacyNativeRenderJobs(new SequenceExports(complete),prepare);jobs.start('p',input());await jobs.wait('p');
  expect(failed).toBe(true);expect(jobs.getSnapshot('p')).toMatchObject({phase:'done',warning:expect.any(String)});
  expect(readLegacyRenderRecords(root)[0]!.job.phase).toBe('done');expect(activeExportAdmission(root)).toBeUndefined();
  await jobs.restore('p',root);expect(jobs.getSnapshot('p')?.phase).toBe('done');
  expect(await readFile(join(root,'out','旧案件.mp4'),'utf8')).toBe('verified-native-output');
});
it('recovers a previously failed publication only after verifying its native and published bytes',async()=>{
  const jobs=new LegacyNativeRenderJobs(new SequenceExports(complete),prepare);jobs.start('p',input());await jobs.wait('p');
  const [record]=readLegacyRenderRecords(root);record!.job.phase='failed';record!.job.error={code:'native-render-failed',message:'journal failure'};persistLegacyRenderRecord(root,record!);
  await jobs.restore('p',root);expect(jobs.getSnapshot('p')?.phase).toBe('done');expect(readLegacyRenderRecords(root)[0]!.job.error).toBeUndefined();
});
it('coalesces concurrent verification and reuses signatures until a bound file changes',async()=>{
  const engine=new SequenceExports(complete),jobs=new LegacyNativeRenderJobs(engine,prepare);jobs.start('p',input());await jobs.wait('p');
  const download=vi.spyOn(engine,'download');
  await Promise.all([jobs.restore('p',root),jobs.restore('p',root),jobs.restore('p',root)]);expect(download).toHaveBeenCalledTimes(1);
  await jobs.restore('p',root);expect(download).toHaveBeenCalledTimes(1);
  const [record]=readLegacyRenderRecords(root);await writeFile(join(root,'.harness/exports',record!.id,'input.json'),'{}');
  await expect(jobs.restore('p',root)).rejects.toThrow();expect(download).toHaveBeenCalledTimes(2);
  await expect(jobs.restore('p',root)).rejects.toThrow();expect(download).toHaveBeenCalledTimes(2);
});
it('caches a changed-output result and invalidates it when the original bytes are restored',async()=>{
  const engine=new SequenceExports(complete),jobs=new LegacyNativeRenderJobs(engine,prepare);jobs.start('p',input());await jobs.wait('p');
  const download=vi.spyOn(engine,'download'),file=join(root,'out','旧案件.mp4');await writeFile(file,'changed output');
  await jobs.restore('p',root);expect(jobs.getSnapshot('p')?.phase).toBe('failed');expect(download).toHaveBeenCalledTimes(1);
  await jobs.restore('p',root);expect(download).toHaveBeenCalledTimes(1);
  await writeFile(file,'verified-native-output');await jobs.restore('p',root);expect(download).toHaveBeenCalledTimes(2);expect(jobs.getSnapshot('p')?.phase).toBe('done');
});
it('does not revive an old root after a later empty-root restore completes',async()=>{
  const engine=new SequenceExports(complete),jobs=new LegacyNativeRenderJobs(engine,prepare);jobs.start('p',input());await jobs.wait('p');
  const restored=new LegacyNativeRenderJobs(engine,prepare),entered=gate(),resume=gate(),download=engine.download.bind(engine);
  vi.spyOn(engine,'download').mockImplementation(async(...args)=>{entered.resolve();await resume.promise;return download(...args);});
  const pending=restored.restore('p',root);await entered.promise;
  const other=join(root,'another-root');await mkdir(other);await restored.restore('p',other);expect(restored.getSnapshot('p')).toBeUndefined();
  resume.resolve();await pending;expect(restored.getSnapshot('p')).toBeUndefined();
});
