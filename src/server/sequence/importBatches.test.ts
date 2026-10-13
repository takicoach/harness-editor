// src/server/sequence/importBatches.test.ts
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {MAIN_SPEED_REFUSAL} from '../../core/sequence/mainAppend';
import {SequenceService} from './service';
import {SequenceStore} from './store';
import {buildEmptyDocument} from './createDocuments';
import {ImportBatches,type PrepareImportAsset} from './importBatches';

const fake=(name:string,seconds=1):SequenceAsset=>{const fingerprint=name.replace(/\W/g,'').padEnd(64,'a').slice(0,64);
  return {id:`media-${fingerprint.slice(0,24)}`,kind:'media',file:`.harness/references/${fingerprint}.mp4`,name,fingerprint,streams:name.includes('voice')
    ?[{index:0,kind:'audio',codec:'aac',duration:r(seconds),sampleRate:48000,channels:2}]
    :[{index:0,kind:'video',codec:'h264',duration:r(seconds),frameRate:r(30),width:160,height:90},{index:1,kind:'audio',codec:'aac',duration:r(seconds),sampleRate:48000,channels:2}]};};
let dir='',sessions:SequenceService,gates:Map<string,()=>void>,prepared:Map<string,SequenceAsset>;
const prepare:PrepareImportAsset=async({name,path,signal,hooks})=>{
  hooks.onPhase?.('probing');const asset=fake(name,name.includes('long')?2:1);hooks.onProbed?.(asset.streams);hooks.onPhase?.('fingerprinting');
  await new Promise<void>((resolve,reject)=>{if(!name.includes('slow'))return resolve();gates.set(name,resolve);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  if(path.includes('broken'))throw new Error('素材の長さを確認できません');prepared.set(asset.id,asset);return asset;
};
const make=()=>new ImportBatches(prepare,async(_root,assetId)=>prepared.get(assetId));
const items=(...names:string[])=>names.map((name,index)=>({key:String(index),name,source:{kind:'path' as const,path:`/media/${name}`}}));
const input=(names:string[],requestId='r1')=>({requestId,projectId:'case',origin:{kind:'ui' as const},mode:'link' as const,items:items(...names)});
/** 同期で投げる失敗の中身（status・reason）を確かめる。 */
const caught=(run:()=>unknown):unknown=>{try{run();}catch(error){return error;}throw new Error('例外が投げられませんでした');};
const release=async(name:string)=>{await vi.waitFor(()=>expect(gates.has(name)).toBe(true));gates.get(name)!();};
beforeEach(()=>{
  dir=realpathSync(mkdtempSync(join(tmpdir(),'import-batches-')));gates=new Map();prepared=new Map();sessions=new SequenceService();
  new SequenceStore(dir).save({document:buildEmptyDocument('空',()=>'doc'),expectedSavedRevision:null,executionId:'seed'});
});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});});

it('fixes the natural name order at acceptance, regardless of the completion order',async()=>{
  const batches=make(),view=batches.create(dir,input(['take10-slow.mp4','take2.mp4','take9.mp4']));
  expect(view.items.map(i=>[i.itemId,i.name])).toEqual([['i0','take2.mp4'],['i1','take9.mp4'],['i2','take10-slow.mp4']]);
  await vi.waitFor(()=>expect(batches.get(dir,view.batchId).items.filter(i=>i.phase==='ready')).toHaveLength(2));
  expect(batches.get(dir,view.batchId).phase).toBe('preparing');await release('take10-slow.mp4');await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'ready',items:[{durationSeconds:1},{durationSeconds:1},{durationSeconds:1}]});
});
it('confirms once as one edit at the latest main end, and one Undo removes all',async()=>{
  const saved=readFileSync(join(dir,'.harness/project.v2.json'),'utf8');
  const batches=make(),view=batches.create(dir,input(['b.mp4','a.mp4']));await batches.idle(dir,view.batchId);
  const state=sessions.open(dir);
  expect(state.document.revision).toBe(0);expect(readFileSync(join(dir,'.harness/project.v2.json'),'utf8')).toBe(saved);
  const done=await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c1'},sessions);
  expect(done.document.clips.filter(c=>c.trackId==='v-main').map(c=>[c.id,c.startFrame,c.name])).toEqual([[`${view.batchId}-2`,0,'a.mp4'],[`${view.batchId}-5`,30,'b.mp4']]);
  expect(done.appliedRevision).toBe(1);expect(batches.get(dir,view.batchId)).toMatchObject({phase:'confirmed',confirmed:{executionId:'c1',revision:1}});
  expect(await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c1'},sessions)).toMatchObject({replayed:true});
  await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c2'},sessions)).rejects.toMatchObject({status:409,reason:'IMPORT_CONFIRMED'});
  const undone=sessions.execute(dir,{sessionId:state.sessionId,expectedRevision:1,executionId:'u',command:{type:'undo'}});
  expect(undone.document.clips).toEqual([]);expect(undone.document.fps).toEqual(r(30));
  await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c3'},sessions)).rejects.toMatchObject({reason:'IMPORT_CONFIRMED'});
});
it('refuses while preparing, refuses partial unless failed items are skipped, and places the rest in order',async()=>{
  const batches=make(),view=batches.create(dir,input(['a.mp4','b-broken.mp4','c-slow.mp4'])),state=sessions.open(dir);
  await vi.waitFor(()=>expect(batches.get(dir,view.batchId).items[1]!.phase).toBe('failed'));
  await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'x'},sessions)).rejects.toMatchObject({reason:'IMPORT_NOT_READY'});
  await release('c-slow.mp4');await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'partial',items:[{phase:'ready'},{phase:'failed',error:'素材の長さを確認できません'},{phase:'ready'}]});
  await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'y'},sessions)).rejects.toMatchObject({reason:'IMPORT_PARTIAL'});
  const done=await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'z',skipFailed:true},sessions);
  expect(done.document.clips.filter(c=>c.trackId==='v-main').map(c=>c.name)).toEqual(['a.mp4','c-slow.mp4']);
});
it('re-evaluates the main end at confirm time after edits made while preparing (an Undo during the import)',async()=>{
  const batches=make(),first=batches.create(dir,input(['a.mp4'],'r-a'));await batches.idle(dir,first.batchId);
  const state=sessions.open(dir);await batches.confirm(dir,first.batchId,{sessionId:state.sessionId,executionId:'c-a'},sessions);
  const second=batches.create(dir,input(['b-slow.mp4'],'r-b'));
  sessions.execute(dir,{sessionId:state.sessionId,expectedRevision:1,executionId:'undo-a',command:{type:'undo'}});
  await release('b-slow.mp4');await batches.idle(dir,second.batchId);
  const done=await batches.confirm(dir,second.batchId,{sessionId:state.sessionId,executionId:'c-b'},sessions);
  expect(done.document.clips.filter(c=>c.trackId==='v-main').map(c=>[c.startFrame,c.name])).toEqual([[0,'b-slow.mp4']]);
});
it('cancels during preparation, aborts the work, and never places a cancelled batch',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4'])),state=sessions.open(dir);
  await vi.waitFor(()=>expect(gates.has('a-slow.mp4')).toBe(true));
  expect(batches.cancel(dir,view.batchId)).toMatchObject({phase:'cancelled',items:[{phase:'cancelled'}]});await batches.idle(dir,view.batchId);
  await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c'},sessions)).rejects.toMatchObject({reason:'IMPORT_CANCELLED'});
  expect(sessions.open(dir).document.clips).toEqual([]);
});
it('refuses to cancel while confirming',async()=>{
  let release!:()=>void;const slow=new ImportBatches(prepare,async(_root,assetId)=>{await new Promise<void>(done=>{release=done;});return prepared.get(assetId);});
  const view=slow.create(dir,input(['a.mp4'])),state=sessions.open(dir);await slow.idle(dir,view.batchId);
  const confirming=slow.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c'},sessions);
  expect(caught(()=>slow.cancel(dir,view.batchId))).toMatchObject({status:409,reason:'IMPORT_CONFIRMING'});release();await confirming;
});
it('refuses a speed-registered project, keeps the batch open, and never executes',async()=>{
  const batches=make(),view=batches.create(dir,input(['a.mp4']));await batches.idle(dir,view.batchId);
  const execute=vi.fn(),speedSessions={open:()=>({sessionId:'s',document:{...buildEmptyDocument('速度',()=>'doc'),speed:{} as never}}),execute} as unknown as SequenceService;
  await expect(batches.confirm(dir,view.batchId,{sessionId:'s',executionId:'c'},speedSessions)).rejects.toMatchObject({status:409,message:MAIN_SPEED_REFUSAL,reason:'SPEED_REGISTERED'});
  expect(batches.get(dir,view.batchId).phase).toBe('ready');expect(execute).not.toHaveBeenCalled();
});
it('reuses a batch for the same request and refuses different content under the same request ID',()=>{
  const batches=make(),a=batches.create(dir,input(['a.mp4'])),again=batches.create(dir,input(['a.mp4']));
  expect(again.batchId).toBe(a.batchId);
  expect(caught(()=>batches.create(dir,input(['b.mp4'])))).toMatchObject({status:409,reason:'IMPORT_REQUEST_CONFLICT'});
});
it('after a server restart, unfinished items fail with a reason and finished ones stay ready',async()=>{
  const first=make(),view=first.create(dir,input(['a.mp4','b-slow.mp4']));await vi.waitFor(()=>expect(first.get(dir,view.batchId).items[0]!.phase).toBe('ready'));
  const restarted=make();
  expect(restarted.get(dir,view.batchId)).toMatchObject({phase:'partial',items:[{phase:'ready'},{phase:'failed',error:'サーバーが停止したため取り込みを中断しました。もう一度追加してください'}]});
  first.cancel(dir,view.batchId);
});
it('waits for client items, accepts each delivery once, and notifies listeners',async()=>{
  const batches=make(),listener=vi.fn(),stop=batches.subscribe(dir,listener);
  const view=batches.create(dir,{...input([]),mode:'copy',items:[{key:'0',name:'a.mp4',source:{kind:'client'}}]});
  expect(view.items[0]!.phase).toBe('waiting');const cleanup=vi.fn(async()=>{});
  batches.deliverFile(dir,view.batchId,'i0',{path:'/tmp/upload/a.mp4',cleanup});
  expect(caught(()=>batches.deliverFile(dir,view.batchId,'i0',{path:'/tmp/upload/a.mp4',cleanup:async()=>{}}))).toMatchObject({status:409,reason:'IMPORT_DELIVERED'});
  await batches.idle(dir,view.batchId);expect(batches.get(dir,view.batchId).phase).toBe('ready');expect(cleanup).toHaveBeenCalledTimes(1);
  expect(listener).toHaveBeenCalled();stop();
});
it('refuses non-video names and too many items',()=>{
  const batches=make();
  expect(caught(()=>batches.create(dir,input(['song.mp3'])))).toMatchObject({status:400});
  expect(caught(()=>batches.create(dir,input(Array.from({length:51},(_,i)=>`t${i}.mp4`))))).toMatchObject({status:400});
});
it('runs link registrations of one project one at a time (the reference ledger lock) and copies in parallel',async()=>{
  let active=0,most=0;const counting:PrepareImportAsset=async options=>{active++;most=Math.max(most,active);try{return await prepare(options);}finally{active--;}};
  const linked=new ImportBatches(counting,async(_root,assetId)=>prepared.get(assetId)),view=linked.create(dir,input(['a-slow.mp4','b-slow.mp4']));
  await release('a-slow.mp4');await release('b-slow.mp4');await linked.idle(dir,view.batchId);expect(most).toBe(1);
  most=0;const copied=new ImportBatches(counting,async(_root,assetId)=>prepared.get(assetId)),copy=copied.create(dir,{...input(['c-slow.mp4','d-slow.mp4'],'r-copy'),mode:'copy'});
  await vi.waitFor(()=>expect(gates.has('c-slow.mp4')&&gates.has('d-slow.mp4')).toBe(true));expect(most).toBe(2);
  await release('c-slow.mp4');await release('d-slow.mp4');await copied.idle(dir,copy.batchId);
});
it('keeps serving the project when a record cannot be written or read (the work goes on in memory, broken records skipped)',async()=>{
  const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  try{
    const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b.mp4']));await vi.waitFor(()=>expect(gates.has('a-slow.mp4')).toBe(true));
    rmSync(join(dir,'.harness/imports'),{recursive:true,force:true});writeFileSync(join(dir,'.harness/imports'),'not a folder');
    await release('a-slow.mp4');await batches.idle(dir,view.batchId);
    expect(error).toHaveBeenCalledWith('[sme] 取り込みの段を記録できません:',expect.any(Error));
    rmSync(join(dir,'.harness/imports'),{force:true});mkdirSync(join(dir,'.harness/imports'));writeFileSync(join(dir,'.harness/imports/imp-00000000000000000000.json'),'{broken');
    const fresh=make(),created=fresh.create(dir,input(['b.mp4'],'r-after'));
    expect(fresh.list(dir).map(batch=>batch.batchId)).toEqual([created.batchId]);await fresh.idle(dir,created.batchId);
  }finally{error.mockRestore();}
});

// ---- レビュー1回目の修正 ----
const imports=()=>join(dir,'.harness/imports');
/** 記録先を読み取り専用にして書き込みを失敗させる（記録は消さない）。 */
const lock=(on:boolean)=>chmodSync(imports(),on?0o500:0o700);
const record=(patch:Record<string,unknown>)=>({version:1,batchId:'imp-aaaaaaaaaaaaaaaaaaaa',projectId:'case',createdAt:new Date().toISOString(),requestId:'r-x',requestKey:'a'.repeat(64),
  origin:{kind:'ui'},mode:'link',placement:'append-main',state:'open',items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready',assetId:'media-x',durationSeconds:1}],...patch});
const quiet=()=>vi.spyOn(console,'error').mockImplementation(()=>undefined);
it('never writes through a link planted at a temporary record name (a crafted project)',()=>{
  const outside=join(dir,'outside.txt'),batchId='imp-0123456789abcdef0123';writeFileSync(outside,'keep');mkdirSync(imports());
  writeFileSync(join(imports(),`${batchId}.json`),JSON.stringify(record({batchId,items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'probing'}]})));
  symlinkSync(outside,join(imports(),`${batchId}.tmp`));
  expect(make().get(dir,batchId).items[0]).toMatchObject({phase:'failed'});
  expect(readFileSync(outside,'utf8')).toBe('keep');
  expect(JSON.parse(readFileSync(join(imports(),`${batchId}.json`),'utf8')).items[0].phase).toBe('failed');
});
it('a failed write leaves the state as it was and returns that error (confirming, cancelling)',async()=>{
  const batches=make(),view=batches.create(dir,input(['a.mp4'])),state=sessions.open(dir);await batches.idle(dir,view.batchId);
  lock(true);
  try{
    await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c'},sessions)).rejects.toMatchObject({code:'EACCES'});
    expect(batches.get(dir,view.batchId).phase).toBe('ready');
    expect(caught(()=>batches.cancel(dir,view.batchId))).toMatchObject({code:'EACCES'});
    expect(batches.get(dir,view.batchId).phase).toBe('ready');
  }finally{lock(false);}
  expect(sessions.open(dir).document.clips).toEqual([]);
  expect((await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c'},sessions)).document.clips.filter(c=>c.trackId==='v-main')).toHaveLength(1);
});
it('writes the confirmed mark before placing: a failed mark places nothing, and a placed batch is not placed again after a restart',async()=>{
  const error=quiet();let breakOnResolve=true;
  try{
    const batches=new ImportBatches(prepare,async(_root,assetId)=>{if(breakOnResolve)lock(true);return prepared.get(assetId);});
    const view=batches.create(dir,input(['a.mp4'])),state=sessions.open(dir);await batches.idle(dir,view.batchId);
    try{await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c1'},sessions)).rejects.toMatchObject({code:'EACCES'});}finally{lock(false);}
    expect(sessions.open(dir).document.clips).toEqual([]);expect(batches.get(dir,view.batchId).phase).toBe('ready');
    breakOnResolve=false;
    const done=await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c2'},sessions);
    expect(done.document.clips.filter(c=>c.trackId==='v-main')).toHaveLength(1);
    sessions.execute(dir,{sessionId:state.sessionId,expectedRevision:done.document.revision,executionId:'u',command:{type:'undo'}});
    const restarted=make();expect(restarted.get(dir,view.batchId)).toMatchObject({phase:'confirmed',confirmed:{executionId:'c2',revision:1}});
    await expect(restarted.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c3'},sessions)).rejects.toMatchObject({reason:'IMPORT_CONFIRMED'});
  }finally{error.mockRestore();}
});
it('keeps the original error when the state cannot be written back',async()=>{
  const error=quiet();
  try{
    const batches=new ImportBatches(prepare,async(_root,assetId)=>{lock(true);return prepared.get(assetId);}),view=batches.create(dir,input(['a.mp4']));await batches.idle(dir,view.batchId);
    const speedSessions={open:()=>({sessionId:'s',document:{...buildEmptyDocument('速度',()=>'doc'),speed:{} as never}}),execute:vi.fn()} as unknown as SequenceService;
    try{await expect(batches.confirm(dir,view.batchId,{sessionId:'s',executionId:'c'},speedSessions)).rejects.toMatchObject({reason:'SPEED_REGISTERED'});}finally{lock(false);}
    expect(batches.get(dir,view.batchId).phase).toBe('ready');
  }finally{error.mockRestore();}
});
it('starts the work before tidying old records, and a failed tidy-up does not stop the new batch',async()=>{
  const error=quiet(),batches=make();
  try{
    for(let i=0;i<51;i++){const old=batches.create(dir,input(['x.mp4'],`old-${i}`));batches.cancel(dir,old.batchId);}
    // コピーの束は受け渡しの時点で準備が始まり、最初の通知が後始末より前に来る。その通知で記録先を読み取り専用にし、後始末（rmSync）を失敗させる。
    let arm=true;const stop=batches.subscribe(dir,()=>{if(arm){arm=false;lock(true);}});
    let view:ReturnType<ImportBatches['create']>;try{view=batches.create(dir,{...input(['new.mp4'],'new'),mode:'copy'});}finally{lock(false);stop();}
    expect(arm).toBe(false);expect(error).toHaveBeenCalledWith('[sme] 古い取り込みの記録を片付けられません:',expect.objectContaining({code:'EACCES'}));
    await batches.idle(dir,view.batchId);expect(batches.get(dir,view.batchId).phase).toBe('ready');
  }finally{error.mockRestore();}
});
it('does not bring back a deleted project folder',async()=>{
  const error=quiet();
  try{
    const batches=make();batches.create(dir,input(['a-slow.mp4']));await vi.waitFor(()=>expect(gates.has('a-slow.mp4')).toBe(true));
    rmSync(dir,{recursive:true,force:true});gates.get('a-slow.mp4')!();
    await vi.waitFor(()=>expect(error).toHaveBeenCalledWith('[sme] 取り込みの段を記録できません:',expect.any(Error)));
    expect(existsSync(dir)).toBe(false);
  }finally{error.mockRestore();}
});
it('skips records whose content does not match the record shape',()=>{
  const error=quiet();
  try{
    mkdirSync(imports());writeFileSync(join(imports(),'imp-aaaaaaaaaaaaaaaaaaaa.json'),JSON.stringify(record({})));
    const broken:Array<[string,Record<string,unknown>]>=[['imp-bbbbbbbbbbbbbbbbbbbb',{state:'weird'}],['imp-cccccccccccccccccccc',{origin:{kind:'agent'}}],
      ['imp-dddddddddddddddddddd',{items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready',durationSeconds:'1'}]}],['imp-eeeeeeeeeeeeeeeeeeee',{items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'done'}]}]];
    for(const [batchId,patch] of broken)writeFileSync(join(imports(),`${batchId}.json`),JSON.stringify(record({batchId,...patch})));
    expect(make().list(dir).map(batch=>batch.batchId)).toEqual(['imp-aaaaaaaaaaaaaaaaaaaa']);
  }finally{error.mockRestore();}
});
it('limits the name length',()=>{
  const batches=make();
  expect(caught(()=>batches.create(dir,input([`${'a'.repeat(252)}.mp4`])))).toMatchObject({status:400});
  expect(batches.create(dir,input([`${'a'.repeat(251)}.mp4`],'r-255')).items[0]!.name).toHaveLength(255);
});
it('refuses an origin that could not be read back',()=>{
  expect(caught(()=>make().create(dir,{...input(['a.mp4']),origin:{kind:'agent',operationId:''}}))).toMatchObject({status:400});
});
it('names a linked item after the real file, not the name the screen sent',async()=>{
  const names:string[]=[],batches=new ImportBatches(async options=>{names.push(options.name);return prepare(options);},async(_root,assetId)=>prepared.get(assetId));
  const fromPath=batches.create(dir,{...input([]),items:[{key:'0',name:'claimed.mp4',source:{kind:'path',path:'/media/real-take.mp4'}}]});
  expect(fromPath.items[0]!.name).toBe('real-take.mp4');await batches.idle(dir,fromPath.batchId);
  const client=batches.create(dir,{...input([],'r-client'),items:[{key:'0',name:'a.mp4',source:{kind:'client'}},{key:'1',name:'b.mp4',source:{kind:'client'}}]});
  expect(caught(()=>batches.deliverPath(dir,client.batchId,'i0','/media/song.mp3'))).toMatchObject({status:400});
  // 画面は渡せなかった素材を失敗にする（束の全項目の判定が終わってから登録へ並べるため。slow-media Task 13）
  batches.deliverPath(dir,client.batchId,'i1','/media/real-b.mp4');batches.abandon(dir,client.batchId,['i0']);await batches.idle(dir,client.batchId);
  expect(names).toEqual(['real-take.mp4','real-b.mp4']);
});
it('treats a batch left confirming whose clips are already in the document as placed (no second placement)',async()=>{
  const first=make(),view=first.create(dir,input(['a.mp4']));await first.idle(dir,view.batchId);const state=sessions.open(dir);
  await first.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c1'},sessions);
  const path=join(imports(),`${view.batchId}.json`),saved=JSON.parse(readFileSync(path,'utf8'));delete saved.confirmed;saved.state='confirming';writeFileSync(path,JSON.stringify(saved));
  const restarted=make();expect(restarted.get(dir,view.batchId).phase).toBe('ready');
  const again=await restarted.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c2'},sessions);
  expect(again).toMatchObject({replayed:true,changed:false});expect(again.document.clips.filter(c=>c.trackId==='v-main')).toHaveLength(1);
  expect(restarted.get(dir,view.batchId)).toMatchObject({phase:'confirmed',confirmed:{executionId:'c2',revision:1}});
});
// 同じ確定の再送（同じ実行 ID・同じ本文）は配置の結果を受け取る（下の 'a re-sent confirm with the same execution ID ...'）。ここは別の確定。
it('refuses a second confirm while the first is placing',async()=>{
  let release!:()=>void;const slow=new ImportBatches(prepare,async(_root,assetId)=>{await new Promise<void>(done=>{release=done;});return prepared.get(assetId);});
  const view=slow.create(dir,input(['a.mp4'])),state=sessions.open(dir);await slow.idle(dir,view.batchId);
  const first=slow.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c'},sessions);
  await expect(slow.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c2'},sessions)).rejects.toMatchObject({status:409,reason:'IMPORT_CONFIRMING'});
  release();await first;
});

// ---- 再レビューの Minor ----
it('trims a long failure reason before saving, so the batch is still listed after a restart',async()=>{
  const failing=new ImportBatches(async()=>{throw new Error(`ffprobe: ${'x'.repeat(13000)}`);},async()=>undefined),view=failing.create(dir,input(['a.mp4']));
  await failing.idle(dir,view.batchId);
  const listed=make().list(dir);
  expect(listed.map(batch=>batch.batchId)).toEqual([view.batchId]);
  expect(listed[0]!.items[0]!.phase).toBe('failed');expect(listed[0]!.items[0]!.error!.length).toBeLessThanOrEqual(1001);expect(listed[0]!.items[0]!.error).toMatch(/^ffprobe: x+…$/);
});
it('refuses a stale session before writing the confirmed mark',async()=>{
  const batches=make(),view=batches.create(dir,input(['a.mp4']));await batches.idle(dir,view.batchId);sessions.open(dir);
  await expect(batches.confirm(dir,view.batchId,{sessionId:'stale-tab',executionId:'c'},sessions)).rejects.toMatchObject({status:409,reason:'REVISION_CONFLICT'});
  expect(batches.get(dir,view.batchId).phase).toBe('ready');
  const saved=JSON.parse(readFileSync(join(imports(),`${view.batchId}.json`),'utf8'));expect(saved.state).toBe('open');expect(saved.confirmed).toBeUndefined();
});
it('sweeps temporary records left for over an hour, and keeps recent ones and the records themselves',()=>{
  const batches=make(),view=batches.create(dir,input(['a.mp4']));
  const old=join(imports(),`${view.batchId}.00000000-0000-4000-8000-000000000000.tmp`),recent=join(imports(),`${view.batchId}.11111111-1111-4111-8111-111111111111.tmp`),legacy=join(imports(),`${view.batchId}.tmp`);
  for(const path of [old,recent,legacy])writeFileSync(path,'{');
  const hoursAgo=new Date(Date.now()-2*60*60*1000);utimesSync(old,hoursAgo,hoursAgo);utimesSync(legacy,hoursAgo,hoursAgo);
  expect(make().list(dir).map(batch=>batch.batchId)).toEqual([view.batchId]);
  expect(readdirSync(imports()).sort()).toEqual([`${view.batchId}.11111111-1111-4111-8111-111111111111.tmp`,`${view.batchId}.json`].sort());
});

// ---- Task 7: 音声だけの動画ファイル・画面が送れなかった素材 ----
it('registers an audio-only video file without placing it, in the same single edit as the videos',async()=>{
  const batches=make(),view=batches.create(dir,input(['b.mp4','a-voice.mp4']));await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'ready',items:[{name:'a-voice.mp4',phase:'ready',audioOnly:true},{name:'b.mp4',phase:'ready'}]});
  expect(batches.get(dir,view.batchId).items[1]!.audioOnly).toBeUndefined();
  const state=sessions.open(dir),done=await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c'},sessions);
  expect(done.appliedRevision).toBe(1);
  expect(done.document.clips.map(c=>c.name)).toEqual(['b.mp4','b.mp4 原音']);expect(done.document.clips.find(c=>c.content.kind==='video')!.startFrame).toBe(0);
  expect(done.document.assets.map(a=>a.name).sort()).toEqual(['a-voice.mp4','b.mp4']);
  // 書式は映像のある動画で決める（音声だけの素材は書式の決定に使わない）
  expect(done.document.resolution).toEqual({width:160,height:90});
  const undone=sessions.execute(dir,{sessionId:state.sessionId,expectedRevision:1,executionId:'u',command:{type:'undo'}});
  expect(undone.document.clips).toEqual([]);expect(undone.document.assets).toEqual([]);
});
it('a batch of only audio-only files registers them and places nothing, even in a speed-registered project, and does not register twice',async()=>{
  const batches=make(),view=batches.create(dir,input(['voice.mp4']));await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).phase).toBe('ready');
  const state=sessions.open(dir),done=await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c'},sessions);
  expect(done.document.clips).toEqual([]);expect(done.document.assets.map(a=>a.name)).toEqual(['voice.mp4']);expect(done.appliedRevision).toBe(1);
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'confirmed',confirmed:{executionId:'c',revision:1}});
  // 同じ素材がすでに一覧にある時は編集をせずに確定済みにする
  const again=batches.create(dir,input(['voice.mp4'],'r2'));await batches.idle(dir,again.batchId);
  const second=await batches.confirm(dir,again.batchId,{sessionId:state.sessionId,executionId:'c2'},sessions);
  expect(second).toMatchObject({changed:false,appliedRevision:1});expect(sessions.open(dir).document.revision).toBe(1);
  expect(batches.get(dir,again.batchId)).toMatchObject({phase:'confirmed',confirmed:{executionId:'c2',revision:1}});
  const execute=vi.fn(()=>sessions.open(dir)),speedSessions={open:()=>({sessionId:'s',document:{...buildEmptyDocument('速度',()=>'doc'),speed:{} as never}}),execute} as unknown as SequenceService;
  const third=batches.create(dir,input(['speed-voice.mp4'],'r3'));await batches.idle(dir,third.batchId);
  await batches.confirm(dir,third.batchId,{sessionId:'s',executionId:'c3'},speedSessions);
  expect(execute).toHaveBeenCalledTimes(1);expect((execute.mock.calls[0] as unknown as [string,{command:{type:string}}])[1].command.type).toBe('register-assets');
});
it('marks client items the screen could not deliver as failed, so the delivered rest can be placed',async()=>{
  const batches=make(),client=(name:string,key:string)=>({key,name,source:{kind:'client' as const}});
  const view=batches.create(dir,{...input([]),mode:'copy',items:[client('a.mp4','0'),client('b.mp4','1'),client('c.mp4','2')]});
  batches.deliverFile(dir,view.batchId,'i1',{path:'/tmp/upload/b.mp4',cleanup:async()=>{}});
  const abandoned=batches.abandon(dir,view.batchId,['i0','i1']);
  expect(abandoned.items.map(i=>i.phase)).toEqual(['failed',expect.stringMatching(/probing|fingerprinting|ready|waiting/),'waiting']);
  expect(abandoned.items[0]!.error).toBe('動画を受け取れませんでした。もう一度追加してください');
  expect(caught(()=>batches.deliverFile(dir,view.batchId,'i0',{path:'/tmp/upload/a.mp4',cleanup:async()=>{}}))).toMatchObject({status:409,reason:'IMPORT_DELIVERED'});
  batches.abandon(dir,view.batchId,['i2']);await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).phase).toBe('partial');
  // 再起動後も失敗のまま（記録に書いてある）
  expect(make().get(dir,view.batchId).items.map(i=>i.phase)).toEqual(['failed','ready','failed']);
  const state=sessions.open(dir),done=await batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c',skipFailed:true},sessions);
  expect(done.document.clips.filter(c=>c.trackId==='v-main').map(c=>c.name)).toEqual(['b.mp4']);
  expect(caught(()=>batches.abandon(dir,view.batchId,['i9']))).toMatchObject({status:404});
});
it('leaves a cancelled batch as it is when the screen reports undelivered items',()=>{
  const batches=make(),view=batches.create(dir,{...input([]),mode:'copy',items:[{key:'0',name:'a.mp4',source:{kind:'client'}}]});
  batches.cancel(dir,view.batchId);
  expect(batches.abandon(dir,view.batchId,['i0'])).toMatchObject({phase:'cancelled',items:[{phase:'cancelled'}]});
});
it('tells the preparation which sources were resolved at acceptance (paths) and which were not (uploaded files)',async()=>{
  const seen=new Map<string,boolean|undefined>(),batches=new ImportBatches(async input=>{seen.set(input.path,input.resolvedSource);return prepare(input);},async(_root,assetId)=>prepared.get(assetId));
  const path=batches.create(dir,input(['a.mp4']));await batches.idle(dir,path.batchId);
  const client=batches.create(dir,{requestId:'r2',projectId:'case',origin:{kind:'ui'},mode:'link',items:[{key:'0',name:'b.mp4',source:{kind:'client'}}]});
  batches.deliverPath(dir,client.batchId,'i0','/media/b.mp4');await batches.idle(dir,client.batchId);
  const copy=batches.create(dir,{requestId:'r3',projectId:'case',origin:{kind:'ui'},mode:'copy',items:[{key:'0',name:'c.mp4',source:{kind:'client'}}]});
  batches.deliverFile(dir,copy.batchId,'i0',{path:'/tmp/upload/c.mp4',cleanup:async()=>{}});await batches.idle(dir,copy.batchId);
  expect(Object.fromEntries(seen)).toEqual({'/media/a.mp4':true,'/media/b.mp4':true,'/tmp/upload/c.mp4':false});
});
it('a re-sent confirm with the same execution ID while placing receives the same result and places once; another execution ID is still refused as placing',async()=>{
  let release!:()=>void;const slow=new ImportBatches(prepare,async(_root,assetId)=>{await new Promise<void>(done=>{release=done;});return prepared.get(assetId);});
  const view=slow.create(dir,input(['a.mp4'])),state=sessions.open(dir);await slow.idle(dir,view.batchId);
  const request={sessionId:state.sessionId,executionId:'c-twice'};
  const first=slow.confirm(dir,view.batchId,request,sessions),second=slow.confirm(dir,view.batchId,{...request},sessions);
  await expect(slow.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c-other'},sessions)).rejects.toMatchObject({status:409,reason:'IMPORT_CONFIRMING'});
  await expect(slow.confirm(dir,view.batchId,{...request,skipFailed:true},sessions)).rejects.toMatchObject({status:409,reason:'IMPORT_CONFIRMING'});
  await expect(slow.confirm(dir,view.batchId,{...request,sessionId:'another-session'},sessions)).rejects.toMatchObject({status:409,reason:'IMPORT_CONFIRMING'});
  release();const [a,b]=await Promise.all([first,second]);
  expect(b).toStrictEqual(a);expect(a).toMatchObject({appliedRevision:1,changed:true});
  expect(sessions.open(dir).document.clips.filter(c=>c.trackId==='v-main')).toHaveLength(1);
  expect(slow.get(dir,view.batchId)).toMatchObject({phase:'confirmed',confirmed:{executionId:'c-twice',revision:1}});
});
it('after a failed confirm the waiting re-send gets the same failure, and the next re-send with the same execution ID places it',async()=>{
  let gate!:()=>void,missing=true;
  const flaky=new ImportBatches(prepare,async(_root,assetId)=>{await new Promise<void>(done=>{gate=done;});if(missing){missing=false;return undefined;}return prepared.get(assetId);});
  const view=flaky.create(dir,input(['a.mp4'])),state=sessions.open(dir);await flaky.idle(dir,view.batchId);
  const request={sessionId:state.sessionId,executionId:'c-retry'};
  const first=flaky.confirm(dir,view.batchId,request,sessions),second=flaky.confirm(dir,view.batchId,request,sessions);
  gate();
  await expect(first).rejects.toMatchObject({status:409,reason:'IMPORT_ASSET_MISSING'});await expect(second).rejects.toMatchObject({status:409,reason:'IMPORT_ASSET_MISSING'});
  expect(flaky.get(dir,view.batchId).phase).toBe('ready');
  // 素材の確認は呼んだその場で門を置き直す（新しく実行した証拠）。
  const previous=gate,third=flaky.confirm(dir,view.batchId,request,sessions);expect(gate).not.toBe(previous);gate();
  await expect(third).resolves.toMatchObject({appliedRevision:1,changed:true});
  expect(sessions.open(dir).document.clips.filter(c=>c.trackId==='v-main')).toHaveLength(1);
});
