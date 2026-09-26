import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SequenceExports } from './exports';
import type { SequenceDocument } from '../../core/sequence/model';
import type { SequenceSessionState } from './service';
import type { ExportRunInput } from './exportRunner';
import { findBusyJobs } from '../projectBusy';
import { SequenceStore } from './store';
import { resolveProjectSteps } from '../projectSteps';
import {digest,persistExport,readExportRecord} from './exportRecords';

// Lifecycle fixture only. Real codec/frame/audio verification lives in export.e2e.test.ts.
async function complete(input:ExportRunInput) {
  await writeFile(join(input.directory,'output.mp4'),Buffer.from('verified-output-fixture'));
  await writeFile(join(input.directory,'verification.json'),JSON.stringify({revision:input.status.revision,contentHash:input.status.contentHash,settings:input.settings,outputResolution:input.status.outputResolution}));
}

function state(): SequenceSessionState {
  const doc:SequenceDocument = {schemaVersion:2,id:'export',name:'書き出し',revision:3,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:30,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  return {sessionId:'session',document:doc,savedRevision:3,savedContentHash:'saved',dirty:false,canUndo:false,canRedo:false};
}
it('freezes selected export settings and rejects replay with a different quality or resolution',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-settings-'));let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;}),inputs:ExportRunInput[]=[];
  const jobs=new SequenceExports(async input=>{inputs.push(input);await barrier;await complete(input);});
  const current=state();current.document.resolution={width:2160,height:3840};
  const request={sessionId:'session',expectedRevision:3,executionId:'settings',settings:{resolution:'1080p' as const,quality:'standard' as const}};
  try{
    const submitted=structuredClone(request),started=jobs.start(directory,'case','http://127.0.0.1',submitted,()=>current);
    Object.assign(submitted.settings,{quality:'light'});
    expect(started).toMatchObject({settings:{resolution:'1080p',quality:'standard'},outputResolution:{width:1080,height:1920}});
    expect(inputs[0]!.plan.document.resolution).toEqual({width:2160,height:3840});
    expect(inputs[0]!.settings).toEqual({resolution:'1080p',quality:'standard'});
    current.document.resolution={width:640,height:360};
    expect(()=>jobs.start(directory,'case','http://127.0.0.1',{...request,settings:{resolution:'1080p',quality:'light'}},()=>current)).toThrow(/異なる要求/);
    expect(()=>jobs.start(directory,'case','http://127.0.0.1',{...request,settings:{resolution:'full',quality:'standard'}},()=>current)).toThrow(/異なる要求/);
    release();await jobs.job(directory,started.id).completion;
    expect(readExportRecord(directory,started.id)).toMatchObject({version:2,request,status:{phase:'complete'}});
    const restored=new SequenceExports(()=>{throw new Error('same request must not render again');});
    expect(restored.start(directory,'case','unused',request,()=>{throw new Error('must not read changed session');})).toMatchObject({id:started.id,outputResolution:{width:1080,height:1920}});
    expect(inputs).toHaveLength(1);
  }finally{release();await rm(directory,{recursive:true,force:true});}
});
it('replays and downloads a pre-settings v1 history record with its original full/high defaults',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-v1-')),jobs=new SequenceExports(complete),request={sessionId:'session',expectedRevision:3,executionId:'v1'};
  try{
    const started=jobs.start(directory,'case','unused',request,state);await jobs.job(directory,started.id).completion;
    const path=join(directory,'.harness/exports',started.id,'manifest.json'),envelope=JSON.parse(await readFile(path,'utf8'));
    envelope.record.version=1;delete envelope.record.request.settings;delete envelope.record.status.settings;delete envelope.record.status.outputResolution;
    envelope.hash=digest(JSON.stringify(envelope.record));await writeFile(path,JSON.stringify(envelope));
    const restored=new SequenceExports(()=>{throw new Error('legacy record must not render again');});
    expect(restored.start(directory,'case','unused',request,()=>{throw new Error('no session needed');})).toMatchObject({id:started.id,phase:'complete'});
    expect(restored.start(directory,'case','unused',{...request,settings:{resolution:'full',quality:'high'}},state).id).toBe(started.id);
    expect(()=>restored.start(directory,'case','unused',{...request,settings:{resolution:'720p',quality:'light'}},state)).toThrow(/異なる要求/);
    expect(await readFile(await restored.download(directory,started.id),'utf8')).toBe('verified-output-fixture');
    expect(readExportRecord(directory,started.id).version).toBe(1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('does not publish output whose verification reports different settings',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-settings-proof-'));
  const jobs=new SequenceExports(async input=>{await complete(input);await writeFile(join(input.directory,'verification.json'),JSON.stringify({revision:input.status.revision,contentHash:input.status.contentHash,settings:{resolution:'full',quality:'light'},outputResolution:input.status.outputResolution}));});
  try{
    const started=jobs.start(directory,'case','unused',{sessionId:'session',expectedRevision:3,executionId:'proof'},state);await jobs.job(directory,started.id).completion;
    expect(jobs.job(directory,started.id).status).toMatchObject({phase:'failed',error:'書き出しの検証結果と設定が一致しません'});
    await expect(jobs.download(directory,started.id)).rejects.toThrow(/完了/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('checks persisted settings against the output proof again after restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-settings-tamper-')),jobs=new SequenceExports(complete);
  try{
    const started=jobs.start(directory,'case','unused',{sessionId:'session',expectedRevision:3,executionId:'tamper'},state);await jobs.job(directory,started.id).completion;
    const path=join(directory,'.harness/exports',started.id,'manifest.json'),envelope=JSON.parse(await readFile(path,'utf8'));
    envelope.record.request.settings.quality='light';envelope.record.status.settings.quality='light';envelope.hash=digest(JSON.stringify(envelope.record));await writeFile(path,JSON.stringify(envelope));
    await expect(new SequenceExports().download(directory,started.id)).rejects.toThrow(/設定/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('preserves odd-size full rejection while permitting an even scaled output',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-odd-size-')),jobs=new SequenceExports(complete),current=state();current.document.resolution={width:853,height:481};
  const request={sessionId:'session',expectedRevision:3,executionId:'odd'};
  try{
    expect(()=>jobs.start(directory,'case','unused',request,()=>current)).toThrow(/偶数/);
    const started=jobs.start(directory,'case','unused',{...request,settings:{resolution:'720p',quality:'standard'}},()=>current);
    await jobs.job(directory,started.id).completion;expect(jobs.job(directory,started.id).status).toMatchObject({phase:'complete',outputResolution:{width:568,height:320}});
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('pins saved input and replays a job id without restarting or reading later edits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-job-')); let release!:()=>void, calls=0;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const jobs=new SequenceExports(async input=>{calls++;await barrier;expect(input.plan.document.name).toBe('書き出し');await complete(input);}), current=state();
  const request={sessionId:'session',expectedRevision:3,executionId:'start'};
  try {
    new SequenceStore(directory).save({document:current.document,executionId:'save-before-export',expectedSavedRevision:null});
    const started=jobs.start(directory,'case','http://127.0.0.1',request,()=>current);
    current.document.name='書き出し開始後の変更';current.document.revision++;
    expect(jobs.start(directory,'case','http://127.0.0.1',request,()=>{throw new Error('再送で編集版を再読しない');}).id).toBe(started.id);
    expect(()=>jobs.start(directory,'case','http://127.0.0.1',{...request,expectedRevision:4},()=>current)).toThrow(/異なる要求/);
    release();await jobs.job(directory,started.id).completion;
    expect(calls).toBe(1);expect(jobs.job(directory,started.id).status.phase).toBe('complete');
    const saved=JSON.parse(await readFile(join(directory,'.harness/exports',started.id,'input.json'),'utf8'));
    expect(saved.name).toBe('書き出し');expect(saved.revision).toBe(3);
    const restarted=new SequenceExports(()=>{throw new Error('二重に書き出さない');});
    expect(restarted.start(directory,'case','http://127.0.0.1',request,()=>{throw new Error('新しいセッションは不要');},()=>{throw new Error('再送は新規枠を消費しない');})).toMatchObject({id:started.id,phase:'complete'});
    expect(restarted.lookup(directory,'start')).toMatchObject({id:started.id,phase:'complete'});
    expect(await readFile(await restarted.download(directory,started.id),'utf8')).toBe('verified-output-fixture');
    expect(jobs.activeCount()).toBe(0);expect(jobs.get('case')).toBeUndefined();
    expect(resolveProjectSteps(directory).rendered).toBe(true);
    expect(()=>restarted.start(directory,'case','http://127.0.0.1',{...request,sessionId:'different'},()=>state())).toThrow(/異なる要求/);
  } finally {release();await rm(directory,{recursive:true,force:true});}
});
it('rejects unsaved/empty input and records cancellation instead of a completed download',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-cancel-'));
  const jobs=new SequenceExports(async input=>{input.signal.throwIfAborted();await new Promise<void>((_,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('中止')),{once:true}));}),current=state();
  const request={sessionId:'session',expectedRevision:3,executionId:'cancel'};
  try {
    current.dirty=true;expect(()=>jobs.start(directory,'case','http://127.0.0.1',request,()=>current)).toThrow(/保存/);
    current.dirty=false;current.document.sequenceEndFrame=0;expect(()=>jobs.start(directory,'case','http://127.0.0.1',request,()=>current)).toThrow(/出力する内容/);
    current.document.sequenceEndFrame=30;const started=jobs.start(directory,'case','http://127.0.0.1',request,()=>current);
    expect(findBusyJobs('case',{nativeRender:jobs},directory)).toEqual(['nativeRender']);
    jobs.killAll();await jobs.job(directory,started.id).completion;
    expect(jobs.job(directory,started.id).status).toMatchObject({phase:'cancelled'});expect(jobs.job(directory,started.id).status.downloadUrl).toBeUndefined();
    expect(findBusyJobs('case',{nativeRender:jobs},directory)).toEqual([]);
  } finally {await rm(directory,{recursive:true,force:true});}
});
it('does not encode when admission or durable input storage fails',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-storage-')),runner=vi.fn(complete),jobs=new SequenceExports(runner);
  const request={sessionId:'session',expectedRevision:3,executionId:'storage'};
  try {
    expect(()=>jobs.start(directory,'case','http://127.0.0.1',request,state,()=>{throw new Error('heavy busy');})).toThrow('heavy busy');
    await mkdir(join(directory,'.harness'));await writeFile(join(directory,'.harness/exports'),'not a directory');
    expect(()=>jobs.start(directory,'case','http://127.0.0.1',request,state)).toThrow(/保存先/);
    expect(runner).not.toHaveBeenCalled();
  }finally{await rm(directory,{recursive:true,force:true});}
});
it.each(['input','verification','output','symlink','manifest'] as const)('rejects changed %s after completion and restart',async kind=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-integrity-')),jobs=new SequenceExports(complete);
  try {
    const job=jobs.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'integrity'},state);
    await jobs.job(directory,job.id).completion;const path=join(directory,'.harness/exports',job.id);
    await jobs.download(directory,job.id); // Also exercise cache invalidation after a successful read.
    if(kind==='input') {const doc=JSON.parse(await readFile(join(path,'input.json'),'utf8'));doc.name='changed';await writeFile(join(path,'input.json'),JSON.stringify(doc));}
    if(kind==='verification')await writeFile(join(path,'verification.json'),'{}');
    if(kind==='output')await writeFile(join(path,'output.mp4'),'changed-output-fixture');
    if(kind==='manifest'){const data=JSON.parse(await readFile(join(path,'manifest.json'),'utf8'));data.record.status.phase='failed';await writeFile(join(path,'manifest.json'),JSON.stringify(data));}
    if(kind==='symlink'){await writeFile(join(directory,'foreign.mp4'),'verified-output-fixture');await rm(join(path,'output.mp4'));await symlink(join(directory,'foreign.mp4'),join(path,'output.mp4'));}
    await expect(new SequenceExports().download(directory,job.id)).rejects.toThrow(/変更|不正/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('pages completed and failed history without retaining live work',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-history-')),jobs=new SequenceExports(async input=>{
    if(input.status.executionId==='failure')throw new Error('encoder failed');await complete(input);
  });
  try {
    for(const executionId of ['first','second','failure']){
      const job=jobs.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId},state);await jobs.job(directory,job.id).completion;
    }
    const recovered=new SequenceExports(),first=recovered.page(directory,0,2),next=recovered.page(directory,first.nextOffset!,2);
    expect(first.total).toBe(3);expect(first.jobs).toHaveLength(2);expect(next.jobs).toHaveLength(1);expect(next.nextOffset).toBeNull();
    expect(new Set([...first.jobs,...next.jobs].map(job=>job.id)).size).toBe(3);
    expect(recovered.lookup(directory,'failure')).toMatchObject({phase:'failed',error:'encoder failed'});expect(recovered.lookup(directory,'missing')).toBeUndefined();
    expect(()=>recovered.page(directory,-1)).toThrow(/範囲/);expect(()=>recovered.page(directory,0,101)).toThrow(/範囲/);
    expect(jobs.activeCount()).toBe(0);
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('protects another live server and records interruption only after its actual process exits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-process-'));
  const source=`import {SequenceExports} from ${JSON.stringify(pathToFileURL(resolve('src/server/sequence/exports.ts')).href)};
    import {writeFileSync} from 'node:fs';import {join} from 'node:path';
    const jobs=new SequenceExports(async input=>{input.status.phase='rendering';input.progress();await new Promise(()=>{});});
    const job=jobs.start(${JSON.stringify(directory)},'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'process'},()=>(${JSON.stringify(state())}));
    const folder=jobs.job(${JSON.stringify(directory)},job.id).directory;
    writeFileSync(join(folder,'audio.f32le'),'partial');writeFileSync(join(folder,'output.partial.mp4'),'partial');
    setInterval(()=>{},1000);process.send(job);`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});const closed=once(child,'close');
  try {
    const message=await Promise.race([once(child,'message'),closed.then(()=>{throw new Error(stderr||'child exited before ready');})]);
    const id=(message[0] as {id:string}).id,restarted=new SequenceExports();
    expect(restarted.lookup(directory,'process')).toMatchObject({phase:'rendering'});
    expect(findBusyJobs('case',{nativeRender:restarted},directory)).toEqual(['nativeRender']);
    expect(()=>restarted.cancel(directory,id)).toThrow(/別のサーバー/);
    expect(()=>restarted.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'other'},state)).toThrow(/進行中/);
    child.kill('SIGKILL');await closed;
    expect(restarted.lookup(directory,'process')).toMatchObject({phase:'failed',error:expect.stringContaining('サーバーが停止')});
    expect(new SequenceExports().lookup(directory,'process')).toMatchObject({phase:'failed'});
    const files=await readdir(join(directory,'.harness/exports',id));expect(files).not.toContain('audio.f32le');expect(files).not.toContain('output.partial.mp4');
    await expect(restarted.download(directory,id)).rejects.toThrow(/完了していません/);
    expect(findBusyJobs('case',{nativeRender:restarted},directory)).toEqual([]);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await closed;}await rm(directory,{recursive:true,force:true});}
},15000);
it('does not publish an output when the final record cannot be saved, and recovers after storage repair',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-final-storage-'));let calls=0;
  const jobs=new SequenceExports(async input=>{
    calls++;await complete(input);
    if(calls===1){await rm(join(input.directory,'manifest.json'));await mkdir(join(input.directory,'manifest.json'));}
  });
  const request={sessionId:'session',expectedRevision:3,executionId:'failed-record'};
  try {
    const first=jobs.start(directory,'case','http://127.0.0.1',request,state);await jobs.job(directory,first.id).completion;
    expect(jobs.job(directory,first.id).status).toMatchObject({phase:'failed',error:expect.stringContaining('記録を保存できません')});
    await expect(jobs.download(directory,first.id)).rejects.toThrow(/完了していません/);
    expect(()=>jobs.start(directory,'case','http://127.0.0.1',{...request,executionId:'next'},state)).toThrow(/記録を保存できません/);
    await rm(join(directory,'.harness/exports',first.id,'manifest.json'),{recursive:true});
    expect(jobs.list(directory)[0]!.phase).toBe('failed'); // Persists the failed result after storage recovers.
    expect(new SequenceExports().lookup(directory,request.executionId)?.phase).toBe('failed');
    expect(jobs.start(directory,'case','http://127.0.0.1',request,state).phase).toBe('failed');expect(calls).toBe(1);
    const next=jobs.start(directory,'case','http://127.0.0.1',{...request,executionId:'next'},state);await jobs.job(directory,next.id).completion;
    expect(jobs.lookup(directory,'next')?.phase).toBe('complete');
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('replays an identical request accepted by another server between the first lookup and the busy check',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-accept-race-'));let release!:()=>void,acceptedId='';
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const other=new SequenceExports(async input=>{await barrier;await complete(input);}),jobs=new SequenceExports();
  const request={sessionId:'session',expectedRevision:3,executionId:'same-request'};
  const spy=vi.spyOn(jobs,'list').mockImplementationOnce(()=>[]).mockImplementationOnce(()=>{
    acceptedId=other.start(directory,'case','http://127.0.0.1',request,state).id;
    return other.list(directory);
  });
  try {
    const result=jobs.start(directory,'case','http://127.0.0.1',request,state);
    expect(result.id).toBe(acceptedId);expect(other.list(directory)).toHaveLength(1);
  }finally{spy.mockRestore();release();if(acceptedId)await other.job(directory,acceptedId).completion;await rm(directory,{recursive:true,force:true});}
});
// A crashed server's PID can be reused after a restart, by this server or by another user's process.
async function interruptedRecord(directory:string,ownerPid:number){
  const jobs=new SequenceExports(complete),job=jobs.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'reused-pid'},state);
  await jobs.job(directory,job.id).completion;
  const record=readExportRecord(directory,job.id),folder=join(directory,'.harness/exports',job.id);
  record.status.phase='rendering';delete record.status.finishedAt;delete record.status.downloadUrl;delete record.output;record.ownerPid=ownerPid;persistExport(folder,record);
  await writeFile(join(folder,'output.partial.mp4'),'partial');
  return job.id;
}
it('treats its own PID on an untracked active record as an earlier server that stopped',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-own-pid-'));
  try {
    const id=await interruptedRecord(directory,process.pid),restarted=new SequenceExports(complete);
    expect(restarted.lookup(directory,'reused-pid')).toMatchObject({phase:'failed',error:expect.stringContaining('サーバーが停止')});
    expect(await readdir(join(directory,'.harness/exports',id))).not.toContain('output.partial.mp4');
    const next=restarted.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'after-restart'},state);
    await restarted.job(directory,next.id).completion;expect(restarted.job(directory,next.id).status.phase).toBe('complete');
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('treats an owner PID held by another user as a stopped server',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-foreign-pid-'));
  try {
    await interruptedRecord(directory,424242);
    const kill=vi.spyOn(process,'kill').mockImplementation(pid=>{if(pid===424242)throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});return true;});
    try{expect(new SequenceExports().lookup(directory,'reused-pid')).toMatchObject({phase:'failed',error:expect.stringContaining('サーバーが停止')});}
    finally{kill.mockRestore();}
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('keeps an export running in another instance of this process active',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-sibling-'));
  const running=new SequenceExports(input=>new Promise((_resolve,reject)=>{input.status.phase='rendering';input.progress?.();input.signal.addEventListener('abort',()=>reject(new Error('stop')),{once:true});}));
  try {
    const job=running.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'sibling'},state);
    await vi.waitFor(()=>expect(readExportRecord(directory,job.id).status.phase).toBe('rendering'));
    expect(new SequenceExports().lookup(directory,'sibling')).toMatchObject({phase:'rendering'});
    running.cancel(directory,job.id);await running.job(directory,job.id).completion;
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('keeps an export running under another loaded copy of this module active',async()=>{
  // A bundled dev server and a script importing the sources each load their own module copy in one process.
  const directory=await mkdtemp(join(tmpdir(),'native-export-module-copy-'));
  vi.resetModules();const copy=await import('./exports');
  const running=new copy.SequenceExports(input=>new Promise((_resolve,reject)=>{input.status.phase='rendering';input.progress?.();input.signal.addEventListener('abort',()=>reject(new Error('stop')),{once:true});}));
  try {
    const job=running.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'module-copy'},state);
    await vi.waitFor(()=>expect(readExportRecord(directory,job.id).status.phase).toBe('rendering'));
    await writeFile(join(directory,'.harness/exports',job.id,'audio.f32le'),'pcm');
    expect(new SequenceExports().lookup(directory,'module-copy')).toMatchObject({phase:'rendering'});
    expect(await readdir(join(directory,'.harness/exports',job.id))).toContain('audio.f32le');
    running.cancel(directory,job.id);await running.job(directory,job.id).completion;
  }finally{await rm(directory,{recursive:true,force:true});}
});
it('keeps history, busy checks, and new exports working around one unreadable record',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-unreadable-')),broken='f'.repeat(32);
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  try {
    const jobs=new SequenceExports(complete),first=jobs.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'healthy'},state);
    await jobs.job(directory,first.id).completion;
    await mkdir(join(directory,'.harness/exports',broken));await writeFile(join(directory,'.harness/exports',broken,'manifest.json'),'{not json');
    const fresh=new SequenceExports(complete);
    expect(fresh.page(directory)).toMatchObject({total:1,jobs:[{id:first.id,phase:'complete'}]});
    expect(fresh.get('case',directory)).toBeUndefined();
    expect(findBusyJobs('case',{nativeRender:fresh},directory)).toEqual([]);
    const next=fresh.start(directory,'case','http://127.0.0.1',{sessionId:'session',expectedRevision:3,executionId:'after-unreadable'},state);
    await fresh.job(directory,next.id).completion;expect(fresh.job(directory,next.id).status.phase).toBe('complete');
    await expect(fresh.download(directory,broken)).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('書き出し記録'),broken,expect.anything());
  }finally{warn.mockRestore();await rm(directory,{recursive:true,force:true});}
});
