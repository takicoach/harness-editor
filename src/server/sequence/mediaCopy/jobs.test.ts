// コピーの作業（設計 §5・§6）: ジョブ記録・1本ずつ・残りを中止・接続の変更。
// 合否は「エラーが出たか」ではなく、既存ファイルの中身・参照先・持ち主の違うファイル・元のファイルが守られたかで判定する（各段の失敗・強制終了・中止の注入）。
// どの作業の終わり（成功・失敗・残りを中止・予約の待ちの途中の中止・試験上の強制終了）でも、元の読み取りの予約（Task 9）が残っていないことを afterEach で確かめる。
import {afterEach,describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {chmod,copyFile,mkdir,readFile,readdir,rename,stat,symlink,unlink,utimes,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {SequenceAsset} from '../../../core/sequence/model';
import {CREATE_EXCLUSIVE,READ_ONLY,SimulatedCrash,WRITE_FLAGS,type IoCall,type IoFault} from './io';
import {COPY_ROOT_NAME} from './volumes';
import {SpaceReservations} from './space';
import {PART_SUFFIX,removeOwnedCopyFiles} from './copyItem';
import {LedgerUnreadableError,ledgerConnects,readCopyJobRecords,type CopyJobItemRecord,type LedgerPorts} from './jobRecord';
import {MediaCopyJobs,referenceCopyPorts,type CopyPorts} from './jobs';
import {ReferenceConnectUnknown,claimReferenceCopy,reconnectSequenceReference,referenceTarget,referenceVerificationTesting,registeredSequenceReferences,sequenceReferenceStatus} from '../references';
import {GiB} from './__fixtures__/copyWorld';
import {copyProject,wav,type CopyProject} from './__fixtures__/copyProject';

let p:CopyProject|undefined;
const digestDelay=process.env.HARNESS_TEST_DIGEST_DELAY_MS;
afterEach(async()=>{
  try{
    if(p){
      // 元の媒体（SD）には読み取り専用で開く・読む・閉じる・調べる以外をしていない
      const onSource=(call:IoCall)=>[call.path,call.from].some(path=>path!==undefined&&(path===p!.sd||path.startsWith(`${p!.sd}/`)));
      expect(p.faulty.calls.filter(call=>onSource(call)&&!(call.op==='open'?call.flags===READ_ONLY:['read','close','stat','lstat','statfs','volumeDetails'].includes(call.op)))).toEqual([]);
      expect(referenceVerificationTesting.claims()).toBe(0);
    }
  }finally{
    if(digestDelay===undefined)delete process.env.HARNESS_TEST_DIGEST_DELAY_MS;else process.env.HARNESS_TEST_DIGEST_DELAY_MS=digestDelay;
    await referenceVerificationTesting.idle();referenceVerificationTesting.forget();await p?.cleanup();p=undefined;
  }
});
const sha=async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex');
const folder=()=>join(p!.ssd,COPY_ROOT_NAME,'案件-12345678');
/** コピー先の一覧（exFAT の `._` の付随ファイルは除く）。 */
const files=async()=>(await readdir(folder()).catch(()=>[] as string[])).filter(name=>!name.startsWith('._')).sort();
const make=(ports:CopyPorts=referenceCopyPorts,reservations=new SpaceReservations())=>({jobs:new MediaCopyJobs(()=>p!.io,ports,reservations),reservations});
const record=async()=>(await readCopyJobRecords(p!.project))[0]!;
const start=(jobs:MediaCopyJobs,assets=p!.assets)=>jobs.startReconnect({root:p!.project,projectId:'case',destination:p!.destination,assets});
const view=async(jobs:MediaCopyJobs)=>(await jobs.list(p!.project))[0]!;
/** 元のファイルの指紋と更新時刻を覚え、後で変わっていないことを確かめる。 */
const keepSources=async()=>Promise.all(p!.sources.map(async path=>({path,sha:await sha(path),mtimeMs:(await stat(path)).mtimeMs})));
const sourcesIntact=async(saved:Array<{path:string;sha:string;mtimeMs:number}>)=>{for(const item of saved){expect(await sha(item.path)).toBe(item.sha);expect((await stat(item.path)).mtimeMs).toBe(item.mtimeMs);}};
const linksOnCard=async()=>{for(const [index,asset] of p!.assets.entries())expect(await referenceTarget(p!.project,asset.file)).toBe(p!.sources[index]);};
/** 持ち主の違うファイル: コピー先に同じ名前・同じ大きさで中身の違うファイルを置く（自分のコピーは「clip-1 (2).wav」になる）。 */
async function placeForeign(){await mkdir(folder(),{recursive:true});const path=join(folder(),'clip-1.wav');await writeFile(path,wav(6,77));return {path,sha:await sha(path),mtimeMs:(await stat(path)).mtimeMs};}
const foreignIntact=async(foreign:{path:string;sha:string;mtimeMs:number})=>{
  expect(await sha(foreign.path)).toBe(foreign.sha);expect((await stat(foreign.path)).mtimeMs).toBe(foreign.mtimeMs);
  // 開くのは読み取り専用か、排他作成（既にある名前では EEXIST で失敗し、中身に触れない）だけ。書き込み・同期・移動・削除はしない
  expect(p!.faulty.calls.filter(call=>(call.path===foreign.path||call.from===foreign.path)
    &&!(call.op==='open'?((call.flags??0)&WRITE_FLAGS)===0||call.flags===CREATE_EXCLUSIVE:['read','close','lstat','stat'].includes(call.op)))).toEqual([]);
};
const final2=()=>join(folder(),'clip-1 (2).wav');
const isPart=(call:IoCall)=>call.path.endsWith(PART_SUFFIX);

it('copies linked files one at a time, reconnects each to the copy, and leaves the originals untouched',async()=>{
  p=await copyProject();const sources=p.sources,before=await Promise.all(sources.map(sha)),mtimes=await Promise.all(sources.map(async path=>(await stat(path)).mtimeMs));
  let open=0,most=0;p.faults.push({op:'open',match:call=>call.flags===READ_ONLY&&sources.includes(call.path),before:()=>{open++;most=Math.max(most,open);}},
    {op:'close',match:call=>sources.includes(call.path),before:()=>{open--;}});
  const {jobs,reservations}=make(),started=await start(jobs);
  expect(started).toMatchObject({mode:'reconnect',state:'running',destination:{kind:'volume',label:'ssd'}});expect(reservations.reservedIn('apfs:disk9')).toBeGreaterThan(0);
  await jobs.idle();
  expect(most).toBe(1);expect(await files()).toEqual(['clip-1.wav','clip-2.wav']);
  for(const [index,asset] of p.assets.entries()){
    expect(await referenceTarget(p.project,asset.file)).toBe(join(folder(),`clip-${index+1}.wav`));expect(await sha(join(folder(),`clip-${index+1}.wav`))).toBe(before[index]);
    expect(await sequenceReferenceStatus(p.project,asset)).toEqual({state:'ok'});
  }
  expect(await Promise.all(sources.map(sha))).toEqual(before);expect(await Promise.all(sources.map(async path=>(await stat(path)).mtimeMs))).toEqual(mtimes);
  expect(p.faulty.calls.filter(call=>call.op==='open'&&sources.includes(call.path)).every(call=>call.flags===READ_ONLY)).toBe(true);
  expect(await record()).toMatchObject({state:'finished',items:[{phase:'done',connected:true},{phase:'done',connected:true}]});expect(reservations.reservedIn('apfs:disk9')).toBe(0);
  expect(await view(jobs)).toMatchObject({state:'finished',items:[{phase:'done',bytesDone:(await stat(sources[0]!)).size,assetId:p.assets[0]!.id},{phase:'done'}]});
});
it('writes the stage and the files it made to the job record before each next step',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const seen:string[]=[],final=join(folder(),'clip-1.wav');
  const snap=async(label:string)=>{const item=(await record()).items[0]!;
    seen.push(`${label}:${item.phase}:${[item.reserved?(item.reserved.ino!==undefined?'reserved+ino':'reserved'):'',item.part?(item.part.ino!==undefined?'part+ino':'part'):'',item.final?'final':'',item.fingerprint?'fingerprint':''].filter(Boolean).join(',')}`);};
  p.faults.push({op:'open',match:call=>call.path===final&&call.flags===CREATE_EXCLUSIVE,before:()=>snap('reserve')},{op:'write',match:call=>call.path===final,before:()=>snap('mark')},
    {op:'open',match:call=>isPart(call)&&call.flags===CREATE_EXCLUSIVE,before:()=>snap('part')},{op:'write',match:isPart,nth:1,before:()=>snap('first write')},
    {op:'open',match:call=>isPart(call)&&call.flags===READ_ONLY,before:()=>snap('re-read')},{op:'rename',before:()=>snap('rename')},
    {op:'sync',match:call=>call.path===folder(),before:()=>snap('folder sync')},{op:'open',match:call=>call.path===final&&call.flags===READ_ONLY,nth:2,before:()=>snap('reopen')});
  const {jobs}=make({...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{await snap('connect');return referenceCopyPorts.reconnect(root,asset,copy,generation);}});
  await start(jobs);await jobs.idle();
  // 予約も .part も、作る前に名前（予約は印も）だけを記録し、ino を確かめられた時に記録し直す
  expect(seen).toEqual(['reserve:copying:reserved','mark:copying:reserved+ino','part:copying:reserved+ino,part','first write:copying:reserved+ino,part+ino','re-read:verifying:reserved+ino,part+ino,fingerprint',
    'rename:verifying:reserved+ino,part+ino,fingerprint','folder sync:verifying:reserved+ino,part+ino,fingerprint','reopen:named:final,fingerprint','connect:connecting:final,fingerprint']);
  expect((await record()).items[0]).toMatchObject({phase:'done',connected:true,final:expect.any(Object)});
});
it('"残りを中止" while copying the first file keeps no half-made file and leaves every link on the card',async()=>{
  p=await copyProject();const {jobs}=make();p.faults.push({op:'write',match:isPart,nth:2,before:async()=>{jobs.cancel(p!.project,(await record()).jobId);}});
  await start(jobs);await jobs.idle();
  expect(await files()).toEqual([]);await linksOnCard();
  const result=await view(jobs);expect(result.state).toBe('stopped');expect(result.items.map(item=>item.phase)).toEqual(['cancelled','cancelled']);
  expect(result.stopReason).toContain('完了した素材はコピー先につなぎ替えたまま残します');
});
it('"残りを中止" while connecting finishes that connection and stops the rest',async()=>{
  p=await copyProject();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),connecting=new Promise<void>(resolve=>{entered=resolve;});
  const {jobs}=make({...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{entered();await gate;return referenceCopyPorts.reconnect(root,asset,copy,generation);}});
  const {jobId}=await start(jobs);await connecting;jobs.cancel(p.project,jobId);release();await jobs.idle();
  expect((await view(jobs)).items.map(item=>item.phase)).toEqual(['done','cancelled']);
  expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(join(folder(),'clip-1.wav'));expect(await referenceTarget(p.project,p.assets[1]!.file)).toBe(p.sources[1]);
  expect(await files()).toEqual(['clip-1.wav']);
});
it('stops the whole job on ENOSPC, cleans its own files and changes no link',async()=>{
  p=await copyProject();p.faults.push({op:'write',match:isPart,nth:2,error:'ENOSPC'});const {jobs}=make();await start(jobs);await jobs.idle();
  const result=await view(jobs);expect(result.state).toBe('stopped');expect(result.items.map(item=>item.phase)).toEqual(['failed','cancelled']);expect(result.items[0]!.error).toContain('ENOSPC');
  expect(await files()).toEqual([]);await linksOnCard();
});
it('stops when the free space would fall below the margin while copying',async()=>{
  p=await copyProject();const ssd=p.io.volumes.find(volume=>volume.uuid==='SSD')!;
  p.faults.push({op:'write',match:isPart,nth:1,before:()=>{ssd.free=100*GiB;p!.clock.advance(5000);}});   // 次の監視（5秒）で 100GiB − 残り < 余裕 100GiB
  const {jobs}=make();await start(jobs);await jobs.idle();
  expect(await view(jobs)).toMatchObject({state:'stopped',items:[{phase:'failed',error:expect.stringContaining('下回る見込み')},{phase:'cancelled'}]});expect(await files()).toEqual([]);await linksOnCard();
});
it('stops when the free space cannot be measured',async()=>{
  p=await copyProject();const ssd=p.io.volumes.find(volume=>volume.uuid==='SSD')!;
  p.faults.push({op:'write',match:isPart,nth:1,before:()=>{ssd.capacity=Number.NaN;p!.clock.advance(5000);}});
  const {jobs}=make();await start(jobs);await jobs.idle();
  expect(await view(jobs)).toMatchObject({state:'stopped',items:[{phase:'failed',error:expect.stringContaining('測れないため')},{phase:'cancelled'}]});expect(await files()).toEqual([]);
});
it('fails only that file when another operation reconnected it meanwhile, removes its own copy, and goes on',async()=>{
  p=await copyProject();const other=join(p.home,'other.wav');await copyFile(p.sources[0]!,other);
  p.faults.push({op:'rename',nth:1,before:()=>reconnectSequenceReference(p!.project,p!.assets[0]!,other)});
  const {jobs}=make();await start(jobs);await jobs.idle();
  const result=await view(jobs);expect(result.items.map(item=>item.phase)).toEqual(['failed','done']);expect(result.items[0]!.error).toContain('別の操作で');
  expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(other);expect(await files()).toEqual(['clip-2.wav']);
});
it.each([[true,'done',['clip-1.wav']],[false,'failed',[]]] as const)('judges an unknown result by the ledger (ledger changed=%s)',async(changed,phase,left)=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});
  const {jobs}=make({...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{if(changed)await referenceCopyPorts.reconnect(root,asset,copy,generation);throw new ReferenceConnectUnknown(new Error('試験'));}});
  await start(jobs);await jobs.idle();
  expect((await view(jobs)).items[0]!.phase).toBe(phase);expect(await files()).toEqual([...left]);
  expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(changed?join(folder(),'clip-1.wav'):p.sources[0]);
});
it('keeps the copy and the record when the result is unknown and the ledger cannot be read (another editor is changing it)',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const lock=join(p.project,'.harness','references','.mutation-lock'),final=join(folder(),'clip-1.wav');
  // 接続は変わった（台帳はコピーを指す）が、その直後に別のエディター（生きている別の pid）が台帳の変更を始めて読めない
  const {jobs}=make({...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{
    await referenceCopyPorts.reconnect(root,asset,copy,generation);
    await writeFile(lock,JSON.stringify({format:'harness-reference-mutation',version:1,pid:process.ppid,startedAt:Date.now(),token:'0d4c5a4e-1b2c-4d3e-8f90-123456789abc'})+'\n');
    throw new ReferenceConnectUnknown(new Error('試験'));}});
  await start(jobs);await jobs.idle();
  const item=(await record()).items[0]!;expect(item).toMatchObject({phase:'failed',unresolved:true,final:expect.any(Object)});expect(item.connected).toBeUndefined();
  expect((await view(jobs)).items[0]!.error).toContain('次の起動');expect(await files()).toEqual(['clip-1.wav']);
  await unlink(lock);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(final);expect(await sha(final)).toBe(await sha(p.sources[0]!));
});
it.each([
  ['the reservation sync',{op:'sync',nth:1}],
  ['the part sync',{op:'sync',match:isPart}],
  ['the folder sync',{op:'sync',match:(call:IoCall)=>call.path===folder()}],
  ['the rename',{op:'rename'}],
] as Array<[string,IoFault]>)('cleans its own files after a failure of %s and keeps the link',async(_label,fault)=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});p.faults.push({...fault,error:'EIO'});const {jobs}=make();await start(jobs);await jobs.idle();
  expect((await view(jobs)).items[0]!.phase).toBe('failed');expect(await files()).toEqual([]);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(p.sources[0]);
});
it('keeps the files it could not remove in the record for the next start',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});p.faults.push({op:'sync',match:isPart,error:'EIO'},{op:'unlink',error:'EPERM'});const {jobs}=make();await start(jobs);await jobs.idle();
  const item=(await record()).items[0]!;expect(item.phase).toBe('failed');expect(item.part).toBeDefined();expect(item.reserved).toBeDefined();
  expect((await files()).some(name=>name.endsWith(PART_SUFFIX))).toBe(true);await linksOnCard();
});
it('stops when the copy folder was replaced between files and writes nothing into the new folder',async()=>{
  p=await copyProject();let between:string[]=[];
  // 2回目の mounts は2本目の開始時の確認（ファイルの間）であることも確かめる（Task 1 の申し送り）
  p.faults.push({op:'mounts',nth:2,before:async()=>{between=(await record()).items.map(item=>item.phase);await rename(folder(),`${folder()}-moved`);await mkdir(folder());}});
  const {jobs}=make();await start(jobs);await jobs.idle();
  expect(between).toEqual(['done','waiting']);
  expect(await view(jobs)).toMatchObject({state:'stopped',items:[{phase:'done'},{phase:'failed',error:expect.stringContaining('置き換えられました')}]});expect(await files()).toEqual([]);
  expect(await readdir(`${folder()}-moved`)).toEqual(['clip-1.wav']);expect(await referenceTarget(p.project,p.assets[1]!.file)).toBe(p.sources[1]);
});
it('stops when the copy folder is replaced during a copy, touches nothing in the new folder, and keeps its own files in the record',async()=>{
  p=await copyProject();const moved=`${folder()}-moved`;
  // 読み直しの最後の読み（開いた .part の fd）の直前に入れ替える: 名前を確定する前の確認（copyOneItem の中）で CopyFolderError
  p.faults.push({op:'read',match:isPart,nth:3,before:async()=>{await rename(folder(),moved);await mkdir(folder());}});
  const {jobs}=make();await start(jobs);await jobs.idle();
  // 片付けられなかった実体が記録に残るので、回収を待つ（フォルダーの照合は回収の側。Task 11）
  expect(await view(jobs)).toMatchObject({state:'waiting-volume',items:[{phase:'failed',error:expect.stringContaining('置き換えられました')},{phase:'cancelled'}]});
  expect(await files()).toEqual([]);await linksOnCard();
  // 確かめられないフォルダーでは片付けない（記録に残して回収に任せる）。入れ替わった先の自分の実体は記録で見分けられる
  const item=(await record()).items[0]!;expect(item.part&&item.reserved).toBeTruthy();const names=[item.part!.name,'clip-1.wav'].sort();
  // 回収: フォルダーが記録と違うので、新しいフォルダーには触れず、名前を報告して閉じる
  await jobs.retryWaiting();
  expect(await view(jobs)).toMatchObject({state:'stopped'});expect([...(await record()).kept!].sort()).toEqual(names);expect(await files()).toEqual([]);expect((await readdir(moved)).sort()).toEqual(names);
  expect((await removeOwnedCopyFiles(p.io,moved,item)).kept).toEqual([]);expect(await readdir(moved)).toEqual([]);
});
it('copies nothing from a source path that is not the real path (a link), and fails only that file',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const link=join(p.home,'link.wav');await symlink(p.sources[0]!,link);const failed:string[]=[];
  const {jobs}=make(),batchId='imp-00000000000000000002';
  await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:()=>undefined,failed:id=>{failed.push(id);},stopped:()=>undefined},
    items:[{batchId,batchItemId:'i0',source:link,name:'clip-1.wav'}]});
  await jobs.idle();
  expect(await view(jobs)).toMatchObject({state:'finished',items:[{phase:'failed',error:expect.stringContaining('場所が変わりました')}]});expect(failed).toEqual(['i0']);
  expect(await files()).toEqual([]);expect(p.faulty.calls.some(call=>call.op==='read'&&call.path===link)).toBe(false);
});
it('adds by registering the copy; the same fingerprint already registered from the card is reconnected to the copy',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const extra=join(p.sd,'new.wav');await writeFile(extra,wav(6,9));const done:Array<[string,string]>=[];
  const {jobs}=make(),batchId='imp-00000000000000000000';
  await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:(id:string,asset:SequenceAsset)=>{done.push([id,asset.id]);},failed:()=>undefined,stopped:()=>undefined},
    items:[{batchId,batchItemId:'i0',source:p.sources[0]!,name:'clip-1.wav'},{batchId,batchItemId:'i1',source:extra,name:'new.wav'}]});
  await jobs.idle();
  expect(done.map(([id])=>id)).toEqual(['i0','i1']);expect(done[0]![1]).toBe(p.assets[0]!.id);
  expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(join(folder(),'clip-1.wav'));
  expect((await view(jobs)).items[1]).toMatchObject({assetId:done[1]![1],phase:'done',batchItem:{batchId,itemId:'i1'}});
});
it('keeps the wording of the registered asset when a copy made on opening finds the original changed',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});await writeFile(p.sources[0]!,wav(6,9));const {jobs}=make();await start(jobs);await jobs.idle();
  expect((await view(jobs)).items[0]).toMatchObject({phase:'failed',error:'元の素材の中身が登録時と一致しません'});expect(await files()).toEqual([]);
});
it('stops an added copy during the copy when its content differs from the one chosen on the screen, and registers nothing',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const changed=join(p.sd,'changed.wav'),kept=join(p.sd,'kept.wav');await writeFile(changed,wav(6,9));await writeFile(kept,wav(6,10));
  const failed:Array<[string,string]>=[],done:string[]=[],{jobs}=make(),batchId='imp-00000000000000000004',expected=await sha(kept);
  await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:id=>{done.push(id);},failed:(id,message)=>{failed.push([id,message]);},stopped:()=>undefined},
    items:[{batchId,batchItemId:'i0',source:changed,name:'changed.wav',expectedFingerprint:'0'.repeat(64)},{batchId,batchItemId:'i1',source:kept,name:'kept.wav',expectedFingerprint:expected}]});
  await jobs.idle();
  expect(failed).toEqual([['i0','選んだ時の素材と中身が一致しません']]);expect(done).toEqual(['i1']);expect(await files()).toEqual(['kept.wav']);
  expect((await record()).items[0]!.target).toEqual({kind:'add',batchId,batchItemId:'i0',expectedFingerprint:'0'.repeat(64)});
  expect((await registeredSequenceReferences(p.project)).map(asset=>asset.fingerprint)).not.toContain(await sha(changed));
});
it('gives an added copy whose connection is unknown back to the batch for a decision instead of failing it there',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const lock=join(p.project,'.harness','references','.mutation-lock'),extra=join(p.sd,'new.wav');await writeFile(extra,wav(6,9));
  const failed:string[]=[],stopped:string[][]=[],batchId='imp-00000000000000000005';
  // 登録は済んだ（台帳はコピーを指す）が、その直後に別のエディターが台帳の変更を始めて読めない
  const {jobs}=make({...referenceCopyPorts,register:async(root,copy,name)=>{
    await referenceCopyPorts.register(root,copy,name);
    await writeFile(lock,JSON.stringify({format:'harness-reference-mutation',version:1,pid:process.ppid,startedAt:Date.now(),token:'0d4c5a4e-1b2c-4d3e-8f90-123456789abc'})+'\n');
    throw new ReferenceConnectUnknown(new Error('試験'));}});
  await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:()=>undefined,failed:id=>{failed.push(id);},stopped:ids=>{stopped.push(ids);}},
    items:[{batchId,batchItemId:'i0',source:extra,name:'new.wav'}]});
  await jobs.idle();
  expect(failed).toEqual([]);expect(stopped).toEqual([['i0']]);expect((await record()).items[0]).toMatchObject({phase:'failed',unresolved:true});expect(await files()).toEqual(['new.wav']);
  await unlink(lock);
});
it('reads the original once and the copy once; registering and reconnecting read nothing more',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const size=(await stat(p.sources[0]!)).size,reads=referenceVerificationTesting.fullReads;
  const {jobs}=make();await start(jobs);await jobs.idle();
  const bytes=(match:(path:string)=>boolean)=>p!.faulty.calls.filter(call=>call.op==='read'&&match(call.path)).reduce((sum,call)=>sum+(call.bytes??0),0);
  expect(bytes(path=>path===p!.sources[0])).toBe(size);expect(bytes(path=>path.endsWith(PART_SUFFIX))).toBe(size);
  expect(await sequenceReferenceStatus(p.project,p.assets[0]!)).toEqual({state:'ok'});expect(referenceVerificationTesting.fullReads).toBe(reads);
});

// ---- 各段の失敗・強制終了・中止の注入（既存ファイル・参照先・持ち主の違うファイル・元のファイルが守られたか） ----
/**
 * phase: その段で落ちた時の記録の段。exfat: exFAT（空のファイルの ino が仮の値）で記録から見分けられずに残る実体（Task 7 の既知の窓。名前だけでは消さない）。
 * reservation は印を書く前の空の予約、part は先頭を書く前の空の .part。
 */
interface Stage {label:string;fault:()=>IoFault;code:string;phase:string;exfat?:'reservation'|'part'}
const stages:Stage[]=[
  {label:'reserving the name',fault:()=>({op:'open',match:call=>call.path===final2()&&call.flags===CREATE_EXCLUSIVE}),code:'EACCES',phase:'copying'},
  {label:'writing the reservation mark',fault:()=>({op:'write',match:call=>call.path===final2()}),code:'EIO',phase:'copying',exfat:'reservation'},
  {label:'syncing the reservation',fault:()=>({op:'sync',match:call=>call.path===final2()}),code:'EIO',phase:'copying'},
  {label:'creating the part',fault:()=>({op:'open',match:call=>isPart(call)&&call.flags===CREATE_EXCLUSIVE}),code:'EPERM',phase:'copying'},
  {label:'writing the head of the part',fault:()=>({op:'write',match:isPart,nth:1}),code:'ENOSPC',phase:'copying',exfat:'part'},
  {label:'writing the rest of the part',fault:()=>({op:'write',match:isPart,nth:2}),code:'ENOSPC',phase:'copying'},
  {label:'syncing the part',fault:()=>({op:'sync',match:isPart}),code:'EIO',phase:'copying'},
  {label:'re-reading the part',fault:()=>({op:'read',match:isPart}),code:'EIO',phase:'verifying'},
  {label:'renaming',fault:()=>({op:'rename',match:call=>call.path===final2()}),code:'EIO',phase:'verifying'},
  {label:'syncing the folder',fault:()=>({op:'sync',match:call=>call.path===folder()}),code:'EIO',phase:'verifying'},
  {label:'reopening the named copy',fault:()=>({op:'open',match:call=>call.path===final2()&&call.flags===READ_ONLY,nth:2}),code:'EIO',phase:'named'},   // 1回目は rename の前の予約の印の確認
];
/** exFAT の既知の窓で残る実体の名前（無ければ空）。 */
const leftover=async(exfat:boolean,stage:Stage)=>!exfat||!stage.exfat?[]:stage.exfat==='reservation'?['clip-1 (2).wav']:(await files()).filter(name=>name.endsWith(PART_SUFFIX));
describe.each([['APFS',false],['exFAT-like empty inodes',true]] as const)('on %s',(_label,exfat)=>{
  it.each(stages)('a failure while $label stops the job, removes only its own files, and keeps the link, the foreign file and the original',async stage=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6},{name:'clip-2.wav',mib:6}],exfatEmptyInodes:exfat});const foreign=await placeForeign(),saved=await keepSources();
    p.faults.push({...stage.fault(),error:stage.code});const {jobs,reservations}=make();await start(jobs);await jobs.idle();
    const result=await view(jobs);expect(result).toMatchObject({state:'stopped',stopReason:expect.stringContaining(stage.code),items:[{phase:'failed',error:expect.stringContaining(stage.code)},{phase:'cancelled'}]});
    const left=await leftover(exfat,stage);expect(await files()).toEqual(['clip-1.wav',...left].sort());if(stage.exfat&&exfat)expect(left).toHaveLength(1);
    const item=(await record()).items[0]!;expect(item.part??item.reserved??item.final).toBeUndefined();expect(item.connected).toBeUndefined();
    expect((await record()).kept).toEqual(stage.exfat&&exfat?left:undefined);   // 印を書く前の予約・先頭を書く前の .part は記録にあるが中身で見分けられない（残して報告）
    await foreignIntact(foreign);await linksOnCard();await sourcesIntact(saved);expect(reservations.reservedIn('apfs:disk9')).toBe(0);
  });
  it.each(stages)('a crash while $label leaves a running record that accounts for every file it made',async stage=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6},{name:'clip-2.wav',mib:6}],exfatEmptyInodes:exfat});const foreign=await placeForeign(),saved=await keepSources();
    p.faults.push({...stage.fault(),crash:true});const {jobs,reservations}=make();await start(jobs);await jobs.idle();p.faults.length=0;
    const saw=await record();expect(saw.state).toBe('running');expect(saw.items.map(item=>item.phase)).toEqual([stage.phase,'waiting']);
    await foreignIntact(foreign);await linksOnCard();await sourcesIntact(saved);expect(reservations.reservedIn('apfs:disk9')).toBe(0);
    // 記録だけで自分の実体を見分けられる（起動時の回収 Task 11 と同じ removeOwnedCopyFiles）。exFAT の既知の窓の実体だけは見分けられずに残る
    const left=await leftover(exfat,stage),made=(await files()).filter(name=>name!=='clip-1.wav'&&!left.includes(name));
    const cleaned=await removeOwnedCopyFiles(p.io,folder(),saw.items[0]!);
    expect(cleaned.removed.sort()).toEqual(made.sort());expect(cleaned.kept).toEqual(stage.exfat&&exfat?left:[]);
    expect(await files()).toEqual(['clip-1.wav',...left].sort());await foreignIntact(foreign);
  });
  it.each([
    {label:'reserving the name',fault:():IoFault=>({op:'open',match:call=>call.path===final2()&&call.flags===CREATE_EXCLUSIVE}),first:'cancelled'},
    {label:'creating the part',fault:():IoFault=>({op:'open',match:call=>isPart(call)&&call.flags===CREATE_EXCLUSIVE}),first:'cancelled'},   // exFAT: 先頭を書くまでの空の .part を残さない
    {label:'writing the part',fault:():IoFault=>({op:'write',match:isPart,nth:2}),first:'cancelled'},
    {label:'re-reading the part',fault:():IoFault=>({op:'open',match:call=>isPart(call)&&call.flags===READ_ONLY}),first:'cancelled'},
    {label:'the name is fixed',fault:():IoFault=>({op:'open',match:call=>call.path===final2()&&call.flags===READ_ONLY,nth:2}),first:'done'},
  ] as const)('"残りを中止" while $label: the first file ends $first, the rest are cancelled, and only finished files stay connected',async({label,fault,first})=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6},{name:'clip-2.wav',mib:6}],exfatEmptyInodes:exfat});const foreign=await placeForeign(),saved=await keepSources();
    const {jobs}=make();p.faults.push({...fault(),before:async()=>{jobs.cancel(p!.project,(await record()).jobId);}});await start(jobs);await jobs.idle();
    expect((await view(jobs))).toMatchObject({state:'stopped',items:[{phase:first},{phase:'cancelled'}]});
    if(first==='done'){expect(await files()).toEqual(['clip-1 (2).wav','clip-1.wav']);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(final2());}
    else{expect(await files()).toEqual(['clip-1.wav']);await linksOnCard();}
    expect(await referenceTarget(p.project,p.assets[1]!.file)).toBe(p.sources[1]);
    expect((await record()).items.every(item=>!item.part&&!item.reserved&&(item.phase==='done'||!item.final))).toBe(true);await foreignIntact(foreign);await sourcesIntact(saved);
    if(label==='reserving the name')expect(p.faulty.calls.some(call=>call.op==='open'&&isPart(call))).toBe(false);   // 取り消した後に .part を作らない
  });
});
it('a crash while connecting leaves the record at "connecting" with the named copy, and the link on the card',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const {jobs,reservations}=make({...referenceCopyPorts,reconnect:async()=>{throw new SimulatedCrash('connect');}});
  await start(jobs);await jobs.idle();
  const saw=await record();expect(saw).toMatchObject({state:'running',items:[{phase:'connecting',final:expect.any(Object),fingerprint:p.assets[0]!.fingerprint}]});
  await linksOnCard();expect(reservations.reservedIn('apfs:disk9')).toBe(0);expect(await files()).toEqual(['clip-1.wav']);
});
it('keeps a connected file as done (and on the drive) when only the record cannot be written after connecting',async()=>{
  p=await copyProject();const records=join(p.project,'.harness','copy-jobs'),final=join(folder(),'clip-1.wav');
  const {jobs}=make({...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{await referenceCopyPorts.reconnect(root,asset,copy,generation);if(asset.id===p!.assets[0]!.id)await chmod(records,0o500);}});
  try{await start(jobs);await jobs.idle();
    expect(await view(jobs)).toMatchObject({state:'stopped',stopReason:expect.stringContaining('コピーの記録を書けない'),items:[{phase:'done'},{phase:'cancelled'}]});}
  finally{await chmod(records,0o700);}
  expect(await files()).toEqual(['clip-1.wav']);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(final);expect(await referenceTarget(p.project,p.assets[1]!.file)).toBe(p.sources[1]);
});
it('fails only that file when connecting fails before the change, and removes its own copy',async()=>{
  p=await copyProject();const {jobs}=make({...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{
    if(asset.id===p!.assets[0]!.id)throw new Error('台帳に書けません（試験）');return referenceCopyPorts.reconnect(root,asset,copy,generation);}});
  await start(jobs);await jobs.idle();
  expect(await view(jobs)).toMatchObject({state:'finished',items:[{phase:'failed',error:expect.stringContaining('台帳に書けません')},{phase:'done'}]});
  expect(await files()).toEqual(['clip-2.wav']);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(p.sources[0]);
});

// ---- 書き込み権限・記録・予約（Task 5・9 の申し送り） ----
it('stops with a reason when the copy folder is not writable, and changes no link',async()=>{
  p=await copyProject();await mkdir(folder(),{recursive:true});await chmod(folder(),0o500);
  try{
    const {jobs,reservations}=make();await start(jobs);await jobs.idle();
    expect(await view(jobs)).toMatchObject({state:'stopped',stopReason:expect.stringContaining('権限'),items:[{phase:'failed',error:expect.stringContaining('EACCES')},{phase:'cancelled'}]});
    expect(reservations.reservedIn('apfs:disk9')).toBe(0);
  }finally{await chmod(folder(),0o700);}
  expect(await files()).toEqual([]);await linksOnCard();
});
it('refuses to start when the copy folder cannot be made, and leaves no record or reservation',async()=>{
  p=await copyProject();const parent=join(p.ssd,COPY_ROOT_NAME);await mkdir(parent);await chmod(parent,0o500);
  try{const {jobs,reservations}=make();await expect(start(jobs)).rejects.toMatchObject({status:409,message:expect.stringContaining('EACCES')});expect(reservations.reservedIn('apfs:disk9')).toBe(0);}
  finally{await chmod(parent,0o700);}
  expect(await readCopyJobRecords(p.project)).toEqual([]);await linksOnCard();
});
it('stops when the job record cannot be written, cleans its own files and changes no link',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const records=join(p.project,'.harness','copy-jobs');
  p.faults.push({op:'write',match:isPart,nth:1,before:()=>chmod(records,0o500)});
  try{const {jobs}=make();await start(jobs);await jobs.idle();
    expect((await jobs.list(p.project)).at(-1)).toMatchObject({state:'stopped',stopReason:expect.stringContaining('コピーの記録を書けない')});}
  finally{await chmod(records,0o700);}
  expect(await files()).toEqual([]);await linksOnCard();
});
it('"残りを中止" while waiting for another file\'s check cancels every item, keeps no claim, and makes nothing',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6},{name:'clip-2.wav',mib:6},{name:'other.wav',mib:6}]});const [one,two,other]=p.assets;
  // 同じカードの別のファイル（other）の照合が走っている（抜き差し後で未照合）。コピーはその読み終わりを待つ
  const later=new Date(Date.now()+5000);await utimes(p.sources[2]!,later,later);process.env.HARNESS_TEST_DIGEST_DELAY_MS='300';
  expect((await sequenceReferenceStatus(p.project,other!)).state).toBe('checking');
  const {jobs}=make(),{jobId}=await start(jobs,[one!,two!]);
  for(let i=0;i<100&&referenceVerificationTesting.claims()<2;i++)await new Promise(resolve=>setTimeout(resolve,10));expect(referenceVerificationTesting.claims()).toBe(2);
  jobs.cancel(p.project,jobId);await jobs.idle();
  expect(await view(jobs)).toMatchObject({state:'stopped',items:[{phase:'cancelled'},{phase:'cancelled'}]});expect(referenceVerificationTesting.claims()).toBe(0);
  expect(p.faulty.calls.some(call=>call.op==='open'&&(call.path===p!.sources[0]||call.path===p!.sources[1]))).toBe(false);
  expect(await files()).toEqual([]);for(const index of [0,1])expect(await referenceTarget(p.project,p.assets[index]!.file)).toBe(p.sources[index]);
  delete process.env.HARNESS_TEST_DIGEST_DELAY_MS;
});
it('ends as stopped (not running forever) when the reads cannot be claimed, and makes nothing',async()=>{
  p=await copyProject();const held=await claimReferenceCopy(p.sources[0]!,(await stat(p.sources[0]!)).dev);
  try{const {jobs,reservations}=make();await start(jobs);await jobs.idle();
    expect(await record()).toMatchObject({state:'stopped',stopReason:expect.stringContaining('コピー中'),items:[{phase:'cancelled'},{phase:'cancelled'}]});
    expect(reservations.reservedIn('apfs:disk9')).toBe(0);expect(referenceVerificationTesting.claims()).toBe(1);}
  finally{held.release();}
  expect(await files()).toEqual([]);await linksOnCard();
});
describe('the check of the card that the copy held (Task 9)',()=>{
  /** 同じカードの別のファイル（other）の照合が走っている間に、clip-1 の照合が待ち行列にいる（抜き差し後で両方とも未照合）。コピーは clip-1 の照合を外して、other の読み終わりを待つ。 */
  async function heldCheck(){
    p=await copyProject({files:[{name:'clip-1.wav',mib:6},{name:'other.wav',mib:4}]});const [clip,other]=p.assets;
    const later=new Date(Date.now()+5000);for(const path of p.sources)await utimes(path,later,later);process.env.HARNESS_TEST_DIGEST_DELAY_MS='300';
    expect((await sequenceReferenceStatus(p.project,other!)).state).toBe('checking');expect((await sequenceReferenceStatus(p.project,clip!)).state).toBe('checking');
    return {clip:clip!,reads:referenceVerificationTesting.fullReads};
  }
  it('after copying (the card was read once), finishes the held check without reading the card again',async()=>{
    const {clip,reads}=await heldCheck();const {jobs}=make();await start(jobs,[clip]);await jobs.idle();delete process.env.HARNESS_TEST_DIGEST_DELAY_MS;await referenceVerificationTesting.idle();
    expect((await view(jobs)).items[0]!.phase).toBe('done');expect(referenceVerificationTesting.fullReads).toBe(reads);
    expect(await sequenceReferenceStatus(p!.project,clip)).toEqual({state:'ok'});
  });
  it('after reusing a copy already there (the card was not read), drops the held check instead of reading the whole card',async()=>{
    const {clip,reads}=await heldCheck();await mkdir(folder(),{recursive:true});await copyFile(p!.sources[0]!,join(folder(),'clip-1.wav'));
    const {jobs}=make();await start(jobs,[clip]);await jobs.idle();delete process.env.HARNESS_TEST_DIGEST_DELAY_MS;await referenceVerificationTesting.idle();
    expect((await view(jobs)).items[0]!.phase).toBe('done');expect(referenceVerificationTesting.fullReads).toBe(reads);
    expect(p!.faulty.calls.filter(call=>call.op==='read'&&call.path===p!.sources[0]).length).toBe(0);expect(await referenceTarget(p!.project,clip.file)).toBe(join(folder(),'clip-1.wav'));
  });
});
it('runs one file at a time across jobs: a second job waits for the first',async()=>{
  p=await copyProject();const sources=p.sources;let open=0,most=0;
  p.faults.push({op:'open',match:call=>call.flags===READ_ONLY&&sources.includes(call.path),before:()=>{open++;most=Math.max(most,open);}},{op:'close',match:call=>sources.includes(call.path),before:()=>{open--;}});
  const {jobs}=make();await start(jobs,[p.assets[0]!]);await start(jobs,[p.assets[1]!]);await jobs.idle();
  expect(most).toBe(1);expect((await jobs.list(p.project)).map(job=>job.state)).toEqual(['finished','finished']);expect(await files()).toEqual(['clip-1.wav','clip-2.wav']);
});
it('refuses a second job for an asset that is already being copied',async()=>{
  p=await copyProject();const {jobs}=make();const first=start(jobs,[p.assets[0]!]);
  await expect(start(jobs,[p.assets[0]!])).rejects.toMatchObject({status:409});await first;await jobs.idle();
  expect((await jobs.list(p.project)).map(job=>job.state)).toEqual(['finished']);
});
it('tells the batch which items were stopped when its batch is cancelled',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const extra=join(p.sd,'new.wav');await writeFile(extra,wav(6,9));const stopped:string[][]=[],failed:string[]=[];
  const {jobs}=make(),batchId='imp-00000000000000000001';
  p.faults.push({op:'write',match:isPart,nth:2,before:()=>{jobs.cancelBatch(p!.project,batchId);}});
  await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:()=>undefined,failed:id=>{failed.push(id);},stopped:ids=>{stopped.push(ids);}},
    items:[{batchId,batchItemId:'i0',source:p.sources[0]!,name:'clip-1.wav'},{batchId,batchItemId:'i1',source:extra,name:'new.wav'}]});
  await jobs.idle();
  expect(stopped).toEqual([['i0','i1']]);expect(failed).toEqual([]);expect(await files()).toEqual([]);await linksOnCard();
});
it('hides a dismissed job and keeps it out of the list',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const {jobs}=make(),{jobId}=await start(jobs);
  await expect(jobs.dismiss(p.project,jobId)).rejects.toMatchObject({status:409});await jobs.idle();
  await jobs.dismiss(p.project,jobId);expect(await jobs.list(p.project)).toEqual([]);expect(await make().jobs.list(p.project)).toEqual([]);
});

// ---- レビュー（Important 1）: 同じ名前の既存ファイルを読み比べる間は、その名前を自分の予約として記録に持たない ----
describe('while comparing a file already at the name',()=>{
  /** 中止（cancel）か読み取りの失敗（EIO）を、既存ファイルの読み比べの最中に起こす。 */
  const during=(path:()=>string,how:'cancel'|'EIO',jobs:MediaCopyJobs,mode:'reconnect'|'add'):IoFault=>({op:'read',match:call=>call.path===path(),nth:1,
    ...(how==='EIO'?{error:'EIO'}:{before:async()=>{jobs.cancel(p!.project,(await readCopyJobRecords(p!.project)).find(item=>item.mode===mode)!.jobId);}})});
  it.each(['cancel','EIO'] as const)('a %s leaves a foreign file alone and does not report it as kept',async how=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const foreign=await placeForeign(),{jobs}=make();
    p.faults.push(during(()=>foreign.path,how,jobs,'reconnect'));await start(jobs);await jobs.idle();
    const result=await view(jobs);expect(result.items[0]!.phase).toBe(how==='cancel'?'cancelled':'failed');expect(result.kept).toBeUndefined();expect((await record()).kept).toBeUndefined();
    expect(await files()).toEqual(['clip-1.wav']);await foreignIntact(foreign);await linksOnCard();
  });
  it.each(['cancel','EIO'] as const)('a %s leaves a connected copy alone and does not report it as kept',async how=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const {jobs}=make(),copy=join(folder(),'clip-1.wav');await start(jobs);await jobs.idle();
    const before=await sha(copy),extra=join(p.sd,'new.wav');await writeFile(extra,wav(6,9));
    p.faults.push(during(()=>copy,how,jobs,'add'));
    const added=await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:()=>undefined,failed:()=>undefined,stopped:()=>undefined},
      items:[{batchId:'imp-00000000000000000003',batchItemId:'i0',source:extra,name:'clip-1.wav'}]});
    await jobs.idle();
    const result=(await jobs.list(p.project)).find(item=>item.jobId===added.jobId)!;expect(result.items[0]!.phase).toBe(how==='cancel'?'cancelled':'failed');expect(result.kept).toBeUndefined();
    expect(await files()).toEqual(['clip-1.wav']);expect(await sha(copy)).toBe(before);expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(copy);
  });
});

// ---- レビュー（Important 2・Minor 6）: 画面に出す理由に絶対パスや英文を入れない。台帳の側・元の側の失敗をコピー先の権限と取り違えない ----
/** 理由に、パス（/ を含む）も英語の単語（errno の code 以外）も入っていないこと。 */
const plain=(reason:string|undefined)=>{expect(reason).toBeDefined();expect(reason).not.toContain('/');expect(reason!.replace(/\b[A-Z][A-Z0-9_]+\b/g,'')).not.toMatch(/[A-Za-z]{3,}/);};
describe('reasons on the screen',()=>{
  it.each([
    ['EINVAL',():IoFault=>({op:'write',match:isPart,nth:2,error:'EINVAL'})],
    ['ENOTDIR',():IoFault=>({op:'open',match:call=>call.path===join(folder(),'clip-1.wav')&&call.flags===CREATE_EXCLUSIVE,error:'ENOTDIR'})],
    ['ENAMETOOLONG',():IoFault=>({op:'open',match:call=>isPart(call)&&call.flags===CREATE_EXCLUSIVE,error:'ENAMETOOLONG'})],
  ] as const)('an unlisted errno (%s) shows only the code, not the path or the English text',async(code,fault)=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});
    // 本物の errno と同じく、英文とパスを含む本文にする
    const base=fault();p.faults.push({...base,error:undefined,before:call=>{throw Object.assign(new Error(`${code}: invalid argument, open '${call.path}'`),{code,path:call.path});}});
    const {jobs}=make();await start(jobs);await jobs.idle();
    const item=(await view(jobs)).items[0]!;expect(item.phase).toBe('failed');expect(item.error).toContain(code);plain(item.error);
    expect(await files()).toEqual([]);await linksOnCard();
  });
  it('a record that cannot be written shows only the code',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const records=join(p.project,'.harness','copy-jobs');
    p.faults.push({op:'write',match:isPart,nth:1,before:()=>chmod(records,0o500)});
    try{const {jobs}=make();await start(jobs);await jobs.idle();const result=(await jobs.list(p.project))[0]!;
      expect(result.stopReason).toContain('コピーの記録を書けない');expect(result.stopReason).toContain('EACCES');plain(result.stopReason);plain(result.items[0]!.error);}
    finally{await chmod(records,0o700);}
  });
  it('a record that does not fit its shape shows a fixed reason (not the schema error)',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const extra=join(p.sd,'new.wav');await writeFile(extra,wav(6,9));
    const {jobs}=make({...referenceCopyPorts,register:async(root,copy,name)=>{const result=await referenceCopyPorts.register(root,copy,name);return {...result,asset:{...result.asset,id:'x'.repeat(300)}};}});
    await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:()=>undefined,failed:()=>undefined,stopped:()=>undefined},
      items:[{batchId:'imp-00000000000000000004',batchItemId:'i0',source:extra,name:'new.wav'}]});
    await jobs.idle();const result=(await jobs.list(p.project))[0]!;
    expect(result.stopReason).toContain('コピーの記録の形が正しくない');plain(result.stopReason);
  });
  it.each([['EACCES','stopped',['failed','cancelled']],['ENOENT','finished',['failed','done']]] as const)
  ('a failure of the project ledger (%s) is not reported as the copy folder\'s permission',async(code,state,phases)=>{
    p=await copyProject();const ledger=join(p.project,'.harness','references',`${p.assets[0]!.fingerprint}.wav.json`);
    const {jobs}=make({...referenceCopyPorts,reconnect:async(root,asset,copy,generation)=>{
      if(asset.id===p!.assets[0]!.id)throw Object.assign(new Error(`${code}: permission denied, open '${ledger}'`),{code,path:ledger});return referenceCopyPorts.reconnect(root,asset,copy,generation);}});
    await start(jobs);await jobs.idle();
    const result=await view(jobs);expect(result.state).toBe(state);expect(result.items.map(item=>item.phase)).toEqual(phases);
    expect(result.items[0]!.error).toContain('参照の記録');expect(result.items[0]!.error).not.toContain('コピー先');plain(result.items[0]!.error);
    expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(p.sources[0]);expect((await files()).includes('clip-1.wav')).toBe(false);
  });
  it('a failure to read the original is not reported as the copy folder\'s permission',async()=>{
    p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const source=p.sources[0]!;
    p.faults.push({op:'open',match:call=>call.path===source&&call.flags===READ_ONLY,before:()=>{throw Object.assign(new Error(`EACCES: permission denied, open '${source}'`),{code:'EACCES',path:source});}});
    const {jobs}=make();await start(jobs);await jobs.idle();
    const error=(await view(jobs)).items[0]!.error;expect(error).toContain('元の素材');expect(error).not.toContain('コピー先');plain(error);expect(await files()).toEqual([]);
  });
});

// ---- レビュー（Minor 3・5） ----
it('copies an original whose inode number is beyond 2^53 (network drives) without failing to write the record',async()=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const sd=p.sd,huge=2**60;
  const mask=(info:import('node:fs').Stats,path:string)=>path.startsWith(`${sd}/`)?Object.assign(Object.create(Object.getPrototypeOf(info) as object) as import('node:fs').Stats,info,{ino:huge}):info;
  const io={...p.io,stat:async(path:string)=>mask(await p!.io.stat(path),path),lstat:async(path:string)=>mask(await p!.io.lstat(path),path),
    open:async(path:string,flags:number,mode?:number)=>{const file=await p!.io.open(path,flags,mode);return {...file,stat:async()=>mask(await file.stat(),path)};}};
  const jobs=new MediaCopyJobs(()=>io,referenceCopyPorts,new SpaceReservations());await start(jobs);await jobs.idle();
  expect(await view(jobs)).toMatchObject({state:'finished',items:[{phase:'done'}]});expect(await referenceTarget(p.project,p.assets[0]!.file)).toBe(join(folder(),'clip-1.wav'));
});
it.each(['sub/clip-1.wav','..','.'])('refuses a copy name that is not a single name (%s) and makes nothing',async name=>{
  p=await copyProject({files:[{name:'clip-1.wav',mib:6}]});const {jobs}=make();
  await jobs.startAdd({root:p.project,projectId:'case',destination:p.destination,callbacks:{done:()=>undefined,failed:()=>undefined,stopped:()=>undefined},
    items:[{batchId:'imp-00000000000000000005',batchItemId:'i0',source:p.sources[0]!,name}]});
  await jobs.idle();
  expect((await view(jobs)).items[0]).toMatchObject({phase:'failed',error:expect.stringContaining('名前')});expect(await files()).toEqual([]);
  expect(p.faulty.calls.filter(call=>call.op==='open'&&((call.flags??0)&WRITE_FLAGS)!==0)).toEqual([]);
});

// ---- 結果不明の判定（台帳の接続先と比べる。NFC/NFD の違いだけは同じ場所） ----
describe('ledgerConnects',()=>{
  const fingerprint='a'.repeat(64),path='/Volumes/SSD/Harness 素材/案件-12345678/ガイド.wav',nfd=path.normalize('NFD');
  const asset={id:'asset-1',file:`.harness/references/${fingerprint}.wav`,fingerprint} as SequenceAsset;
  const item=(kind:'reconnect'|'add'):CopyJobItemRecord=>({itemId:'c0',name:'ガイド.wav',sizeBytes:1,source:'/Volumes/SD/ガイド.wav',sourceDev:1,phase:'connecting',fingerprint,
    target:kind==='reconnect'?{kind,assetId:asset.id,assetFile:asset.file,generation:'0d4c5a4e-1b2c-4d3e-8f90-123456789abc',expectedFingerprint:fingerprint}:{kind,batchId:'imp-00000000000000000000',batchItemId:'i0'}});
  const ports=(target:()=>Promise<string|undefined>,references:()=>Promise<SequenceAsset[]>=async()=>[asset]):LedgerPorts=>({target,references});
  expect(path).not.toBe(nfd);
  it('treats a target that differs only in Unicode normalization as connected',async()=>{
    await expect(ledgerConnects(ports(async()=>nfd),'/p',item('reconnect'),path)).resolves.toEqual({connected:true});
    await expect(ledgerConnects(ports(async()=>nfd),'/p',item('add'),path)).resolves.toEqual({connected:true,asset});
  });
  it('answers not connected only when the ledger was read',async()=>{
    await expect(ledgerConnects(ports(async()=>'/Volumes/SD/ガイド.wav'),'/p',item('reconnect'),path)).resolves.toEqual({connected:false});
    await expect(ledgerConnects(ports(async()=>undefined),'/p',item('reconnect'),path)).resolves.toEqual({connected:false});
    await expect(ledgerConnects(ports(async()=>path,async()=>[]),'/p',item('add'),path)).resolves.toEqual({connected:false});
  });
  it('throws instead of answering "not connected" when the ledger cannot be read',async()=>{
    const unreadable=async()=>{throw new Error('台帳を読めません（試験）');};
    await expect(ledgerConnects(ports(unreadable),'/p',item('reconnect'),path)).rejects.toBeInstanceOf(LedgerUnreadableError);
    await expect(ledgerConnects(ports(unreadable),'/p',item('add'),path)).rejects.toBeInstanceOf(LedgerUnreadableError);
    await expect(ledgerConnects(ports(async()=>path,unreadable),'/p',item('add'),path)).rejects.toBeInstanceOf(LedgerUnreadableError);
  });
});
