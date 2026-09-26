import { expect,it,vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir,mkdtemp,writeFile,readFile,readdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SequenceExports } from './exports';
import { acquireExportAdmission,activeExportAdmission } from './exportAdmission';
import { exportJobId } from './exportRecords';
import type { SequenceSessionState } from './service';

const state:SequenceSessionState={sessionId:'shared',dirty:false,canUndo:false,canRedo:false,savedRevision:0,savedContentHash:'saved',
  document:{schemaVersion:2,id:'case',name:'同時開始',revision:0,fps:{num:30,den:1},resolution:{width:320,height:180},sequenceEndFrame:30,
    background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}}};
it('serializes separate processes which all observed no job, then recovers after the winning owner exits',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-export-admission-'));
  const source=`import {SequenceExports} from ${JSON.stringify(pathToFileURL(resolve('src/server/sequence/exports.ts')).href)};
    import {writeFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
    const root=process.env.EXPORT_TEST_ROOT,index=process.env.EXPORT_TEST_INDEX;
    const jobs=new SequenceExports(async input=>{
      writeFileSync(join(root,'encoded-'+index),input.status.id);
      await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('stop')),{once:true}));
    });
    const clock=new Int32Array(new SharedArrayBuffer(4));
    try {
      const result=jobs.start(root,'case','http://127.0.0.1',{sessionId:'shared',expectedRevision:0,executionId:'start-'+index},()=>{
        writeFileSync(join(root,'ready-'+index),'ready');
        while(!existsSync(join(root,'release')))Atomics.wait(clock,0,0,10);
        return ${JSON.stringify(state)};
      });process.send({accepted:true,id:result.id,index});
    }catch(error){process.send({accepted:false,status:error.status,error:error.message,index});}
    setInterval(()=>{},1000);`;
  const children=Array.from({length:4},(_,index)=>{
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{
      env:{...process.env,EXPORT_TEST_ROOT:root,EXPORT_TEST_INDEX:String(index)},stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk;});const closed=once(child,'close');
    const result=Promise.race([once(child,'message').then(value=>value[0] as {accepted:boolean;id?:string;status?:number;index:string}),closed.then(()=>{throw new Error(stderr||'child exited before result');})]);
    return {child,closed,result};
  });
  try {
    await vi.waitFor(async()=>expect((await readdir(root)).filter(file=>file.startsWith('ready-'))).toHaveLength(4),{timeout:10000,interval:25});
    // Every child is now inside snapshot(), after the old non-atomic list check.
    await writeFile(join(root,'release'),'start');const results=await Promise.all(children.map(child=>child.result));
    expect(results.filter(result=>result.accepted)).toHaveLength(1);expect(results.filter(result=>result.status===409)).toHaveLength(3);
    expect((await readdir(root)).filter(file=>file.startsWith('encoded-'))).toHaveLength(1);
    const winner=results.find(result=>result.accepted)!;
    expect(activeExportAdmission(root)?.jobId).toBe(winner.id);
    const observer=new SequenceExports();expect(observer.list(root)).toHaveLength(1);expect(observer.get('case',root)).toEqual({phase:'queued'});
    children[Number(winner.index)]!.child.kill('SIGKILL');await children[Number(winner.index)]!.closed;
    const next=new SequenceExports(async input=>{
      await writeFile(join(input.directory,'output.mp4'),'fixture');
      await writeFile(join(input.directory,'verification.json'),JSON.stringify({revision:input.status.revision,contentHash:input.status.contentHash,settings:input.settings,outputResolution:input.status.outputResolution}));
    });
    const started=next.start(root,'case','http://127.0.0.1',{sessionId:'shared',expectedRevision:0,executionId:'after-death'},()=>state);
    await next.job(root,started.id).completion;expect(next.lookup(root,'after-death')?.phase).toBe('complete');
    expect(next.lookup(root,'start-'+winner.index)?.phase).toBe('failed');expect(activeExportAdmission(root)).toBeUndefined();
    expect(await readFile(await next.download(root,started.id),'utf8')).toBe('fixture');
  }finally{
    for(const {child} of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await Promise.all(children.map(child=>child.closed));await rm(root,{recursive:true,force:true});
  }
},20000);
it('keeps an identical request unresolved before input publication and permits starts after an explicit release',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-export-admission-pending-')),jobId=exportJobId('pending');
  try {
    const release=acquireExportAdmission(root,jobId);
    expect(()=>acquireExportAdmission(root,jobId)).toThrow(expect.objectContaining({status:503}));
    expect(()=>acquireExportAdmission(root,exportJobId('other'))).toThrow(expect.objectContaining({status:409}));
    release();release();expect(activeExportAdmission(root)).toBeUndefined();
    acquireExportAdmission(root,exportJobId('other'))();expect(activeExportAdmission(root)).toBeUndefined();
  }finally{await rm(root,{recursive:true,force:true});}
});
it('does not treat a reused PID as a live admission',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-export-admission-pid-')),folder=join(root,'.harness/exports/.admissions');
  const stale=(epoch:number,pid:number,jobId:string)=>writeFile(join(folder,`${String(epoch).padStart(16,'0')}.json`),JSON.stringify({version:1,epoch,pid,token:randomUUID(),jobId}));
  try {
    await mkdir(folder,{recursive:true});await stale(1,process.pid,'a'.repeat(32));
    expect(activeExportAdmission(root)).toBeUndefined();
    const release=acquireExportAdmission(root,'b'.repeat(32));
    expect(activeExportAdmission(root)).toMatchObject({epoch:2,pid:process.pid,jobId:'b'.repeat(32)});
    expect(()=>acquireExportAdmission(root,'c'.repeat(32))).toThrow(/進行中/);
    release();expect(activeExportAdmission(root)).toBeUndefined();
    await stale(3,424242,'d'.repeat(32));
    const kill=vi.spyOn(process,'kill').mockImplementation(pid=>{if(pid===424242)throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});return true;});
    try{expect(activeExportAdmission(root)).toBeUndefined();acquireExportAdmission(root,'e'.repeat(32))();}finally{kill.mockRestore();}
  }finally{await rm(root,{recursive:true,force:true});}
});
it('sees an admission held by another loaded copy of this module',async()=>{
  const root=await mkdtemp(join(tmpdir(),'native-export-admission-copy-'));
  vi.resetModules();const copy=await import('./exportAdmission');
  try {
    const release=copy.acquireExportAdmission(root,'f'.repeat(32));
    expect(activeExportAdmission(root)).toMatchObject({jobId:'f'.repeat(32)});
    expect(()=>acquireExportAdmission(root,'0'.repeat(32))).toThrow(/進行中/);
    release();expect(activeExportAdmission(root)).toBeUndefined();
  }finally{await rm(root,{recursive:true,force:true});}
});
