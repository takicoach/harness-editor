// src/server/sequence/importApi.test.ts
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,mkdtemp,readFile,realpath,rm,stat} from 'node:fs/promises';
import {createServer,request as httpRequest,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {createSequenceProject} from './create';
import {importBatches} from './importBatches';
import type {SequenceSessionState} from './service';
import type {ImportBatchView} from '../../shared/importBatches';
import {makeVideoSamples,type VideoSamples} from './__fixtures__/videoSamples';

let samples:VideoSamples,root:string,server:Server,origin:string,id:string;
beforeAll(async()=>{samples=makeVideoSamples(await mkdtemp(join(await realpath(tmpdir()),'import-api-media-')));},30000);
afterAll(async()=>{await rm(samples.dir,{recursive:true,force:true});});
beforeEach(async()=>{
  vi.stubEnv('SME_BROWSE_ROOTS',samples.dir);root=await mkdtemp(join(await realpath(tmpdir()),'import-api-'));
  ({id}=await createSequenceProject(root,{name:'案件',videoName:'first.mp4',sourcePath:samples.first}));
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(error=>sendApiError(res,error));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async()=>{for(const batch of importBatches.list(join(root,id)))await importBatches.idle(join(root,id),batch.batchId);vi.unstubAllEnvs();server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});});
const post=async(route:string,body:unknown)=>{const response=await fetch(`${origin}/api/sequence${route}?id=${encodeURIComponent(id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,json:await response.json()};};

it('prepares linked videos in natural order outside the document, then places them in one edit',async()=>{
  const created=await post('/imports',{requestId:'r1',mode:'link',origin:'ui',items:[{key:'0',name:'third-25.mp4',path:samples.third25},{key:'1',name:'second-60.mp4',path:samples.second60}]});
  expect(created.status).toBe(200);const view=created.json as ImportBatchView;expect(view.items.map(i=>i.name)).toEqual(['second-60.mp4','third-25.mp4']);
  const saved=await readFile(join(root,id,'.harness/project.v2.json'),'utf8'),state=(await post('/session',{})).json as SequenceSessionState;
  await importBatches.idle(join(root,id),view.batchId);
  const listed=await (await fetch(`${origin}/api/sequence/imports?id=${encodeURIComponent(id)}`)).json() as {batches:ImportBatchView[]};
  expect(listed.batches[0]).toMatchObject({phase:'ready',items:[{durationSeconds:2},{durationSeconds:1}]});
  expect(await readFile(join(root,id,'.harness/project.v2.json'),'utf8')).toBe(saved);
  const confirmed=await post('/imports/confirm',{batchId:view.batchId,sessionId:state.sessionId,executionId:'c1'});
  expect(confirmed.status).toBe(200);
  expect((confirmed.json as SequenceSessionState).document.clips.filter(c=>c.trackId==='v-main').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,30],[30,60],[90,30]]);
  const again=await post('/imports/confirm',{batchId:view.batchId,sessionId:state.sessionId,executionId:'c2'});
  expect(again).toMatchObject({status:409,json:{code:'IMPORT_CONFIRMED'}});
});
it('refuses a path outside the allowed places before any reading',async()=>{
  const refused=await post('/imports',{requestId:'r2',mode:'link',origin:'ui',items:[{key:'0',name:'first.mp4',path:join(root,id,'.harness/project.v2.json')}]});
  expect(refused.status).toBe(403);expect((await importBatches.list(join(root,id)))).toEqual([]);
});
it('accepts a copied upload and a linked reference delivered by the browser, and checks the expected fingerprint',async()=>{
  const copy=(await post('/imports',{requestId:'r3',mode:'copy',origin:'ui',items:[{key:'0',name:'third-25.mp4'}]})).json as ImportBatchView;
  const uploaded=await fetch(`${origin}/api/sequence/imports/upload?${new URLSearchParams({id,batch:copy.batchId,item:'i0'})}`,{method:'POST',body:await readFile(samples.third25)});
  expect(uploaded.status).toBe(200);await importBatches.idle(join(root,id),copy.batchId);
  expect(importBatches.get(join(root,id),copy.batchId).phase).toBe('ready');
  const link=(await post('/imports',{requestId:'r4',mode:'link',origin:'ui',items:[{key:'0',name:'silent.mp4'},{key:'1',name:'rotated.mp4'}]})).json as ImportBatchView;
  const fingerprint=createHash('sha256').update(await readFile(samples.silent)).digest('hex');
  expect((await post('/imports/reference',{batchId:link.batchId,itemId:'i1',path:samples.silent,expectedFingerprint:fingerprint})).status).toBe(200);
  expect((await post('/imports/reference',{batchId:link.batchId,itemId:'i0',path:samples.rotated,expectedFingerprint:fingerprint})).status).toBe(200);
  await importBatches.idle(join(root,id),link.batchId);
  expect(importBatches.get(join(root,id),link.batchId)).toMatchObject({phase:'partial',items:[{phase:'failed',error:'選択した素材の指紋と現在の参照先が一致しません'},{phase:'ready'}]});
});
it('sends the batch list on the imports channel (sync and live)',async()=>{
  const view=(await post('/imports',{requestId:'r5',mode:'link',origin:'ui',items:[{key:'0',name:'first.mp4',path:samples.first}]})).json as ImportBatchView;
  const sync=await (await fetch(`${origin}/api/events/sync?id=${encodeURIComponent(id)}&ch=imports`)).json() as {messages:Array<{type:string;batches:ImportBatchView[]}>};
  expect(sync.messages[0]!.type).toBe('list');expect(sync.messages[0]!.batches.map(b=>b.batchId)).toEqual([view.batchId]);
  const controller=new AbortController(),response=await fetch(`${origin}/api/events?id=${encodeURIComponent(id)}`,{signal:controller.signal});
  const reader=response.body!.getReader(),decoder=new TextDecoder();let text='';
  while(!text.includes('"ch":"imports"')){const chunk=await reader.read();if(chunk.done)break;text+=decoder.decode(chunk.value);}
  controller.abort();expect(text).toContain(view.batchId);
});

// ---- レビュー1回目の修正 ----
it('refuses a reference delivery outside the allowed places',async()=>{
  const link=(await post('/imports',{requestId:'r6',mode:'link',origin:'ui',items:[{key:'0',name:'a.mp4'}]})).json as ImportBatchView;
  expect((await post('/imports/reference',{batchId:link.batchId,itemId:'i0',path:join(root,id,'.harness/project.v2.json')})).status).toBe(403);
  expect(importBatches.get(join(root,id),link.batchId).items[0]!.phase).toBe('waiting');
});
it('checks the item count before any path, limits the name length, and names linked items after the real file',async()=>{
  const outside=join(root,id,'.harness/project.v2.json');
  expect((await post('/imports',{requestId:'r7',mode:'link',origin:'ui',items:Array.from({length:51},(_,i)=>({key:String(i),name:'a.mp4',path:outside}))})).status).toBe(400);
  expect((await post('/imports',{requestId:'r8',mode:'copy',origin:'ui',items:[{key:'0',name:`${'a'.repeat(252)}.mp4`}]})).status).toBe(400);
  const named=(await post('/imports',{requestId:'r9',mode:'link',origin:'ui',items:[{key:'0',name:'claimed.mp4',path:samples.first}]})).json as ImportBatchView;
  expect(named.items[0]!.name).toBe('first.mp4');await importBatches.idle(join(root,id),named.batchId);
});
it('refuses an upload to a cancelled batch before receiving the body',async()=>{
  const copy=(await post('/imports',{requestId:'r10',mode:'copy',origin:'ui',items:[{key:'0',name:'a.mp4'}]})).json as ImportBatchView;
  expect((await post('/imports/cancel',{batchId:copy.batchId})).status).toBe(200);
  // 本文の宣言は 1MB、送るのは先頭の16バイトだけ。受信を待たずに断れば応答が届く。
  const answer=await new Promise<{status:number;body:string}>((resolve,reject)=>{
    const request=httpRequest({host:'127.0.0.1',port:Number(new URL(origin).port),method:'POST',path:`/api/sequence/imports/upload?${new URLSearchParams({id,batch:copy.batchId,item:'i0'})}`,
      headers:{'Content-Length':String(1024*1024)}},response=>{let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});response.on('end',()=>{resolve({status:response.statusCode!,body});request.destroy();});});
    request.on('error',reject);request.write(Buffer.alloc(16));
  });
  expect(answer.status).toBe(409);expect(JSON.parse(answer.body)).toMatchObject({code:'IMPORT_CLOSED'});
});
it('sends a new list on the imports channel each time a batch changes',async()=>{
  const controller=new AbortController(),response=await fetch(`${origin}/api/events?id=${encodeURIComponent(id)}`,{signal:controller.signal});
  const reader=response.body!.getReader(),decoder=new TextDecoder();let text='';
  const until=async(test:(fresh:string)=>boolean,from:number)=>{while(!test(text.slice(from))){const chunk=await reader.read();if(chunk.done)throw new Error('接続が閉じました');text+=decoder.decode(chunk.value);}};
  try{
    await until(fresh=>fresh.includes('"ch":"imports"'),0);const connected=text.length;
    const view=(await post('/imports',{requestId:'r11',mode:'link',origin:'ui',items:[{key:'0',name:'first.mp4',path:samples.first}]})).json as ImportBatchView;
    await until(fresh=>fresh.includes(view.batchId)&&fresh.includes('"phase":"ready"'),connected);const ready=text.length;
    expect((await post('/imports/cancel',{batchId:view.batchId})).status).toBe(200);
    await until(fresh=>fresh.includes('"phase":"cancelled"'),ready);
  }finally{controller.abort();}
});

it('marks undelivered items failed through /imports/abandon and checks the request',async()=>{
  const copy=(await post('/imports',{requestId:'r-abandon',mode:'copy',origin:'ui',items:[{key:'0',name:'a.mp4'},{key:'1',name:'b.mp4'}]})).json as ImportBatchView;
  const done=await post('/imports/abandon',{batchId:copy.batchId,itemIds:['i0']});
  expect(done.status).toBe(200);expect((done.json as ImportBatchView).items.map(i=>i.phase)).toEqual(['failed','waiting']);
  expect((await post('/imports/abandon',{batchId:copy.batchId,itemIds:[]})).status).toBe(400);
  expect((await post('/imports/abandon',{batchId:copy.batchId,itemIds:'i1'})).status).toBe(400);
  expect((await post('/imports/abandon',{batchId:copy.batchId,itemIds:['i9']})).status).toBe(404);
  await post('/imports/cancel',{batchId:copy.batchId});
});
it('links a Japanese name saved in NFD but sent in NFC, and a case-different path, through to ready',async()=>{
  const folder=join(samples.dir,'names'),nfd='ドライバー.mp4'.normalize('NFD'),nfc='ドライバー.mp4'.normalize('NFC');
  await mkdir(folder);
  try{
    await copyFile(samples.first,join(folder,nfd));await copyFile(samples.first,join(folder,'case-take.mp4'));
    const sent=[join(folder,nfc),join(samples.dir,'NAMES','CASE-TAKE.MP4')];
    // 名前の正規化・大小を区別しないファイルシステムでだけ意味を持つ（存在の確認）。
    expect(nfc).not.toBe(nfd);for(const path of sent)await expect(stat(path)).resolves.toBeTruthy();
    const created=await post('/imports',{requestId:'r-names',mode:'link',origin:'ui',items:sent.map((path,index)=>({key:String(index),name:'x.mp4',path}))});
    expect(created.status).toBe(200);const view=created.json as ImportBatchView;await importBatches.idle(join(root,id),view.batchId);
    expect(importBatches.get(join(root,id),view.batchId)).toMatchObject({phase:'ready',items:[{phase:'ready'},{phase:'ready'}]});
  }finally{await rm(folder,{recursive:true,force:true});}
});
