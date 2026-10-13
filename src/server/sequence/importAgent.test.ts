// src/server/sequence/importAgent.test.ts
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {copyFileSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rational as r} from '../../core/sequence/time';
import type {SequenceAsset} from '../../core/sequence/model';
import {MAIN_SPEED_REFUSAL} from '../../core/sequence/mainAppend';
import type {SequenceService} from './service';
import {SequenceStore} from './store';
import {buildEmptyDocument} from './createDocuments';
import {ImportBatches} from './importBatches';
import {agentRequestId,createEditorImportAdapter} from './importAgent';

let root='',allowed='';
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'import-agent-')));allowed=join(root,'allowed');mkdirSync(allowed);mkdirSync(join(root,'case'));
  for(const name of ['take2.mp4','take10.mp4'])copyFileSync(new URL(import.meta.url).pathname,join(allowed,name));
  new SequenceStore(join(root,'case')).save({document:buildEmptyDocument('case',()=>'doc'),expectedSavedRevision:null,executionId:'seed'});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();rmSync(root,{recursive:true,force:true});});
const batches=()=>new ImportBatches(async({name})=>({id:`media-${name.replace(/\W/g,'').padEnd(24,'0').slice(0,24)}`,kind:'media',name,file:`.harness/references/${'a'.repeat(64)}.mp4`,fingerprint:'a'.repeat(64),
  streams:[{index:0,kind:'video',codec:'h264',duration:r(1),frameRate:r(30),width:160,height:90}]}),async()=>undefined);
const adapter=(b=batches())=>createEditorImportAdapter(root,b,()=>[{key:'allowed',label:'許可',path:allowed}]);
it('creates an agent batch of authorized real paths in natural order and replays the same operation',()=>{
  const a=adapter(),input={projectId:'case',operationId:'op-1',paths:[join(allowed,'take10.mp4'),join(allowed,'take2.mp4')],placement:'append-main' as const};
  const view=a.start(input);expect(view.origin).toEqual({kind:'agent',operationId:'op-1'});expect(view.items.map(i=>i.name)).toEqual(['take2.mp4','take10.mp4']);
  expect(JSON.stringify(view)).not.toContain(allowed);
  expect(a.start(input).batchId).toBe(view.batchId);expect(a.find('case','op-1')?.batchId).toBe(view.batchId);
  expect(()=>a.start({...input,paths:[join(allowed,'take2.mp4')]})).toThrow(/^OPERATION_CONFLICT: /);
  expect(a.runs('case').map(b=>b.batchId)).toEqual([view.batchId]);
});
it('refuses a path outside the allowed places (after resolving it) and non-video files',()=>{
  const a=adapter();
  expect(()=>a.start({projectId:'case',operationId:'op-2',paths:[join(root,'case','.harness','project.v2.json')],placement:'append-main'})).toThrow(/^IMPORT_PATH_NOT_ALLOWED: /);
  expect(()=>a.start({projectId:'case',operationId:'op-3',paths:[join(allowed,'..','case','.harness','project.v2.json')],placement:'append-main'})).toThrow(/^IMPORT_PATH_NOT_ALLOWED: /);
  copyFileSync(new URL(import.meta.url).pathname,join(allowed,'song.mp3'));
  expect(()=>a.start({projectId:'case',operationId:'op-4',paths:[join(allowed,'song.mp3')],placement:'append-main'})).toThrow(/^IMPORT_INVALID: /);
});
it('refuses a symbolic link inside the allowed place that leads outside, without telling the path or making a batch',()=>{
  const outside=join(root,'outside');mkdirSync(outside);copyFileSync(new URL(import.meta.url).pathname,join(outside,'secret.mp4'));
  symlinkSync(join(outside,'secret.mp4'),join(allowed,'link.mp4'));symlinkSync(outside,join(allowed,'folder'));
  // リンクは生きている（断られるのは行き先が許可外だから。切れたリンクの「見つからない」ではない）。
  expect(realpathSync(join(allowed,'link.mp4'))).toBe(join(outside,'secret.mp4'));expect(realpathSync(join(allowed,'folder','secret.mp4'))).toBe(join(outside,'secret.mp4'));
  const a=adapter();
  for(const [operationId,path] of [['op-link',join(allowed,'link.mp4')],['op-folder',join(allowed,'folder','secret.mp4')]] as const){
    let message='';try{a.start({projectId:'case',operationId,paths:[join(allowed,'take2.mp4'),path],placement:'append-main'});}catch(error){message=(error as Error).message;}
    expect(message).toMatch(/^IMPORT_PATH_NOT_ALLOWED: /);expect(message).not.toContain(root);
  }
  expect(a.runs('case')).toEqual([]);
});
it('maps a missing batch and a finished batch to agent error codes',()=>{
  const b=batches(),a=adapter(b);
  expect(()=>a.cancel('case','imp-aaaaaaaaaaaaaaaaaaaa')).toThrow(/^IMPORT_NOT_FOUND: /);
  const view=a.start({projectId:'case',operationId:'op-5',paths:[join(allowed,'take2.mp4')],placement:'append-main'});
  expect(a.cancel('case',view.batchId).phase).toBe('cancelled');
});

// 懸念への決定（コントローラ 2026-10-03）
const video=(assetId:string):SequenceAsset=>({id:assetId,kind:'media',name:'take2.mp4',file:`.harness/references/${'a'.repeat(64)}.mp4`,fingerprint:'a'.repeat(64),
  streams:[{index:0,kind:'video',codec:'h264',duration:r(1),frameRate:r(30),width:160,height:90}]});
/** 確定まで進める束（素材の確認は登録済みとして通す）。 */
const confirmable=()=>new ImportBatches(async({name})=>({...video(`media-${name.replace(/\W/g,'').padEnd(24,'0').slice(0,24)}`),name}),async(_root,assetId)=>video(assetId));
const fakeSessions=(sessionId:string,speed:boolean)=>({open:()=>({sessionId,document:{...buildEmptyDocument('case',()=>'doc'),...(speed?{speed:{} as never}:{})}}),execute:vi.fn()}) as unknown as SequenceService;
it('refuses a new import into a speed-registered project up front with the existing wording, yet answers a resend of an earlier operation',()=>{
  const a=adapter(),first={projectId:'case',operationId:'op-s1',paths:[join(allowed,'take2.mp4')],placement:'append-main' as const},view=a.start(first);
  const saved=new SequenceStore(join(root,'case')).load()!;
  vi.spyOn(SequenceStore.prototype,'load').mockReturnValue({...saved,document:{...saved.document,speed:{} as never}});
  expect(()=>a.start({...first,operationId:'op-s2'})).toThrow(`IMPORT_SPEED_REGISTERED: ${MAIN_SPEED_REFUSAL}`);
  expect(a.start(first).batchId).toBe(view.batchId);expect(a.runs('case').map(b=>b.batchId)).toEqual([view.batchId]);
});
it('shows the AI the reason of the latest confirm attempt only when it is permanent (speed), also after a restart',async()=>{
  const b=confirmable(),a=adapter(b),dir=join(root,'case'),view=a.start({projectId:'case',operationId:'op-r',paths:[join(allowed,'take2.mp4')],placement:'append-main'});
  await b.idle(dir,view.batchId);expect(a.runs('case',view.batchId)[0]!.phase).toBe('ready');
  await expect(b.confirm(dir,view.batchId,{sessionId:'s',executionId:'c1'},fakeSessions('other',false))).rejects.toMatchObject({reason:'REVISION_CONFLICT'});
  expect(a.runs('case',view.batchId)[0]).not.toHaveProperty('refusal');
  await expect(b.confirm(dir,view.batchId,{sessionId:'s',executionId:'c2'},fakeSessions('s',true))).rejects.toMatchObject({reason:'SPEED_REGISTERED'});
  expect(a.runs('case',view.batchId)[0]).toMatchObject({phase:'ready',refusal:{code:'SPEED_REGISTERED',message:MAIN_SPEED_REFUSAL}});
  expect(adapter(confirmable()).runs('case',view.batchId)[0]).toMatchObject({refusal:{code:'SPEED_REGISTERED',message:MAIN_SPEED_REFUSAL}});
  // 確定を試みるたびに理由を消す: 次の試みが一時的な失敗なら、古い理由は残らない（再起動後も）。
  await expect(b.confirm(dir,view.batchId,{sessionId:'s',executionId:'c3'},fakeSessions('other',false))).rejects.toMatchObject({reason:'REVISION_CONFLICT'});
  expect(a.runs('case',view.batchId)[0]).not.toHaveProperty('refusal');expect(adapter(confirmable()).runs('case',view.batchId)[0]).not.toHaveProperty('refusal');
});
it('records a missing import record at confirm as a permanent refusal with its own code',async()=>{
  const b=batches(),a=adapter(b),dir=join(root,'case'),view=a.start({projectId:'case',operationId:'op-missing',paths:[join(allowed,'take2.mp4')],placement:'append-main'});
  await b.idle(dir,view.batchId);
  await expect(b.confirm(dir,view.batchId,{sessionId:'s',executionId:'c'},fakeSessions('s',false))).rejects.toMatchObject({status:409,reason:'IMPORT_ASSET_MISSING'});
  expect(a.runs('case',view.batchId)[0]!.refusal).toMatchObject({code:'IMPORT_ASSET_MISSING',message:expect.stringContaining('取り込み記録が見つかりません')});
});
const otherBatches=(b:ImportBatches)=>(['ui','home'] as const).map((kind,index)=>b.create(join(root,'case'),{requestId:`${kind}-${index}`,projectId:'case',origin:{kind},mode:'link',
  items:[{key:'0',name:'take2.mp4',source:{kind:'path',path:join(allowed,'take2.mp4')}}]}));
const message=(run:()=>unknown)=>{try{run();}catch(error){return (error as Error).message;}throw new Error('例外が投げられませんでした');};
it('looks up only batches the AI made: a screen or home batch ID reads like a missing one',()=>{
  const b=batches(),a=adapter(b),missing=message(()=>a.runs('case','imp-aaaaaaaaaaaaaaaaaaaa'));
  expect(missing).toMatch(/^IMPORT_NOT_FOUND: /);
  for(const other of otherBatches(b))expect(message(()=>a.runs('case',other.batchId))).toBe(missing);
  expect(a.runs('case')).toEqual([]);
});
it('cancels only batches the AI made: a screen or home batch ID reads like a missing one and stays as it is',()=>{
  const b=batches(),a=adapter(b),missing=message(()=>a.cancel('case','imp-aaaaaaaaaaaaaaaaaaaa'));
  for(const other of otherBatches(b)){
    expect(message(()=>a.cancel('case',other.batchId))).toBe(missing);expect(b.get(join(root,'case'),other.batchId).phase).not.toBe('cancelled');
  }
});
it('answers a resend before re-checking paths, even after the file moved, and still refuses a reordered resend',()=>{
  const a=adapter(),input={projectId:'case',operationId:'op-m',paths:[join(allowed,'take2.mp4'),join(allowed,'take10.mp4')],placement:'append-main' as const},view=a.start(input);
  renameSync(join(allowed,'take2.mp4'),join(root,'moved.mp4'));
  expect(a.start(input).batchId).toBe(view.batchId);
  expect(()=>a.start({...input,paths:[...input.paths].reverse()})).toThrow(/^OPERATION_CONFLICT: /);
});
it('accepts any operation ID text (Japanese, spaces) and replays it',()=>{
  const a=adapter(),input={projectId:'case',operationId:'取り込み 1回目／カメラA',paths:[join(allowed,'take2.mp4')],placement:'append-main' as const},view=a.start(input);
  expect(view.origin).toEqual({kind:'agent',operationId:'取り込み 1回目／カメラA'});expect(a.start(input).batchId).toBe(view.batchId);
});
it('does not mix up long operation IDs that share a long beginning',()=>{
  const a=adapter(),base='x'.repeat(200),input=(operationId:string)=>({projectId:'case',operationId,paths:[join(allowed,'take2.mp4')],placement:'append-main' as const});
  const first=a.start(input(`${base}-1`)),second=a.start(input(`${base}-2`));
  expect(second.batchId).not.toBe(first.batchId);expect(a.find('case',`${base}-2`)?.batchId).toBe(second.batchId);
});
it('answers a resend of an operation whose batch record was tidied away as finished, without making a new batch',()=>{
  vi.useFakeTimers({toFake:['Date']});let clock=Date.parse('2026-10-03T00:00:00Z');const tick=()=>vi.setSystemTime(clock+=1000);
  const a=adapter(),input=(operationId:string)=>({projectId:'case',operationId,paths:[join(allowed,'take2.mp4')],placement:'append-main' as const});
  tick();const old=a.start(input('op-old'));a.cancel('case',old.batchId);
  for(let index=0;index<51;index++){tick();const view=a.start(input(`op-${index}`));a.cancel('case',view.batchId);}
  const before=a.runs('case').map(view=>view.batchId);expect(before).not.toContain(old.batchId);   // 古い記録は整理済み（存在の確認）
  expect(()=>a.start(input('op-old'))).toThrow('IMPORT_FINISHED: この操作は完了済みです（記録は整理済み）');
  expect(()=>a.find('case','op-old')).toThrow(/^IMPORT_FINISHED: /);
  expect(a.runs('case').map(view=>view.batchId)).toEqual(before);
});
it('looks a request ID up only among batches the AI made',()=>{
  const b=batches(),a=adapter(b);
  b.create(join(root,'case'),{requestId:agentRequestId('op-x'),projectId:'case',origin:{kind:'ui'},mode:'link',items:[{key:'0',name:'take2.mp4',source:{kind:'path',path:join(allowed,'take2.mp4')}}]});
  expect(a.find('case','op-x')).toBeUndefined();
  expect(()=>a.start({projectId:'case',operationId:'op-x',paths:[join(allowed,'take2.mp4')],placement:'append-main'})).toThrow(/^OPERATION_CONFLICT: /);
});
