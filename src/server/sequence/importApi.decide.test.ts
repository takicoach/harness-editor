// src/server/sequence/importApi.decide.test.ts
// 追加時の判断待ちの窓口（設計 §2）: 本番と同じ handleApi・判定（先頭の試し読み）・コピーの作業を通す。
// 外界は一時フォルダーのボリューム（SD は試し読みが遅い。mediaCopyTesting で差し替える）。動画の代わりに音声だけの .mp4（WAV）を使う（映像の無い素材として準備済みになる）。
import {afterEach,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {readFile,stat,symlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import type {CopyDestinationView,CopyJobView} from '../../shared/mediaCopy';
import type {ImportBatchView} from '../../shared/importBatches';
import type {SequenceSessionState} from './service';
import {importBatches} from './importBatches';
import {createEditorImportAdapter} from './importAgent';
import {mediaCopyJobs,mediaCopyTesting} from './mediaCopy/jobs';
import {PROBE_BYTES,estimateTesting} from './mediaCopy/estimate';
import {COPY_ROOT_NAME} from './mediaCopy/volumes';
import {referenceReadState,referenceTarget,referenceVerificationTesting,registerSequenceReference,registeredSequenceReferences} from './references';
import {copyProject,wav,type CopyProject} from './mediaCopy/__fixtures__/copyProject';

const MiB=2**20,PROBE_RATE=32*1024;
let p:CopyProject|undefined,server:Server|undefined,origin='',projectId='case';const browseRoots=process.env.SME_BROWSE_ROOTS,streams:AbortController[]=[];
/** SD の試し読みは 32KiB/s（仮想の時計）。1MiB だけ試し読みする（3MiB の動画は約 96 秒＝遅い見込み、1MiB 未満は測らない＝遅くない）。 */
async function setup(options:{folder?:string}={}):Promise<CopyProject>{
  const project=p=await copyProject({files:[],sdProbeBytesPerSecond:PROBE_RATE,...options});mediaCopyTesting.use({io:project.io});estimateTesting.probeBytes=MiB;
  process.env.SME_BROWSE_ROOTS=[project.sd,project.ssd].join(':');projectId=options.folder?.normalize('NFC')??'case';
  await writeFile(join(project.sd,'a-slow.mp4'),wav(3,1));await writeFile(join(project.sd,'b.mp4'),wav(0.5,2));
  const listening=server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),dirname(project.project)).catch(error=>{sendApiError(res,error);});});
  await new Promise<void>(resolve=>listening.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(listening.address() as AddressInfo).port}`;return project;
}
afterEach(async()=>{
  for(const stream of streams.splice(0))stream.abort();
  await mediaCopyJobs.idle();if(p)for(const batch of importBatches.list(directory(p)))await importBatches.idle(directory(p),batch.batchId);
  mediaCopyTesting.reset();estimateTesting.probeBytes=PROBE_BYTES;if(browseRoots===undefined)delete process.env.SME_BROWSE_ROOTS;else process.env.SME_BROWSE_ROOTS=browseRoots;
  if(server){const closing=server;closing.closeAllConnections();await new Promise<void>(resolve=>closing.close(()=>resolve()));server=undefined;}
  await referenceVerificationTesting.idle();referenceVerificationTesting.forget();await p?.cleanup();p=undefined;
});
async function call<T=unknown>(route:string,body?:unknown):Promise<{status:number;json:T;text:string}>{
  const response=await fetch(`${origin}/api/sequence${route}?id=${encodeURIComponent(projectId)}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const text=await response.text();return {status:response.status,json:JSON.parse(text) as T,text};
}
/** 窓口が使う案件の場所（URL の ID の形のまま。束は渡した形で覚えるので、同じ形で照会する）。 */
const directory=(project:CopyProject)=>join(dirname(project.project),projectId);
/** 遅い見込みの1本と遅くない1本の束を作り、判定と遅くない方の準備が終わるまで待つ。 */
async function heldBatch(project:CopyProject,requestId='r1',first='a-slow.mp4'):Promise<ImportBatchView>{
  const created=await call<ImportBatchView>('/imports',{requestId,mode:'link',origin:'ui',items:[{key:'0',name:first,path:join(project.sd,first)},{key:'1',name:'b.mp4',path:join(project.sd,'b.mp4')}]});
  expect(created.status).toBe(200);await importBatches.idle(directory(project),created.json.batchId);return importBatches.get(directory(project),created.json.batchId);
}
/** 通知（SSE の統合接続）を開き、copy-jobs の一覧を届いた順に貯める。 */
async function listen(){
  const controller=new AbortController();streams.push(controller);
  const response=await fetch(`${origin}/api/events?id=${encodeURIComponent(projectId)}`,{signal:controller.signal}),reader=response.body!.getReader(),decoder=new TextDecoder();
  const lists:CopyJobView[][]=[];let buffer='';
  void (async()=>{
    try{
      for(;;){
        const {value,done}=await reader.read();if(done)return;buffer+=decoder.decode(value,{stream:true});
        for(let at=buffer.indexOf('\n\n');at>=0;at=buffer.indexOf('\n\n')){
          const chunk=buffer.slice(0,at);buffer=buffer.slice(at+2);if(!chunk.startsWith('data: '))continue;
          const {ch,msg}=JSON.parse(chunk.slice('data: '.length)) as {ch:string;msg:{type?:string;jobs?:CopyJobView[]}};
          if(ch==='copy-jobs'&&msg.type==='list'&&msg.jobs)lists.push(msg.jobs);
        }
      }
    }catch{/* 閉じた */}
  })();
  return {until:async(predicate:(jobs:CopyJobView[])=>boolean)=>{await vi.waitFor(()=>{expect(lists.some(predicate)).toBe(true);},{timeout:5000,interval:20});}};
}

it('holds a slow video for a decision, lists the drives for it, and copies it to the chosen one before it can be placed',async()=>{
  const project=await setup(),size=(await stat(join(project.sd,'a-slow.mp4'))).size,seconds=Math.ceil(size/PROBE_RATE);
  const held=await heldBatch(project),batchId=held.batchId;
  expect(held).toMatchObject({phase:'deciding',decision:{itemIds:['i0'],totalBytes:size,totalSeconds:seconds},items:[{phase:'awaiting-decision',slow:{sizeBytes:size,seconds}},{phase:'ready',audioOnly:true}]});
  const session=(await call<SequenceSessionState>('/session',{})).json;
  expect(await call('/imports/confirm',{batchId,sessionId:session.sessionId,executionId:'c0'})).toMatchObject({status:409,json:{code:'IMPORT_DECIDING'}});
  // コピー先の候補は束が覚えている元から（元の SD は候補にしない）
  const listed=await call<{destinations:CopyDestinationView[];totalBytes:number}>('/media-copy/destinations',{batchId});
  expect(listed.status).toBe(200);expect(listed.json.destinations.map(item=>item.key)).toEqual(['internal','volume:SSD']);expect(listed.json.totalBytes).toBe(size);
  const ssd=listed.json.destinations.find(item=>item.key==='volume:SSD')!;
  const decided=await call<ImportBatchView>('/imports/decide',{batchId,choice:'copy',destination:{key:ssd.key,...ssd.volume}});
  expect(decided.status).toBe(200);expect(decided.json.items[0]).toMatchObject({choice:'copy'});expect(decided.json.decision).toBeUndefined();
  await mediaCopyJobs.idle();await importBatches.idle(project.project,batchId);
  const copied=importBatches.get(project.project,batchId);expect(copied).toMatchObject({phase:'ready',items:[{phase:'ready',audioOnly:true,choice:'copy'},{phase:'ready'}]});
  // コピーを元にリンク登録した（元の SD ではなくコピー先につながる）。コピーの作業は取り込みの束の項目と結びつく
  const asset=(await registeredSequenceReferences(project.project)).find(item=>item.id===copied.items[0]!.assetId)!;
  expect(await referenceTarget(project.project,asset.file)).toBe(join(project.ssd,COPY_ROOT_NAME,'案件-12345678','a-slow.mp4'));
  expect((await call<{jobs:CopyJobView[]}>('/media-copy/jobs')).json.jobs).toEqual([expect.objectContaining({mode:'add',state:'finished',items:[expect.objectContaining({phase:'done',batchItem:{batchId,itemId:'i0'}})]})]);
  const placed=await call<SequenceSessionState>('/imports/confirm',{batchId,sessionId:session.sessionId,executionId:'c1'});
  expect(placed.status).toBe(200);expect(placed.json.document.assets.map(item=>item.id)).toEqual(expect.arrayContaining([copied.items[0]!.assetId,copied.items[1]!.assetId]));
  for(const text of [listed.text,decided.text,JSON.stringify(importBatches.list(project.project))])expect(text).not.toContain(project.sd);
});
it('keeps a held video where it is; "not again for this connection" is kept with the real path the advice compares',async()=>{
  const project=await setup();await symlink(join(project.sd,'a-slow.mp4'),join(project.sd,'via-link.mp4'));
  const held=await heldBatch(project,'r1','via-link.mp4');expect(held.items.map(item=>[item.name,item.phase])).toEqual([['a-slow.mp4','awaiting-decision'],['b.mp4','ready']]);
  expect((await call<ImportBatchView>('/imports/decide',{batchId:held.batchId,choice:'keep-always'})).status).toBe(200);await importBatches.idle(project.project,held.batchId);
  const kept=importBatches.get(project.project,held.batchId);expect(kept).toMatchObject({phase:'ready',items:[{phase:'ready',choice:'keep-always'},{phase:'ready'}]});
  const asset=(await registeredSequenceReferences(project.project)).find(item=>item.id===kept.items[0]!.assetId)!,state=await referenceReadState(project.project,asset);
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(project.project,'.harness/slow-media.json'),'utf8')).entries[asset.id]).toEqual({target:state!.path,volume:'SD'}));
  expect(state!.path).toBe(join(project.sd,'a-slow.mp4'));expect(await mediaCopyJobs.list(project.project)).toEqual([]);
});
it('"not again" follows the connection the asset keeps when the same video was already linked from another drive',async()=>{
  const project=await setup(),elsewhere=join(project.ssd,'dup.mp4');await writeFile(elsewhere,await readFile(join(project.sd,'a-slow.mp4')));
  const existing=await registerSequenceReference(project.project,elsewhere),held=await heldBatch(project);
  expect((await call('/imports/decide',{batchId:held.batchId,choice:'keep-always'})).status).toBe(200);await importBatches.idle(project.project,held.batchId);
  // 同じ指紋の既存の登録は元の接続先（SSD）を保つ。開いた時の案内が比べるのはその接続先なので、そちらとそのドライブで残す
  expect(importBatches.get(project.project,held.batchId).items[0]).toMatchObject({phase:'ready',assetId:existing.id});
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(project.project,'.harness/slow-media.json'),'utf8')).entries[existing.id]).toEqual({target:elsewhere,volume:'SSD'}));
});
it('checks the decision request, leaves the batch to decide again when a copy cannot start, and never shows a path',async()=>{
  const project=await setup(),held=await heldBatch(project),batchId=held.batchId;
  expect((await call('/imports/decide',{batchId,choice:'move'})).status).toBe(400);
  expect((await call('/imports/decide',{batchId:'../x',choice:'keep-once'})).status).toBe(400);
  expect((await call('/imports/decide',{batchId:'imp-00000000000000000000',choice:'keep-once'})).status).toBe(404);
  expect((await call('/imports/decide',{batchId,choice:'copy'})).status).toBe(400);
  expect((await call('/imports/decide',{batchId,choice:'keep-once',destination:{key:'internal',uuid:'BOOT',dev:1}})).status).toBe(400);
  expect((await call('/media-copy/destinations',{batchId,assetIds:['media-x']})).status).toBe(400);
  const ssd=(await call<{destinations:CopyDestinationView[]}>('/media-copy/destinations',{batchId})).json.destinations.find(item=>item.key==='volume:SSD')!;
  // 選んだ時からドライブが入れ替わった: 始めずに断り、判断待ちのまま
  const swapped=await call('/imports/decide',{batchId,choice:'copy',destination:{key:ssd.key,uuid:ssd.volume.uuid,dev:ssd.volume.dev+1}});
  expect(swapped.status).toBe(409);expect(swapped.text).not.toContain(project.root);
  expect(importBatches.get(project.project,batchId)).toMatchObject({phase:'deciding',decision:{itemIds:['i0']}});expect(await mediaCopyJobs.list(project.project)).toEqual([]);
  expect((await call('/imports/decide',{batchId,choice:'keep-once'})).status).toBe(200);await importBatches.idle(project.project,batchId);
  // 決めた後: もう判断待ちは無い
  expect(await call('/imports/decide',{batchId,choice:'keep-once'})).toMatchObject({status:409,json:{code:'IMPORT_NO_DECISION'}});
  expect(await call('/media-copy/destinations',{batchId})).toMatchObject({status:409,json:{code:'IMPORT_NO_DECISION'}});
});
it('places an AI import of the same slow video as before, without holding it',async()=>{
  const project=await setup(),adapter=createEditorImportAdapter(dirname(project.project));
  const view=adapter.start({projectId:'case',operationId:'op-1',paths:[join(project.sd,'a-slow.mp4')],placement:'append-main'});
  await importBatches.idle(project.project,view.batchId);expect(adapter.runs('case',view.batchId)[0]).toMatchObject({phase:'ready',items:[{phase:'ready',audioOnly:true}]});
  expect(adapter.runs('case',view.batchId)[0]!.decision).toBeUndefined();
});
it('reports an added copy on the notices of the project even when its folder name is stored in another Unicode form',async()=>{
  const name='が案件',project=await setup({folder:name.normalize('NFD')}),live=await listen();await live.until(jobs=>jobs.length===0);
  const held=await heldBatch(project),listed=await call<{destinations:CopyDestinationView[]}>('/media-copy/destinations',{batchId:held.batchId});
  const ssd=listed.json.destinations.find(item=>item.key==='volume:SSD')!;
  expect((await call('/imports/decide',{batchId:held.batchId,choice:'copy',destination:{key:ssd.key,...ssd.volume}})).status).toBe(200);await mediaCopyJobs.idle();
  await live.until(jobs=>jobs.some(job=>job.mode==='add'&&job.state==='finished'&&!job.notThisProcess));
});
