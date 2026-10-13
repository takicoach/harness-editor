// 取り込みの束（複数素材をメインに並べる）と反応速度 第1段（指紋照合の共有 §2-3・素材の索引の再利用 §2-4）の継ぎ目。
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {copyFile,mkdtemp,realpath,rm,stat,utimes} from 'node:fs/promises';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** 参照先から読まれたバイト数（パスごと）。slow のパスは1回の読みごとに待つ（後から来た照合が、先の照合の最中に届くように）。 */
const reads=vi.hoisted(()=>({bytes:new Map<string,number>(),slow:undefined as string|undefined}));
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{const handle=await actual.open(...args),read=handle.read.bind(handle) as unknown as (...x:unknown[])=>Promise<{bytesRead:number}>,key=String(args[0]);
    Object.assign(handle,{read:async(...readArgs:unknown[])=>{if(key===reads.slow)await new Promise(resolve=>setTimeout(resolve,200));
      const result=await read(...readArgs);reads.bytes.set(key,(reads.bytes.get(key)??0)+result.bytesRead);return result;}});return handle;}};});
vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs')>();
  return {...actual,createReadStream:(...args:Parameters<typeof actual.createReadStream>)=>{const stream=actual.createReadStream(...args),key=String(args[0]);
    stream.on('data',chunk=>reads.bytes.set(key,(reads.bytes.get(key)??0)+chunk.length));return stream;}};});
const digests=vi.hoisted(()=>[] as string[]);
vi.mock('./sharedDigest',async load=>{const actual=await load<typeof import('./sharedDigest')>();
  return {...actual,sharedFileDigest:(path:string,identity:string,signal?:AbortSignal)=>{digests.push(JSON.stringify([path,identity]));return actual.sharedFileDigest(path,identity,signal);}};});
import {handleApi} from '../plugin';
import {sendApiError} from '../http';
import {createSequenceProject} from './create';
import {importBatches} from './importBatches';
import type {SequenceSessionState} from './service';
import type {SequenceAsset} from '../../core/sequence/model';
import type {ImportBatchView} from '../../shared/importBatches';
import {makeVideoSamples,type VideoSamples} from './__fixtures__/videoSamples';
import {referenceVerificationTesting} from './references';

let samples:VideoSamples,root:string,server:Server,origin:string,id:string;
beforeAll(async()=>{samples=makeVideoSamples(await mkdtemp(join(await realpath(tmpdir()),'import-read-media-')));},30000);
afterAll(async()=>{await rm(samples.dir,{recursive:true,force:true});});
beforeEach(async()=>{
  vi.stubEnv('SME_BROWSE_ROOTS',samples.dir);root=await mkdtemp(join(await realpath(tmpdir()),'import-read-'));
  ({id}=await createSequenceProject(root,{name:'案件',videoName:'first.mp4',sourcePath:samples.first}));
  server=createServer((req,res)=>{void handleApi(req,res,new URL(req.url!,'http://localhost'),root).catch(error=>sendApiError(res,error));});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async()=>{reads.slow=undefined;reads.bytes.clear();digests.length=0;
  for(const batch of importBatches.list(join(root,id)))await importBatches.idle(join(root,id),batch.batchId);vi.unstubAllEnvs();
  server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true});});
const post=async(route:string,body:unknown)=>{const response=await fetch(`${origin}/api/sequence${route}?id=${encodeURIComponent(id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,json:await response.json()};};
const get=(route:string,query:Record<string,string>,init?:RequestInit)=>fetch(`${origin}/api/sequence${route}?${new URLSearchParams({id,...query})}`,init);
/** 束を作って準備を終える（リンク）。 */
async function linked(name:string){
  const source=join(samples.dir,name);await copyFile(samples.second60,source);
  const view=(await post('/imports',{requestId:name,mode:'link',origin:'ui',items:[{key:'0',name,path:source}]})).json as ImportBatchView;
  await importBatches.idle(join(root,id),view.batchId);expect(importBatches.get(join(root,id),view.batchId).phase).toBe('ready');
  return {view,path:await realpath(source),size:(await stat(source)).size};
}
const assetNamed=(state:SequenceSessionState,name:string)=>state.document.assets.find(asset=>asset.name===name) as SequenceAsset;
/** 波形を「完了」まで取る（準備中なら準備IDの完了を待って取り直す。設計 §2-2）。 */
async function waveform(asset:SequenceAsset){
  const query={asset:asset.id,stream:String(asset.streams.find(s=>s.kind==='audio')!.index),rateNum:'1',rateDen:'1',sourceInNum:'0',sourceInDen:'1',fpsNum:'30',fpsDen:'1',startFrame:'0',frameCount:'30',clipFrames:'30',bins:'10',loop:'0'};
  let body=await (await get('/waveform',query)).json();
  if(body.state==='preparing'){
    let state='preparing';for(let i=0;i<100&&state==='preparing';i++){await new Promise(resolve=>setTimeout(resolve,50));state=(await (await get('/waveform/status',{preparation:body.preparationId})).json()).preparations[body.preparationId].state;}
    body=await (await get('/waveform',query)).json();
  }
  return body;
}

it('a linked video placed through a batch is read in full once: confirm and the read routes reuse the registration check, and find it before Save',async()=>{
  reads.bytes.clear();const {view,path,size}=await linked('linked.mp4');
  expect(reads.bytes.get(path)).toBe(size);   // 登録: 調査とハッシュは同じ開いたファイル、全体読み1回（main の設計 §2-7）
  const session=(await post('/session',{})).json as SequenceSessionState;
  const confirmed=await post('/imports/confirm',{batchId:view.batchId,sessionId:session.sessionId,executionId:'c1'});expect(confirmed.status).toBe(200);
  const asset=assetNamed(confirmed.json as SequenceSessionState,'linked.mp4');expect(asset.file).toMatch(/^\.harness\/references\//);
  // 確定は保存しない: 保存済みの文書の索引には無く、読むだけの経路は登録済みの素材から見つける（§2-4 の予備の参照）。
  expect((await (await get('',{})).json()).document.assets.some((item:SequenceAsset)=>item.id===asset.id)).toBe(false);
  expect(await waveform(asset)).toMatchObject({state:'ready',bins:expect.any(Array)});
  expect((await get('/reference/status',{asset:asset.id})).status).toBe(200);
  // 確定前の照合（appendMain）・波形の照合・接続の確認は、登録が覚えた照合（rememberVerified と verifyHash の同じ鍵）を使い、読み直さない。
  expect(reads.bytes.get(path)).toBe(size);expect(digests.filter(key=>JSON.parse(key)[0]===path)).toEqual([]);
  const range=await get('/asset',{asset:asset.id},{headers:{range:'bytes=0-9'}});expect(range.status).toBe(206);expect((await range.arrayBuffer()).byteLength).toBe(10);
  const frames=await get('/frames',{asset:asset.id,stream:'0',height:'72',times:'0/1'});expect(frames.status,await frames.clone().text()).toBe(200);
},60000);

it('when the check is no longer remembered, the confirm check and a waveform request share one full read of the linked file',async()=>{
  const {view,path,size}=await linked('again.mp4');
  const later=new Date(Date.now()+5000);await utimes(path,later,later);   // 同一性が変わり、記憶済みの照合が外れる（中身は同じ）
  const session=(await post('/session',{})).json as SequenceSessionState;
  const registered=((await (await get('/assets',{})).json()).assets as SequenceAsset[]).find(item=>item.name==='again.mp4')!;
  reads.bytes.clear();digests.length=0;reads.slow=path;const joined=referenceVerificationTesting.joined;
  const [confirmed,wave]=await Promise.all([post('/imports/confirm',{batchId:view.batchId,sessionId:session.sessionId,executionId:'c2'}),waveform(registered)]);
  expect(confirmed.status).toBe(200);expect(wave).toMatchObject({state:'ready'});
  // 全体読みは1回だけ。照合は組ごとに裏の作業1本で、後から来た経路はそれに合流している（合流が無ければ共有の証拠にならない）。
  expect(reads.bytes.get(path)).toBe(size);
  const mine=digests.filter(key=>JSON.parse(key)[0]===path);expect(mine).toHaveLength(1);expect(referenceVerificationTesting.joined-joined).toBeGreaterThanOrEqual(1);
},60000);
