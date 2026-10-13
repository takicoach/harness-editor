// src/server/sequence/importBatches.decide.test.ts
// 追加時の判断待ち（設計 §2）: 判定と登録を分け、判断待ちは実行枠を握らず、束の全項目の判定後に1回だけ案内する。
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {truncate,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import type {SequenceAsset} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {HttpError} from '../http';
import {SequenceService} from './service';
import {SequenceStore} from './store';
import {buildEmptyDocument} from './createDocuments';
import {ImportBatches,type ImportCopies,type JudgeImportSource,type PrepareImportAsset} from './importBatches';
import type {AddCallbacks} from './mediaCopy/jobs';
import type {ChosenDestination} from './mediaCopy/destinations';
import {PROBE_STALL_MS,estimateTesting,judgeAddedSource} from './mediaCopy/estimate';
import type {CopyIo} from './mediaCopy/io';
import {copyWorld,type CopyWorld} from './mediaCopy/__fixtures__/copyWorld';

const MiB=2**20;
/** 指紋は名前の SHA-256（素材 ID が16進になり、slow-media.json の形の検査を通る）。 */
const fake=(name:string):SequenceAsset=>{const fingerprint=createHash('sha256').update(name).digest('hex');
  return {id:`media-${fingerprint.slice(0,24)}`,kind:'media',file:`.harness/references/${fingerprint}.mp4`,name,fingerprint,streams:[{index:0,kind:'video',codec:'h264',duration:r(1),frameRate:r(30),width:160,height:90}]};};
let dir='',sessions:SequenceService,prepared:Map<string,SequenceAsset>,judged:string[],started:Array<{root:string;items:Array<{batchItemId:string;source:string;expectedFingerprint?:string}>;callbacks:AddCallbacks}>,
  cancelled:string[],cancelledRoots:string[],expectations:Array<string|undefined>,gates:Map<string,()=>void>;
const prepare:PrepareImportAsset=async({name,expectedFingerprint})=>{expectations.push(expectedFingerprint);
  if(name.includes('hold'))await new Promise<void>(resolve=>gates.set(name,resolve));
  const asset=fake(name);prepared.set(asset.id,asset);return asset;};
/** 名前に slow を含む素材だけが「照合に 100 秒かかる見込み」。名前に nouuid を含む素材はドライブを識別できない。実際のファイルは開かない。 */
const judge:JudgeImportSource=async path=>{judged.push(path);const slow=path.includes('slow');
  return {slow,external:true,measured:true,sizeBytes:100*MiB,seconds:slow?100:10,bytesPerSecond:slow?MiB:10*MiB,...(path.includes('nouuid')?{}:{volumeUuid:'SD'})};};
const copies:ImportCopies={startAdd:async input=>{started.push(input);},cancelBatch:(root,batchId)=>{cancelled.push(batchId);cancelledRoots.push(root);}};
const make=(concurrency=2,options:{judge?:JudgeImportSource;copies?:ImportCopies;judgeLimitMs?:number}={})=>
  new ImportBatches(prepare,async(_root,assetId)=>prepared.get(assetId),concurrency,{judge:options.judge??judge,copies:options.copies??copies,...(options.judgeLimitMs?{judgeLimitMs:options.judgeLimitMs}:{})});
const input=(names:string[],origin:{kind:'ui'}|{kind:'agent';operationId:string}={kind:'ui'},requestId='r1')=>({requestId,projectId:'case',origin,mode:'link' as const,
  items:names.map((name,index)=>({key:String(index),name,source:{kind:'path' as const,path:`/Volumes/SD/${name}`}}))});
const destination={key:'volume:SSD'} as unknown as ChosenDestination;
const fingerprintOf=(text:string)=>createHash('sha256').update(text).digest('hex');
beforeEach(()=>{dir=realpathSync(mkdtempSync(join(tmpdir(),'import-decide-')));sessions=new SequenceService();prepared=new Map();judged=[];started=[];cancelled=[];cancelledRoots=[];expectations=[];gates=new Map();
  new SequenceStore(dir).save({document:buildEmptyDocument('空',()=>'doc'),expectedSavedRevision:null,executionId:'seed'});});
afterEach(()=>{for(const resume of gates.values())resume();rmSync(dir,{recursive:true,force:true});});

it('judges each item first, holds only the slow ones for a decision, and prepares the others meanwhile; never returns the real path',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b.mp4','c-slow.mp4']));await batches.idle(dir,view.batchId);
  const now=batches.get(dir,view.batchId);
  expect(now.items.map(item=>item.phase)).toEqual(['awaiting-decision','ready','awaiting-decision']);expect(now.phase).toBe('deciding');
  expect(now.decision).toEqual({itemIds:['i0','i2'],totalBytes:200*MiB,totalSeconds:200});expect(now.items[0]!.slow).toEqual({sizeBytes:100*MiB,seconds:100});
  expect(JSON.stringify(now)).not.toContain('/Volumes/SD');expect(JSON.stringify(batches.list(dir))).not.toContain('/Volumes/SD');
  // 判断待ちの項目は登録しない（登録したのは遅くない1本だけ）
  expect([...prepared.values()].map(asset=>asset.name)).toEqual(['b.mp4']);
});
it('judges the whole batch before registering any of it: no full read overlaps a leading read of the same card',async()=>{
  const reads:Array<{kind:'probe'|'full';name:string;start:number;end:number}>=[],now=()=>performance.now();
  const timedJudge:JudgeImportSource=async(path,signal,session)=>{const start=now();await new Promise(resolve=>setTimeout(resolve,15));reads.push({kind:'probe',name:path,start,end:now()});return judge(path,signal,session);};
  const timedPrepare:PrepareImportAsset=async options=>{const start=now();await new Promise(resolve=>setTimeout(resolve,15));const asset=await prepare(options);reads.push({kind:'full',name:options.path,start,end:now()});return asset;};
  const batches=new ImportBatches(timedPrepare,async(_root,assetId)=>prepared.get(assetId),2,{judge:timedJudge,copies});
  const view=batches.create(dir,input(['a.mp4','b.mp4','c-slow.mp4','d.mp4']));await batches.idle(dir,view.batchId);
  const probes=reads.filter(read=>read.kind==='probe'),full=reads.filter(read=>read.kind==='full');
  expect(probes).toHaveLength(4);expect(full.map(read=>read.name)).toEqual(['/Volumes/SD/a.mp4','/Volumes/SD/b.mp4','/Volumes/SD/d.mp4']);
  expect(Math.max(...probes.map(read=>read.end))).toBeLessThanOrEqual(Math.min(...full.map(read=>read.start)));
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'deciding',items:[{phase:'ready'},{phase:'ready'},{phase:'awaiting-decision'},{phase:'ready'}]});
});
it('registers a judged item without waiting for items not handed over yet (the browser hands them over one by one); the decision still waits for every item',async()=>{
  const batches=make(),view=batches.create(dir,{requestId:'r5',projectId:'case',origin:{kind:'home'},mode:'link',
    items:[{key:'0',name:'a.mp4',source:{kind:'client'}},{key:'1',name:'b-slow.mp4',source:{kind:'client'}},{key:'2',name:'c.mp4',source:{kind:'client'}}]});
  batches.deliverPath(dir,view.batchId,'i0','/Volumes/SD/a.mp4');await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['ready','waiting','waiting']);
  batches.deliverPath(dir,view.batchId,'i1','/Volumes/SD/b-slow.mp4');await batches.idle(dir,view.batchId);
  // 案内は全項目（未受け渡しを含む）の判定が終わってから1回
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'preparing',items:[{phase:'ready'},{phase:'awaiting-decision'},{phase:'waiting'}]});
  expect(batches.get(dir,view.batchId).decision).toBeUndefined();
  batches.abandon(dir,view.batchId,['i2']);
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'deciding',decision:{itemIds:['i1']},items:[{phase:'ready'},{phase:'awaiting-decision'},{phase:'failed'}]});
});
it('judges an item handed over during a registration only after that registration ends: no full read overlaps a leading read of the same card',async()=>{
  const batches=make(),view=batches.create(dir,{requestId:'r6',projectId:'case',origin:{kind:'home'},mode:'link',
    items:[{key:'0',name:'a-hold.mp4',source:{kind:'client'}},{key:'1',name:'b.mp4',source:{kind:'client'}},{key:'2',name:'c.mp4',source:{kind:'client'}}]});
  batches.deliverPath(dir,view.batchId,'i0','/Volumes/SD/a-hold.mp4');await vi.waitFor(()=>expect(gates.has('a-hold.mp4')).toBe(true));   // 1本目の登録（全体の読み）が始まった
  batches.deliverPath(dir,view.batchId,'i1','/Volumes/SD/b.mp4');await new Promise(resolve=>setTimeout(resolve,30));
  expect(judged).toEqual(['/Volumes/SD/a-hold.mp4']);expect(batches.get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['probing','waiting','waiting']);
  gates.get('a-hold.mp4')!();await batches.idle(dir,view.batchId);
  expect(judged).toEqual(['/Volumes/SD/a-hold.mp4','/Volumes/SD/b.mp4']);expect(batches.get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['ready','ready','waiting']);
});
it('offers the decision once, only after every item was judged',async()=>{
  const batches=make(),view=batches.create(dir,{requestId:'r2',projectId:'case',origin:{kind:'ui'},mode:'link',
    items:[{key:'0',name:'a-slow.mp4',source:{kind:'client'}},{key:'1',name:'b-slow.mp4',source:{kind:'client'}}]});
  batches.deliverPath(dir,view.batchId,'i0','/Volumes/SD/a-slow.mp4');await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).decision).toBeUndefined();
  // 全項目の判定の前は決められない（決めた後に判定が終わった項目で2回目の案内を出さない）
  await expect(batches.decide(dir,view.batchId,{choice:'keep-once',projectId:'case'})).rejects.toMatchObject({status:409,reason:'IMPORT_NOT_READY'});
  batches.deliverPath(dir,view.batchId,'i1','/Volumes/SD/b-slow.mp4');await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).decision?.itemIds).toEqual(['i0','i1']);
});
it('does not hold the registration slot while waiting for a decision',async()=>{
  const batches=make(1),view=batches.create(dir,input(['a-slow.mp4','b.mp4']));await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['awaiting-decision','ready']);
  // 判断待ちの束があっても、別の束の登録は進む
  const other=batches.create(dir,input(['c.mp4'],{kind:'ui'},'r-other'));await batches.idle(dir,other.batchId);expect(batches.get(dir,other.batchId).phase).toBe('ready');
});
it('refuses to place the batch until it is decided',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b.mp4']));await batches.idle(dir,view.batchId);const state=sessions.open(dir);
  await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c1'},sessions)).rejects.toMatchObject({status:409,reason:'IMPORT_DECIDING'});
  await expect(batches.confirm(dir,view.batchId,{sessionId:state.sessionId,executionId:'c2',skipFailed:true},sessions)).rejects.toMatchObject({status:409,reason:'IMPORT_DECIDING'});
  expect(sessions.open(dir).document.clips).toEqual([]);
});
it('"今回はこのまま" prepares the held items from the remembered place and keeps the choice on the item',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b.mp4']));await batches.idle(dir,view.batchId);
  expect((await batches.decide(dir,view.batchId,{choice:'keep-once',projectId:'case'})).items[0]!.choice).toBe('keep-once');await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'ready',items:[{phase:'ready',choice:'keep-once',assetId:fake('a-slow.mp4').id},{phase:'ready'}]});
  expect(batches.get(dir,view.batchId).decision).toBeUndefined();expect(existsSync(join(dir,'.harness/slow-media.json'))).toBe(false);
  // 準備済みになった項目は記録に実パスを残さない（再起動後に読み直しても同じ）
  expect(readFileSync(join(dir,`.harness/imports/${view.batchId}.json`),'utf8')).not.toContain('/Volumes/SD');expect(make().get(dir,view.batchId).phase).toBe('ready');
  // 決めた後はもう判断待ちが無い
  await expect(batches.decide(dir,view.batchId,{choice:'keep-once',projectId:'case'})).rejects.toMatchObject({status:409,reason:'IMPORT_NO_DECISION'});
});
it('"この接続先では今後出さない" is carried over to the asset ID with the connection once registered',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4']));await batches.idle(dir,view.batchId);
  await batches.decide(dir,view.batchId,{choice:'keep-always',projectId:'case'});await batches.idle(dir,view.batchId);
  await vi.waitFor(()=>expect(JSON.parse(readFileSync(join(dir,'.harness/slow-media.json'),'utf8')).entries[fake('a-slow.mp4').id]).toEqual({target:'/Volumes/SD/a-slow.mp4',volume:'SD'}));
});
it('a drive it cannot identify cannot be remembered: the view says so and the choice falls back to this time only',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow-nouuid.mp4']));await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).items[0]!.slow).toEqual({sizeBytes:100*MiB,seconds:100,canRemember:false});
  await batches.decide(dir,view.batchId,{choice:'keep-always',projectId:'case'});await batches.idle(dir,view.batchId);
  expect(batches.get(dir,view.batchId).items[0]).toMatchObject({phase:'ready',choice:'keep-once'});expect(existsSync(join(dir,'.harness/slow-media.json'))).toBe(false);
});
it('"速いドライブへコピー" hands the held items to the copy job and takes back its results',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b-slow.mp4','c.mp4']));await batches.idle(dir,view.batchId);
  expect(batches.copyInput(dir,view.batchId)).toEqual({sources:[{path:'/Volumes/SD/a-slow.mp4',sizeBytes:100*MiB},{path:'/Volumes/SD/b-slow.mp4',sizeBytes:100*MiB}],sourceBytesPerSecond:MiB});
  await batches.decide(dir,view.batchId,{choice:'copy',projectId:'case',destination});
  expect(started[0]!.items.map(item=>[item.batchItemId,item.source])).toEqual([['i0','/Volumes/SD/a-slow.mp4'],['i1','/Volumes/SD/b-slow.mp4']]);expect(started[0]!.root).toBe(realpathSync.native(dir));
  expect(batches.get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['copying','copying','ready']);expect(batches.get(dir,view.batchId).phase).toBe('preparing');
  expect(batches.copyInput.bind(batches,dir,view.batchId)).toThrow('判断を待っている動画がありません');
  started[0]!.callbacks.done('i0',fake('a-copy.mp4'));started[0]!.callbacks.failed('i1','コピー中に元の素材が変更されました');
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'partial',items:[{phase:'ready',assetId:fake('a-copy.mp4').id},{phase:'failed',error:'コピー中に元の素材が変更されました'},{phase:'ready'}]});
  // 再起動後に読み直しても同じ（結果は記録にも残る）。実パスは残さない
  const record=readFileSync(join(dir,`.harness/imports/${view.batchId}.json`),'utf8');expect(record).not.toContain('/Volumes/SD');
  expect(make().get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['ready','failed','ready']);
});
it('keeps the expected fingerprint of a held item: for keeping it where it is, and against the copy',async()=>{
  const expected=fingerprintOf('picked'),batches=make(),view=batches.create(dir,{requestId:'r3',projectId:'case',origin:{kind:'ui'},mode:'link',
    items:[{key:'0',name:'a-slow.mp4',source:{kind:'client'}},{key:'1',name:'b-slow.mp4',source:{kind:'client'}}]});
  batches.deliverPath(dir,view.batchId,'i0','/Volumes/SD/a-slow.mp4',expected);batches.deliverPath(dir,view.batchId,'i1','/Volumes/SD/b-slow.mp4',fake('b-slow.mp4').fingerprint);
  await batches.idle(dir,view.batchId);expect(readFileSync(join(dir,`.harness/imports/${view.batchId}.json`),'utf8')).toContain(expected);
  await batches.decide(dir,view.batchId,{choice:'copy',projectId:'case',destination});
  // コピーの作業にも期待する指紋を渡す（中身の違いはコピー中に止まる）
  expect(started[0]!.items.map(item=>item.expectedFingerprint)).toEqual([expected,fake('b-slow.mp4').fingerprint]);
  // コピーした中身が画面で選んだ素材と違えば（コピーまでの間に元が変わった）並べない
  started[0]!.callbacks.done('i0',fake('changed.mp4'));started[0]!.callbacks.done('i1',fake('b-slow.mp4'));
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'partial',items:[{phase:'failed',error:'選択した素材の指紋と現在の参照先が一致しません'},{phase:'ready'}]});
  const kept=batches.create(dir,{requestId:'r4',projectId:'case',origin:{kind:'ui'},mode:'link',items:[{key:'0',name:'c-slow.mp4',source:{kind:'client'}}]});
  batches.deliverPath(dir,kept.batchId,'i0','/Volumes/SD/c-slow.mp4',expected);await batches.idle(dir,kept.batchId);
  await batches.decide(dir,kept.batchId,{choice:'keep-once',projectId:'case'});await batches.idle(dir,kept.batchId);expect(expectations.at(-1)).toBe(expected);
});
it('"残りを中止" returns the unfinished items to the decision',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b-slow.mp4']));await batches.idle(dir,view.batchId);
  await batches.decide(dir,view.batchId,{choice:'copy',projectId:'case',destination});started[0]!.callbacks.done('i0',fake('a-copy.mp4'));started[0]!.callbacks.stopped(['i1']);
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'deciding',decision:{itemIds:['i1']},items:[{phase:'ready'},{phase:'awaiting-decision'}]});
  expect(batches.get(dir,view.batchId).items[1]!.choice).toBeUndefined();
  // もう一度選べる（コピーの元は覚えたまま）
  expect(batches.copyInput(dir,view.batchId).sources).toEqual([{path:'/Volumes/SD/b-slow.mp4',sizeBytes:100*MiB}]);
});
it('a copy that cannot start returns the items to the decision and gives the reason',async()=>{
  const refusing:ImportCopies={startAdd:async()=>{throw new HttpError(409,'コピー先の空きが足りません');},cancelBatch:()=>undefined};
  const batches=make(2,{copies:refusing}),view=batches.create(dir,input(['a-slow.mp4']));await batches.idle(dir,view.batchId);
  await expect(batches.decide(dir,view.batchId,{choice:'copy',projectId:'case',destination})).rejects.toMatchObject({status:409,message:'コピー先の空きが足りません'});
  expect(batches.get(dir,view.batchId)).toMatchObject({phase:'deciding',decision:{itemIds:['i0']},items:[{phase:'awaiting-decision'}]});expect(batches.get(dir,view.batchId).items[0]!.choice).toBeUndefined();
  await expect(batches.decide(dir,view.batchId,{choice:'copy',projectId:'case'})).rejects.toMatchObject({status:400});
});
it('cancelling the batch also stops its copy',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b.mp4']));await batches.idle(dir,view.batchId);
  await batches.decide(dir,view.batchId,{choice:'copy',projectId:'case',destination});batches.cancel(dir,view.batchId);
  expect(cancelled).toEqual([view.batchId]);expect(cancelledRoots).toEqual([realpathSync.native(dir)]);expect(batches.get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['cancelled','ready']);
  // 取り消した後に届いた結果は束を変えない
  started[0]!.callbacks.done('i0',fake('a-copy.mp4'));expect(batches.get(dir,view.batchId).items[0]!.phase).toBe('cancelled');
  await expect(batches.decide(dir,view.batchId,{choice:'keep-once',projectId:'case'})).rejects.toMatchObject({status:409,reason:'IMPORT_CLOSED'});
});
it('cancelling a batch that waits for a decision cancels the held items and forgets where they are',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4','b.mp4']));await batches.idle(dir,view.batchId);
  expect(batches.cancel(dir,view.batchId)).toMatchObject({phase:'cancelled',items:[{phase:'cancelled'},{phase:'ready'}]});expect(batches.get(dir,view.batchId).decision).toBeUndefined();
  expect(readFileSync(join(dir,`.harness/imports/${view.batchId}.json`),'utf8')).not.toContain('/Volumes/SD');expect(started).toEqual([]);
  expect(make().get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['cancelled','ready']);
});
it('a batch cancelled while its copy is being started stops that copy once it exists',async()=>{
  let begin!:()=>void;const slow:ImportCopies={startAdd:async input=>{started.push(input);await new Promise<void>(resolve=>{begin=resolve;});},cancelBatch:(_root,batchId)=>{cancelled.push(batchId);}};
  const batches=make(2,{copies:slow}),view=batches.create(dir,input(['a-slow.mp4']));await batches.idle(dir,view.batchId);
  const deciding=batches.decide(dir,view.batchId,{choice:'copy',projectId:'case',destination});await vi.waitFor(()=>expect(started).toHaveLength(1));
  batches.cancel(dir,view.batchId);expect(cancelled).toEqual([view.batchId]);begin();await deciding;
  expect(cancelled).toEqual([view.batchId,view.batchId]);expect(batches.get(dir,view.batchId).phase).toBe('cancelled');
});
it('cancelling while judging stops the judgement and leaves nothing to decide',async()=>{
  const signals:AbortSignal[]=[],waiting:JudgeImportSource=(_path,signal)=>{signals.push(signal);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  const batches=make(2,{judge:waiting}),view=batches.create(dir,input(['a-slow.mp4','b-slow.mp4']));
  await vi.waitFor(()=>expect(batches.get(dir,view.batchId).items[0]!.phase).toBe('judging'));
  // 判定は束の中で1本ずつ（同じ媒体の試し読みを重ねない）
  expect(batches.get(dir,view.batchId).items[1]!.phase).toBe('waiting');expect(batches.get(dir,view.batchId).decision).toBeUndefined();
  batches.cancel(dir,view.batchId);await batches.idle(dir,view.batchId);
  expect(signals).toHaveLength(1);expect(signals[0]!.aborted).toBe(true);expect(batches.get(dir,view.batchId)).toMatchObject({phase:'cancelled',items:[{phase:'cancelled'},{phase:'cancelled'}]});
  expect(prepared.size).toBe(0);
});
it('a judgement that fails or does not return in time registers as before (the batch never stays undecided)',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
  try{
    const signals:AbortSignal[]=[],stuck:JudgeImportSource=(path,signal)=>{signals.push(signal);return path.includes('broken')?Promise.reject(new Error('読めません')):new Promise(()=>undefined);};
    const batches=make(2,{judge:stuck,judgeLimitMs:30}),view=batches.create(dir,input(['a-slow.mp4','b-broken.mp4']));await batches.idle(dir,view.batchId);
    expect(batches.get(dir,view.batchId)).toMatchObject({phase:'ready',items:[{phase:'ready'},{phase:'ready'}]});expect(signals[0]!.aborted).toBe(true);
  }finally{warn.mockRestore();}
});
it('after a restart: a decision is still possible, copying returns to the decision, judging fails',async()=>{
  const first=make(),view=first.create(dir,input(['a-slow.mp4','b-slow.mp4']));await first.idle(dir,view.batchId);
  await first.decide(dir,view.batchId,{choice:'copy',projectId:'case',destination});
  const second=make();expect(second.get(dir,view.batchId).items.map(item=>item.phase)).toEqual(['awaiting-decision','awaiting-decision']);
  expect(second.get(dir,view.batchId).decision?.itemIds).toEqual(['i0','i1']);
  await second.decide(dir,view.batchId,{choice:'keep-once',projectId:'case'});await second.idle(dir,view.batchId);expect(second.get(dir,view.batchId).phase).toBe('ready');
  const stuck=make(2,{judge:()=>new Promise(()=>undefined)}),other=stuck.create(dir,input(['x.mp4'],{kind:'ui'},'r9'));
  await vi.waitFor(()=>expect(stuck.get(dir,other.batchId).items[0]!.phase).toBe('judging'));
  expect(make().get(dir,other.batchId).items[0]).toMatchObject({phase:'failed',error:expect.stringContaining('サーバーが停止')});
});
it('after a restart, an item being registered after "このまま" returns to the decision; one being registered without a decision fails as before',async()=>{
  const first=make(),view=first.create(dir,input(['a-slow-hold.mp4','b-hold.mp4']));
  await vi.waitFor(()=>expect(gates.has('b-hold.mp4')).toBe(true));await vi.waitFor(()=>expect(first.get(dir,view.batchId).items[0]!.phase).toBe('awaiting-decision'));
  await first.decide(dir,view.batchId,{choice:'keep-once',projectId:'case'});gates.get('b-hold.mp4')!();
  await vi.waitFor(()=>expect(gates.has('a-slow-hold.mp4')).toBe(true));
  expect(make().get(dir,view.batchId)).toMatchObject({phase:'deciding',decision:{itemIds:['i0']},items:[{phase:'awaiting-decision'},{phase:'ready'}]});
  gates.get('a-slow-hold.mp4')!();await first.idle(dir,view.batchId);   // 同じ案件のリンク登録は1件ずつなので、次の束の前に通す
  const other=first.create(dir,input(['c-hold.mp4'],{kind:'ui'},'r-other'));await vi.waitFor(()=>expect(gates.has('c-hold.mp4')).toBe(true));
  expect(make().get(dir,other.batchId).items[0]).toMatchObject({phase:'failed',error:expect.stringContaining('サーバーが停止')});
  gates.get('c-hold.mp4')!();await first.idle(dir,other.batchId);
});
it('reads a record written before the decision existed',()=>{
  const batchId='imp-0123456789abcdef0123';mkdirSync(join(dir,'.harness/imports'),{recursive:true});
  writeFileSync(join(dir,`.harness/imports/${batchId}.json`),JSON.stringify({version:1,batchId,projectId:'case',createdAt:'2026-10-02T00:00:00.000Z',requestId:'old',requestKey:'a'.repeat(64),
    origin:{kind:'ui'},mode:'link',placement:'append-main',state:'open',items:[{itemId:'i0',key:'0',name:'a.mp4',phase:'ready',assetId:fake('a.mp4').id,durationSeconds:1},{itemId:'i1',key:'1',name:'b.mp4',phase:'fingerprinting'}]}));
  const batches=make();expect(batches.list(dir).map(batch=>batch.batchId)).toEqual([batchId]);
  expect(batches.get(dir,batchId)).toMatchObject({phase:'partial',items:[{phase:'ready'},{phase:'failed',error:expect.stringContaining('サーバーが停止')}]});
  expect(batches.get(dir,batchId).decision).toBeUndefined();
});
it('never holds AI imports or uploaded copies for a decision',async()=>{
  const batches=make(),view=batches.create(dir,input(['a-slow.mp4'],{kind:'agent',operationId:'op1'}));await batches.idle(dir,view.batchId);
  expect(judged).toEqual([]);expect(batches.get(dir,view.batchId).phase).toBe('ready');
  const copy=batches.create(dir,{requestId:'r-copy',projectId:'case',origin:{kind:'ui'},mode:'copy',items:[{key:'0',name:'b-slow.mp4',source:{kind:'client'}}]});
  batches.deliverFile(dir,copy.batchId,'i0',{path:'/tmp/upload/b-slow.mp4',cleanup:async()=>undefined});await batches.idle(dir,copy.batchId);
  expect(judged).toEqual([]);expect(batches.get(dir,copy.batchId).phase).toBe('ready');
  await expect(batches.decide(dir,copy.batchId,{choice:'keep-once',projectId:'case'})).rejects.toMatchObject({status:409,reason:'IMPORT_NO_DECISION'});
});
describe('a drive whose leading read times out (m2)',()=>{
  const parked:(()=>void)[]=[],park=()=>new Promise<void>(resume=>parked.push(resume));
  let world:CopyWorld|undefined;
  afterEach(async()=>{for(const resume of parked.splice(0))resume();estimateTesting.stallMs=PROBE_STALL_MS;await world?.cleanup();world=undefined;});
  const sparse=async(path:string)=>{await writeFile(path,'');await truncate(path,100*MiB);};
  const opens=(drive:string)=>world!.faulty.calls.filter(call=>call.op==='open'&&call.path.startsWith(`${drive}/`)).length;
  /** カードに3本、SSD に1本。束は受付順（名前順）に判定する。 */
  const batchOn=async(io:CopyIo,judgeLimitMs?:number)=>{
    const paths=[...['a.mp4','b.mp4','c.mp4'].map(name=>join(world!.sd,name)),join(world!.ssd,'d.mp4')];for(const path of paths)await sparse(path);
    const batches=make(2,{judge:(path,signal,session)=>judgeAddedSource(io,path,signal,session),...(judgeLimitMs?{judgeLimitMs}:{})});
    const view=batches.create(dir,{requestId:'r-stall',projectId:'case',origin:{kind:'home'},mode:'link',items:paths.map((path,index)=>({key:String(index),name:basename(path),source:{kind:'path',path}}))});
    await batches.idle(dir,view.batchId);return batches.get(dir,view.batchId);
  };
  it('after one leading read on the card stalls, the rest of the card is not read (unmeasured, registered as before); the other drive is still measured',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    try{
      estimateTesting.stallMs=50;world=await copyWorld();world.faults.push({op:'read',path:/\/sd\//,before:park});
      const started=Date.now(),now=await batchOn(world.io);
      expect(opens(world.sd)).toBe(1);expect(opens(world.ssd)).toBe(1);expect(Date.now()-started).toBeLessThan(2000);
      expect(now).toMatchObject({phase:'ready',items:[{phase:'ready'},{phase:'ready'},{phase:'ready'},{phase:'ready'}]});
    }finally{warn.mockRestore();}
  });
  it('a judgement that runs out of time while reading the card also stops the rest of the card being read, even before that read has cleaned up',async()=>{
    const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
    try{
      world=await copyWorld();const sd=world.sd;
      // 読みの間（待ち）で判定の上限に達し、ファイルを閉じるのに時間がかかる（諦めた判定の後始末を待たずに次の項目へ進む）
      const io:CopyIo={...world.io,throttle:(purpose,path,bytes,signal)=>path.startsWith(`${sd}/`)
        ?new Promise<void>((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason),{once:true})):world!.io.throttle(purpose,path,bytes,signal)};
      world.faults.push({op:'close',path:/\/sd\//,before:()=>new Promise(resolve=>setTimeout(resolve,200))});
      const now=await batchOn(io,30);
      expect(opens(sd)).toBe(1);expect(opens(world.ssd)).toBe(1);expect(now.phase).toBe('ready');
      await new Promise(resolve=>setTimeout(resolve,250));   // 閉じ終えてから片付ける
    }finally{warn.mockRestore();}
  });
});
