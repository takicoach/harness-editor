// src/server/sequence/mediaCopy/api.test.ts
// HTTP の窓口と通知（設計 §2・§3・§6）: 本番と同じ handleApi を通す。コピー先は一時フォルダーのボリュームだけ（mediaCopyTesting で外界を差し替える）。
import {afterEach,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {existsSync,realpathSync} from 'node:fs';
import {chmod,mkdir,readFile,readdir,stat,symlink,utimes,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import type {SequenceAsset} from '../../../core/sequence/model';
import {handleApi} from '../../plugin';
import {sendApiError} from '../../http';
import {copyJobChannelMessages} from '../../eventsApi';
import type {CopyDestinationView,CopyJobView,SlowMediaAdvice} from '../../../shared/mediaCopy';
import {SequenceStore} from '../store';
import {buildEmptyDocument} from '../createDocuments';
import {MediaCopyJobs,mediaCopyJobs,mediaCopyTesting,referenceCopyPorts} from './jobs';
import {SpaceReservations} from './space';
import {COPY_ROOT_NAME} from './volumes';
import {referenceTarget,referenceVerificationTesting,registerSequenceReference} from '../references';
import {copyProject,wav,type CopyProject} from './__fixtures__/copyProject';

let p:CopyProject|undefined,server:Server|undefined,origin='';const browseRoots=process.env.SME_BROWSE_ROOTS,streams:AbortController[]=[];
/** 素材を保存済みの文書にも載せる（素材の欄に出ているリンク素材）。 */
function addToDocument(project:string,assets:readonly SequenceAsset[]){
  const store=new SequenceStore(project),saved=store.load()!;
  store.save({document:{...saved.document,revision:saved.document.revision+1,assets:[...saved.document.assets,...assets]},expectedSavedRevision:saved.savedRevision,executionId:`add-links-${saved.savedRevision}`});
}
async function setup(options:Parameters<typeof copyProject>[0]={}):Promise<CopyProject>{
  const project=p=await copyProject(options);mediaCopyTesting.use({io:project.io});process.env.SME_BROWSE_ROOTS=[project.sd,project.ssd].join(':');addToDocument(project.project,project.assets);
  const listening=server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),dirname(project.project)).catch(error=>{sendApiError(res,error);});});
  await new Promise<void>(resolve=>listening.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(listening.address() as AddressInfo).port}`;return project;
}
afterEach(async()=>{
  for(const stream of streams.splice(0))stream.abort();
  vi.restoreAllMocks();
  await mediaCopyJobs.idle();mediaCopyTesting.reset();if(browseRoots===undefined)delete process.env.SME_BROWSE_ROOTS;else process.env.SME_BROWSE_ROOTS=browseRoots;
  if(server){const closing=server;closing.closeAllConnections();await new Promise<void>(resolve=>closing.close(()=>resolve()));server=undefined;}
  await referenceVerificationTesting.idle();referenceVerificationTesting.forget();await p?.cleanup();p=undefined;
});
async function call<T=unknown>(route:string,body?:unknown,options:{id?:string;raw?:string}={}):Promise<{status:number;json:T}>{
  const init:RequestInit=options.raw!==undefined?{method:'POST',headers:{'Content-Type':'application/json'},body:options.raw}
    :body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
  const response=await fetch(`${origin}/api/sequence${route}?id=${encodeURIComponent(options.id??'case')}`,init);
  return {status:response.status,json:await response.json() as T};
}
const ssdFor=async(assets:readonly SequenceAsset[],id='case')=>
  (await call<{destinations:CopyDestinationView[]}>('/media-copy/destinations',{assetIds:assets.map(asset=>asset.id)},{id})).json.destinations.find(item=>item.key==='volume:SSD')!;
/** 通知（SSE の統合接続）を開き、copy-jobs の一覧を届いた順に貯める。 */
async function listen(id='case'){
  const controller=new AbortController();streams.push(controller);
  const response=await fetch(`${origin}/api/events?id=${encodeURIComponent(id)}`,{signal:controller.signal}),reader=response.body!.getReader(),decoder=new TextDecoder();
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
  const until=async(predicate:(jobs:CopyJobView[])=>boolean)=>{await vi.waitFor(()=>{expect(lists.some(predicate)).toBe(true);},{timeout:5000,interval:20});};
  return {lists,until,close:()=>controller.abort()};
}
/** フォルダーの中の名前と更新時刻（何も書いていないことの確かめ）。 */
async function tree(dir:string):Promise<string[]>{
  const out:string[]=[];for(const entry of await readdir(dir,{withFileTypes:true,recursive:true})){const path=join(entry.parentPath,entry.name);out.push(`${path}:${(await stat(path)).mtimeMs}`);}
  return out.sort();
}

it('lists destinations for linked assets: this Mac and the SSD, never the card',async()=>{
  const p=await setup();
  const {status,json}=await call<{destinations:CopyDestinationView[];totalBytes:number}>('/media-copy/destinations',{assetIds:[p.assets[0]!.id]});
  expect(status).toBe(200);expect(json.destinations.map(item=>item.key)).toEqual(['internal','volume:SSD']);expect(json.totalBytes).toBe((await stat(p.sources[0]!)).size);
  // 画面へ返す値に置き場所の絶対パスは無い
  expect(JSON.stringify(json)).not.toContain(p.root);
  // 追加したばかりで文書を保存していないリンク素材も、参照台帳から選べる
  const fresh=join(p.sd,'clip-3.wav');await writeFile(fresh,wav(2,9));const added=await registerSequenceReference(p.project,fresh);
  expect((await call<{totalBytes:number}>('/media-copy/destinations',{assetIds:[added.id]})).json.totalBytes).toBe((await stat(fresh)).size);
});
it('starts a copy on the chosen drive and reports it until it is done; a reconnecting listener gets the list again',async()=>{
  const p=await setup(),live=await listen();await live.until(jobs=>jobs.length===0);   // 接続した時に一覧（まだ空）
  const ssd=await ssdFor([p.assets[0]!]);
  const started=await call<{job:CopyJobView}>('/media-copy/start',{assetIds:[p.assets[0]!.id],destination:{key:ssd.key,...ssd.volume}});
  expect(started.status).toBe(200);expect(started.json.job).toMatchObject({state:'running',projectId:'case',items:[{assetId:p.assets[0]!.id}]});await mediaCopyJobs.idle();
  const jobId=started.json.job.jobId;
  await live.until(jobs=>jobs.some(job=>job.jobId===jobId&&job.state==='finished'&&!job.notThisProcess));
  expect((await call<{jobs:CopyJobView[]}>('/media-copy/jobs')).json.jobs).toEqual([expect.objectContaining({jobId,state:'finished',items:[expect.objectContaining({phase:'done',assetId:p.assets[0]!.id})]})]);
  expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(join(p.ssd,COPY_ROOT_NAME,'案件-12345678','clip-1.wav'));
  // 通知をつなぎ直すと、接続した時の一覧で取り直す（sync も同じ一覧）
  live.close();const again=await listen();await again.until(()=>true);expect(again.lists[0]).toEqual([expect.objectContaining({jobId,state:'finished'})]);
  for(let connect=0;connect<2;connect++)expect(await copyJobChannelMessages(dirname(p.project),'case')).toEqual([{type:'list',jobs:[expect.objectContaining({jobId,state:'finished'})]}]);
  const sync=await (await fetch(`${origin}/api/events/sync?id=case&ch=copy-jobs`)).json() as {messages:unknown[]};
  expect(sync.messages).toEqual([{type:'list',jobs:[expect.objectContaining({jobId})]}]);
  expect((await call('/media-copy/dismiss',{jobId})).status).toBe(200);expect((await call<{jobs:CopyJobView[]}>('/media-copy/jobs')).json.jobs).toEqual([]);
  await again.until(jobs=>jobs.length===0);
});
it('refuses a drive that changed since it was chosen, an unknown asset, a place outside the allowed ones and an unknown job',async()=>{
  const p=await setup(),ssd=await ssdFor([p.assets[0]!]);
  expect((await call('/media-copy/start',{assetIds:[p.assets[0]!.id],destination:{key:ssd.key,uuid:'SSD',dev:ssd.volume.dev+1}})).status).toBe(409);
  expect((await call('/media-copy/destinations',{assetIds:['media-nope']})).status).toBe(400);
  expect((await call('/media-copy/destinations',{assetIds:[p.assets[0]!.id],customPath:'/etc'})).status).toBe(403);
  expect((await call('/media-copy/cancel',{jobId:'cp-00000000000000000000'})).status).toBe(404);
  expect((await call('/media-copy/dismiss',{jobId:'cp-00000000000000000000'})).status).toBe(404);
  expect(await mediaCopyJobs.list(p.project)).toEqual([]);
});
it('checks every input before acting: ids, counts, the place, the destination, methods, the body size and the project form',async()=>{
  const p=await setup(),asset=p.assets[0]!.id,ssd=await ssdFor([p.assets[0]!]);
  const refuse=async(route:string,body:unknown,status=400)=>expect((await call(route,body)).status,`${route} ${JSON.stringify(body)?.slice(0,200)}`).toBe(status);
  for(const assetIds of [undefined,[],'media-x',[asset,'../x'],[asset,42],Array.from({length:51},()=>asset)])await refuse('/media-copy/destinations',{assetIds});
  for(const customPath of ['relative/place','',42,`/${'a'.repeat(5000)}`])await refuse('/media-copy/destinations',{assetIds:[asset],customPath});
  await refuse('/media-copy/destinations',{assetIds:[asset],customPath:join(p.ssd,'missing')},404);
  // 許可された場所の中のリンクでも、たどった先が外なら選べない
  await symlink('/etc',join(p.ssd,'to-etc'));await refuse('/media-copy/destinations',{assetIds:[asset],customPath:join(p.ssd,'to-etc')},403);
  for(const destination of [undefined,{},{key:'elsewhere',uuid:'SSD',dev:1},{key:ssd.key,uuid:'',dev:ssd.volume.dev},{key:ssd.key,uuid:'SSD',dev:-1},{key:ssd.key,uuid:'SSD',dev:1.5},
    {key:ssd.key,uuid:'SSD',dev:'1'},{key:'custom',uuid:'SSD',dev:ssd.volume.dev},{key:ssd.key,...ssd.volume,customPath:p.ssd}])
    await refuse('/media-copy/start',{assetIds:[asset],destination});
  for(const route of ['/media-copy/cancel','/media-copy/dismiss'])for(const jobId of [undefined,'cp-1','cp-0000000000000000000g',42])await refuse(route,{jobId});
  for(const assetId of [undefined,'../x','media-nope'])await refuse('/media-copy/suppress',{assetId});
  // 取り込んだ（コピー済みの）素材はリンク素材ではない
  const managed:SequenceAsset={...p.assets[0]!,id:`media-${'c'.repeat(24)}`,name:'copied.wav',file:`.harness/assets/${'c'.repeat(64)}.wav`,fingerprint:'c'.repeat(64)};addToDocument(p.project,[managed]);
  await refuse('/media-copy/destinations',{assetIds:[asset,managed.id]});await refuse('/media-copy/start',{assetIds:[managed.id],destination:{key:ssd.key,...ssd.volume}});
  await refuse('/media-copy/suppress',{assetId:managed.id});
  // 読むだけの経路は GET、変える経路は POST だけ
  for(const route of ['/media-copy/jobs','/media-copy/advice'])await refuse(route,{},405);
  for(const route of ['/media-copy/destinations','/media-copy/start','/media-copy/cancel','/media-copy/dismiss','/media-copy/suppress'])expect((await call(route)).status).toBe(405);
  // 本文の大きさの上限（64KiB）と形
  expect((await call('/media-copy/destinations',undefined,{raw:JSON.stringify({assetIds:[asset],pad:'x'.repeat(70_000)})})).status).toBe(413);
  expect((await call('/media-copy/destinations',undefined,{raw:'{'})).status).toBe(400);
  expect((await call('/media-copy/destinations',undefined,{raw:'[]'})).status).toBe(400);
  // 新形式でない案件
  await mkdir(join(dirname(p.project),'old','.harness'),{recursive:true});expect((await call('/media-copy/jobs',undefined,{id:'old'})).status).toBe(409);
  expect(await mediaCopyJobs.list(p.project)).toEqual([]);expect(await readdir(p.ssd)).toEqual(['to-etc']);
},20000);
it('shows fixed reasons, never a path or an English system message',async()=>{
  const p=await setup();
  const outside=await call<{error:string}>('/media-copy/destinations',{assetIds:[p.assets[0]!.id],customPath:'/etc'});
  expect(outside.status).toBe(403);expect(outside.json.error).not.toContain('/');
  const missing=await call<{error:string}>('/media-copy/destinations',{assetIds:[p.assets[0]!.id],customPath:join(p.ssd,'nothing-here')});
  expect(missing.status).toBe(404);expect(missing.json.error).not.toContain('/');
  const harness=join(p.project,'.harness'),logged=vi.spyOn(console,'error').mockImplementation(()=>undefined);await chmod(harness,0o555);
  try{
    expect(await call('/media-copy/suppress',{assetId:p.assets[0]!.id})).toEqual({status:500,json:{error:'「今後この場所では出さない」を記録できません（EACCES）'}});
    expect(String(logged.mock.calls.at(-1)?.[1])).toContain('EACCES');   // 元の本文はログにだけ残す
  }
  finally{await chmod(harness,0o755);}
});
it('answers the open-time advice for the links of the document and remembers "not again" for the current connection',async()=>{
  const p=await setup();
  expect((await call<SlowMediaAdvice>('/media-copy/advice')).json).toEqual({targets:[],totalBytes:0,totalSeconds:0,unmeasured:0});   // 登録時に照合済み
  // 元の更新時刻が変わると照合済みでなくなる（読み取りの速さもまだ測れていない）
  const later=new Date(Date.now()+60_000);await utimes(p.sources[0]!,later,later);
  expect((await call<SlowMediaAdvice>('/media-copy/advice')).json).toEqual({targets:[],totalBytes:0,totalSeconds:0,unmeasured:1});
  expect((await call('/media-copy/suppress',{assetId:p.assets[0]!.id})).status).toBe(200);
  expect(JSON.parse(await readFile(join(p.project,'.harness/slow-media.json'),'utf8')).entries[p.assets[0]!.id]).toEqual({target:p.sources[0],volume:'SD'});
  expect((await call<SlowMediaAdvice>('/media-copy/advice')).json.unmeasured).toBe(0);
});
it('recovers the jobs of an ended process on the first list only; after that the reading routes, sync and the notices write nothing',async()=>{
  const p=await setup();
  // 前回のプロセス（pid 4242・もう終わっている）のコピーが途中で止まり、running の記録と自分の途中のファイルが残る
  const ended=new MediaCopyJobs(()=>({...p.io,self:{pid:4242,startedAt:1}}),referenceCopyPorts,new SpaceReservations());p.faults.push({op:'write',nth:2,crash:true});
  const {jobId}=await ended.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:[p.assets[0]!]});await ended.idle();p.faults.length=0;
  mediaCopyTesting.use({io:{...p.io,processAlive:()=>false}});
  const copies=join(p.ssd,COPY_ROOT_NAME,'案件-12345678'),snapshot=async()=>[...await tree(join(p.project,'.harness')),...await tree(copies)];
  const partial=async()=>(await readdir(copies)).filter(name=>name.endsWith('.harness-part'));expect(await partial()).toHaveLength(1);
  // 案内は回収しない（何も書かない。編集のセッションも作らない）
  let seen=await snapshot();expect((await call('/media-copy/advice')).status).toBe(200);expect(await snapshot()).toEqual(seen);
  // 初回の一覧が回収する（記録を書き換え、記録にある自分の途中のファイルを消す）
  expect((await call<{jobs:CopyJobView[]}>('/media-copy/jobs')).json.jobs).toEqual([expect.objectContaining({jobId,state:'stopped'})]);
  expect(await partial()).toEqual([]);expect(await snapshot()).not.toEqual(seen);
  // 2回目からは、一覧・案内・sync・通知の接続のどれも書かない
  seen=await snapshot();
  for(const route of ['/media-copy/jobs','/media-copy/advice'])expect((await call(route)).status).toBe(200);
  expect((await fetch(`${origin}/api/events/sync?id=case&ch=copy-jobs`)).status).toBe(200);
  const live=await listen();await live.until(jobs=>jobs.length===1);live.close();
  expect(await snapshot()).toEqual(seen);
});
it('never stops or closes a job of another project, running or finished',async()=>{
  const p=await setup(),other=join(dirname(p.project),'other');await mkdir(other);
  new SequenceStore(other).save({document:buildEmptyDocument('別の案件',()=>'87654321-aaaa-bbbb-cccc-000000000000'),expectedSavedRevision:null,executionId:'seed'});
  let release!:()=>void,reached!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),copying=new Promise<void>(resolve=>{reached=resolve;});
  p.faults.push({op:'write',nth:1,before:async()=>{reached();await gate;}});
  const ssd=await ssdFor([p.assets[0]!]),started=await call<{job:CopyJobView}>('/media-copy/start',{assetIds:[p.assets[0]!.id],destination:{key:ssd.key,...ssd.volume}});
  const jobId=started.json.job.jobId;await copying;
  const mine=async()=>(await call<{jobs:CopyJobView[]}>('/media-copy/jobs')).json.jobs;
  // 走っている作業: 別の案件の ID では中止も閉じるもできない（失敗しても止めた書き込みは放す。後の試験を待たせない）
  try{
    for(const route of ['/media-copy/cancel','/media-copy/dismiss'])expect((await call(route,{jobId},{id:'other'})).status,route).toBe(404);
    const running=(await mine())[0]!;expect(running).toMatchObject({jobId,state:'running'});expect(running.stopReason).toBeUndefined();
  }finally{release();}
  await mediaCopyJobs.idle();
  // 終わった作業も同じ
  for(const route of ['/media-copy/cancel','/media-copy/dismiss'])expect((await call(route,{jobId},{id:'other'})).status,route).toBe(404);
  expect(await mine()).toEqual([expect.objectContaining({jobId,state:'finished'})]);
  expect((await call<{jobs:CopyJobView[]}>('/media-copy/jobs',undefined,{id:'other'})).json.jobs).toEqual([]);expect(existsSync(join(other,'.harness','copy-jobs'))).toBe(false);
});
it('answers a wait-and-retry state with 409, keeps other Japanese reasons, and never shows an absolute path',async()=>{
  const p=await setup(),ssd=await ssdFor([p.assets[0]!]),logged=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  const startWith=async(failure:Error)=>{
    mediaCopyTesting.use({ports:{...referenceCopyPorts,connection:async()=>{throw failure;}}});
    return call('/media-copy/start',{assetIds:[p.assets[0]!.id],destination:{key:ssd.key,...ssd.volume}});
  };
  const busy=Object.assign(new Error('参照素材の接続を変更しています。完了後に再試行してください'),{busy:true});
  expect(await startWith(busy)).toEqual({status:409,json:{error:busy.message}});
  // 案件の中の相対的な場所を含む日本語の理由はそのまま（待てば直るとは限らないので 409 にはしない）
  const held=new Error('参照素材の接続変更が未完了です（.harness/references/.mutation-lock、PID 7777）。別のエディターが処理中なら完了までお待ちください');
  expect(await startWith(held)).toEqual({status:422,json:{error:held.message}});
  // 絶対パスを含むものは、待てば直る印があっても決まった文言にする
  for(const failure of [new Error(`参照素材を読めません: ${p.sources[0]}`),Object.assign(new Error(`参照素材の接続を変更しています: ${p.sources[0]}`),{busy:true})])
    expect(await startWith(failure)).toEqual({status:500,json:{error:'コピーを始められません'}});
  expect(logged).toHaveBeenCalledTimes(2);expect(await mediaCopyJobs.list(p.project)).toEqual([]);
});
it('lists a job another live editor runs as not this process\'s: no cancelling here, and no new copy while it cleans up',async()=>{
  const p=await setup();let alive=true;
  // 別のエディター（pid 7777）のコピーが途中で止まって記録が running のまま残る
  const other=new MediaCopyJobs(()=>({...p.io,self:{pid:7777,startedAt:7}}),referenceCopyPorts,new SpaceReservations());p.faults.push({op:'write',nth:2,crash:true});
  const {jobId}=await other.startReconnect({root:p.project,projectId:'case',destination:p.destination,assets:[p.assets[0]!]});await other.idle();p.faults.length=0;
  mediaCopyTesting.use({io:{...p.io,processAlive:pid=>pid===7777&&alive,processStartedAt:async pid=>pid===7777?7:undefined}});
  expect((await call<{jobs:CopyJobView[]}>('/media-copy/jobs')).json.jobs).toEqual([expect.objectContaining({jobId,state:'running',notThisProcess:true})]);
  expect(await copyJobChannelMessages(dirname(p.project),'case')).toEqual([{type:'list',jobs:[expect.objectContaining({jobId,notThisProcess:true})]}]);
  expect((await call('/media-copy/cancel',{jobId})).status).toBe(404);
  // そのエディターが後片付けの札を持つ間は始めない
  await writeFile(join(p.project,'.harness','copy-jobs',`${jobId}.recovering`),JSON.stringify({pid:7777,startedAt:7}));
  const ssd=await ssdFor([p.assets[1]!]);
  expect(await call('/media-copy/start',{assetIds:[p.assets[1]!.id],destination:{key:ssd.key,...ssd.volume}}))
    .toEqual({status:409,json:{error:'別のエディターがコピーの後片付けをしています。少し待ってからもう一度お試しください'}});
  // そのエディターが終われば、15 秒ごとの見張り（ここでは直接呼ぶ）が片付けて stopped で知らせる
  alive=false;await mediaCopyJobs.retryWaiting();
  const [after]=(await call<{jobs:CopyJobView[]}>('/media-copy/jobs')).json.jobs;expect(after).toMatchObject({jobId,state:'stopped'});expect(after!.notThisProcess).toBeUndefined();
});
it('finds the same jobs from the routes and the notices when the project folder name is stored in another Unicode form',async()=>{
  const name='が案件',p=await setup({folder:name.normalize('NFD')}),id=name.normalize('NFC'),projects=dirname(p.project);
  // ディスク上は NFD・画面の ID は NFC。JS 版の実パスの解決は渡した形（NFC）を残し、OS の解決はディスク上の形（NFD）を返す（両者が食い違う環境であること）
  expect(await readdir(projects)).toEqual([name.normalize('NFD')]);expect(realpathSync(join(projects,id))).not.toBe(realpathSync.native(join(projects,id)));
  const live=await listen(id);await live.until(jobs=>jobs.length===0);
  const ssd=await ssdFor([p.assets[0]!],id),started=await call<{job:CopyJobView}>('/media-copy/start',{assetIds:[p.assets[0]!.id],destination:{key:ssd.key,...ssd.volume}},{id});
  expect(started.status).toBe(200);await mediaCopyJobs.idle();
  await live.until(jobs=>jobs.some(job=>job.jobId===started.json.job.jobId&&job.state==='finished'&&!job.notThisProcess));
  expect((await call<{jobs:CopyJobView[]}>('/media-copy/jobs',undefined,{id})).json.jobs).toEqual([expect.objectContaining({jobId:started.json.job.jobId,state:'finished'})]);
});
