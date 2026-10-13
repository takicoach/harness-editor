// コピーと照合の読み取りの調停（設計 §5・裁定 #10）: 未開始の照合は外す・実行中は対象なら意図的に中止（失敗として覚えない）・それ以外は終わるのを待つ・
// 再生はコピーの照合結果を待つ・取り消したら外した照合を戻す。コピーが読んでいる媒体のほかの照合は、コピーの間は始めない。
// コピーが元を照合済みにできるのは、copyOneItem がこのプロセスで元を読み切って照合した組だけ（外から組んだ値は信じない）。
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
/** 参照先から読まれたバイト数（パスごと）。照合の遅さは HARNESS_TEST_DIGEST_DELAY_MS（共有の読みだけ。コピーの読みは遅くしない）。 */
const reads=vi.hoisted(()=>({bytes:new Map<string,number>()}));
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{const handle=await actual.open(...args),read=handle.read.bind(handle) as unknown as (...x:unknown[])=>Promise<{bytesRead:number}>,key=String(args[0]);
    Object.assign(handle,{read:async(...readArgs:unknown[])=>{const result=await read(...readArgs);reads.bytes.set(key,(reads.bytes.get(key)??0)+result.bytesRead);return result;}});return handle;}};});
import {mkdir,stat,utimes,writeFile} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {COPYING_MESSAGE,claimReferenceCopies,claimReferenceCopy,openSequenceReference,reconnectSequenceReferenceVerified,referenceConnection,referenceReadSpeed,referenceReadState,
  referenceVerificationTesting,registerSequenceReference,sequenceReferenceStatus,type ReferenceFileInfo} from './references';
import type {SequenceAsset} from '../../core/sequence/model';
import {copyOneItem,type CopyItemHooks} from './mediaCopy/copyItem';
import {COPY_ROOT_NAME,ensureCopyFolder,listVolumes,type CopyFolder} from './mediaCopy/volumes';
import {copyWorld,type CopyWorld} from './mediaCopy/__fixtures__/copyWorld';
import {wav} from './mediaCopy/__fixtures__/copyProject';

const delay=process.env.HARNESS_TEST_DIGEST_DELAY_MS;
let world:CopyWorld,folder:CopyFolder,project='';
beforeEach(async()=>{world=await copyWorld();project=join(world.root,'project');await mkdir(project);
  folder=await ensureCopyFolder(world.io,(await listVolumes(world.io)).find(volume=>volume.uuid==='SSD')!,world.ssd,[COPY_ROOT_NAME,'案件-12345678']);});
afterEach(async()=>{slow(0);vi.useRealTimers();await referenceVerificationTesting.idle();referenceVerificationTesting.forget();reads.bytes.clear();
  if(delay===undefined)delete process.env.HARNESS_TEST_DIGEST_DELAY_MS;else process.env.HARNESS_TEST_DIGEST_DELAY_MS=delay;await world.cleanup();});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** 照合の読みを 1MiB ごとに ms 待たせる（300 なら 4MiB の照合が約 1.2 秒で、状態確認の待ち 1 秒を超えて「確認中」になる）。 */
const slow=(ms:number)=>{process.env.HARNESS_TEST_DIGEST_DELAY_MS=String(ms);};
const read=(path:string)=>reads.bytes.get(path)??0;
const size=async(path:string)=>(await stat(path)).size;
const dev=async(path:string)=>(await stat(path)).dev;
const copyingStatus={state:'copying',message:COPYING_MESSAGE};
/** カードの素材を登録し、識別情報を変えて「未照合」にする（抜き差し後と同じ）。 */
async function unverified(name:string,mib=4,seed=0):Promise<{path:string;asset:SequenceAsset}>{
  const path=join(world.sd,name);await writeFile(path,wav(mib,seed));const asset=await registerSequenceReference(project,path);
  const later=new Date(Date.now()+5000+seed);await utimes(path,later,later);return {path,asset};
}
const hooks=():CopyItemHooks=>({signal:new AbortController().signal,phase:async()=>undefined,progress:async()=>undefined});
/** 作業（jobs.ts）と同じく、開いた時のコピー（期待する指紋つき）で速いドライブへコピーし、元を読み切って照合した組を受け渡しの値にする。 */
async function copied(source:{path:string;asset:SequenceAsset}){
  const result=await copyOneItem(world.io,{path:source.path,expectedFingerprint:source.asset.fingerprint},{folder,name:basename(source.path)},hooks());
  return {fingerprint:result.fingerprint,info:result.sourceIdentity!};
}
/** 時計（Date だけ）を進める（references.background.test.ts と同じ）。 */
function advanceClock(ms:number){if(!vi.isFakeTimers())vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+ms);}
/** a の照合が走り、b の照合が待ち行列にいる時に b をコピーの対象にする（b の照合は外される）。 */
async function heldBehindAnother(){
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();slow(300);
  expect((await sequenceReferenceStatus(project,a.asset)).state).toBe('checking');expect((await sequenceReferenceStatus(project,b.asset)).state).toBe('checking');
  return {a,b,claim:await claimReferenceCopy(b.path,await dev(b.path))};
}
const info=async(path:string):Promise<ReferenceFileInfo>=>{const s=await stat(path);return {dev:s.dev,ino:s.ino,size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs};};

it('holds a queued check of the copied file, answers "copying", and finishes it without reading after the copy verified it (kept across a restart)',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();slow(300);
  expect((await sequenceReferenceStatus(project,a.asset)).state).toBe('checking');expect((await sequenceReferenceStatus(project,b.asset)).state).toBe('checking');
  const claim=await claimReferenceCopy(b.path,await dev(b.path));   // a の照合（別のファイル）が終わるのを待ってから返る
  expect(read(a.path)).toBe(await size(a.path));expect(read(b.path)).toBe(0);expect(await sequenceReferenceStatus(project,b.asset)).toEqual(copyingStatus);
  slow(0);const verified=await copied(b);expect(read(b.path)).toBe(await size(b.path));reads.bytes.clear();
  claim.release(verified);await referenceVerificationTesting.idle();expect(read(b.path)).toBe(0);
  // 外した照合が（状態確認に問われる前に）案件に照合記録を残した: 再起動の後も読み直さない
  referenceVerificationTesting.forget();expect(await sequenceReferenceStatus(project,b.asset)).toEqual({state:'ok'});expect(read(b.path)).toBe(0);
});
it('holds the copied file\'s queued check by its path, apart from the same-drive rule',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();slow(300);
  expect((await sequenceReferenceStatus(project,a.asset)).state).toBe('checking');expect((await sequenceReferenceStatus(project,b.asset)).state).toBe('checking');
  const claim=await claimReferenceCopy(b.path,await dev(b.path)+1);   // 別の dev を名乗る: 同じ媒体の規則では止まらない
  await sleep(150);expect(read(b.path)).toBe(0);expect(await sequenceReferenceStatus(project,b.asset)).toEqual(copyingStatus);
  slow(0);claim.release();await referenceVerificationTesting.idle();expect(read(b.path)).toBe(await size(b.path));
});
it('stops a running check of the copied file on purpose: the waiting status answers "copying", and it is neither a failure nor a stall',async()=>{
  const a=await unverified('a.wav',32,1);reads.bytes.clear();slow(40);   // 32MiB を 1MiB ごと 40ms: 約 1.3 秒。16MiB（速さを測れる量）は約 0.65 秒
  const asking=sequenceReferenceStatus(project,a.asset);await sleep(800);expect(referenceReadSpeed(a.path)).toBeGreaterThan(0);
  const started=Date.now(),claim=await claimReferenceCopy(a.path,await dev(a.path));
  expect(Date.now()-started).toBeLessThan(300);expect(await asking).toEqual(copyingStatus);   // 照合の読み終わりを待たずに返る
  const state=await referenceReadState(project,a.asset);expect(state?.verified).toBe(false);expect(state?.failed).toBeUndefined();   // 失敗として覚えない
  expect(referenceReadSpeed(a.path)).toBeGreaterThan(0);   // 見張り（ETIMEDOUT）の切り上げではないので、測った速さは捨てない
  await sleep(1000);expect(read(a.path)).toBeLessThan(await size(a.path));   // 読みは止まっている（止めなければ読み終えている時間）
  expect(await sequenceReferenceStatus(project,a.asset)).toEqual(copyingStatus);
  claim.release();slow(0);await sleep(20);   // 取り消し（照合の結果なし）: 次の状態確認で照合し直す
  expect(['checking','ok']).toContain((await sequenceReferenceStatus(project,a.asset)).state);await referenceVerificationTesting.idle();
  expect(await sequenceReferenceStatus(project,a.asset)).toEqual({state:'ok'});
});
it('waits for a running check of another file before the copy starts, and lets it finish',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();slow(300);
  expect((await sequenceReferenceStatus(project,a.asset)).state).toBe('checking');let started=false;
  const claiming=claimReferenceCopy(b.path,await dev(b.path)).then(claim=>{started=true;return claim;});
  await sleep(50);expect(started).toBe(false);slow(0);(await claiming).release();expect(started).toBe(true);
  await referenceVerificationTesting.idle();expect(read(a.path)).toBe(await size(a.path));expect(await sequenceReferenceStatus(project,a.asset)).toEqual({state:'ok'});
});
it('starts no other check on the same drive while copying, and runs it after',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();
  const claim=await claimReferenceCopy(a.path,await dev(a.path));
  expect((await sequenceReferenceStatus(project,b.asset)).state).toBe('checking');await sleep(100);expect(read(b.path)).toBe(0);
  claim.release();await referenceVerificationTesting.idle();expect(read(b.path)).toBe(await size(b.path));
  expect(await sequenceReferenceStatus(project,b.asset)).toEqual({state:'ok'});
});
it('lets playback wait for the copy result instead of reading the card',async()=>{
  const a=await unverified('a.wav',4,1);reads.bytes.clear();const claim=await claimReferenceCopy(a.path,await dev(a.path));let opened=false;
  const lease=openSequenceReference(project,a.asset).then(value=>{opened=true;return value;});
  await sleep(50);expect(opened).toBe(false);expect(await sequenceReferenceStatus(project,a.asset)).toEqual(copyingStatus);
  const verified=await copied(a);reads.bytes.clear();claim.release(verified);
  await (await lease).close();expect(read(a.path)).toBe(0);
});
it('playback answers from the copy result at once, not behind a check of another drive',async()=>{
  const a=await unverified('a.wav',4,1),c=await unverified('c.wav',8,3);reads.bytes.clear();
  const claim=await claimReferenceCopy(a.path,await dev(a.path)+1);   // a のカードを c とは別のドライブとして名乗る（c の照合はコピーの間も走れる）
  let opened=false;const lease=openSequenceReference(project,a.asset).then(value=>{opened=true;return value;});await sleep(50);
  const verified=await copied(a);slow(300);expect((await sequenceReferenceStatus(project,c.asset)).state).toBe('checking');   // c の照合（約 2.4 秒）が走っている
  claim.release(verified);await sleep(300);expect(opened).toBe(true);expect(read(c.path)).toBeLessThan(await size(c.path));
  await (await lease).close();
});
it('playback that was waiting on the stopped check waits for the copy result',async()=>{
  const a=await unverified('a.wav',4,1);reads.bytes.clear();slow(300);
  const lease=openSequenceReference(project,a.asset);await sleep(100);   // 再生が照合に合流して待っている
  const claim=await claimReferenceCopy(a.path,await dev(a.path));slow(0);
  const verified=await copied(a);reads.bytes.clear();claim.release(verified);
  await (await lease).close();expect(read(a.path)).toBe(0);
});
it('playback goes back to the normal check when the copy fails (does not wait forever)',async()=>{
  const a=await unverified('a.wav',4,1);reads.bytes.clear();const claim=await claimReferenceCopy(a.path,await dev(a.path));
  const lease=openSequenceReference(project,a.asset);await sleep(50);claim.release();
  await (await lease).close();expect(read(a.path)).toBe(await size(a.path));
});
it('returns the held checks to the queue when the copy is cancelled',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();slow(300);
  expect((await sequenceReferenceStatus(project,a.asset)).state).toBe('checking');expect((await sequenceReferenceStatus(project,b.asset)).state).toBe('checking');
  const claim=await claimReferenceCopy(b.path,await dev(b.path));slow(0);claim.release();await referenceVerificationTesting.idle();
  expect(read(b.path)).toBe(await size(b.path));expect(await sequenceReferenceStatus(project,b.asset)).toEqual({state:'ok'});
});
it('does not take a result the copy did not read as verified: a hand-made release still reads the card',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();slow(300);
  expect((await sequenceReferenceStatus(project,a.asset)).state).toBe('checking');expect((await sequenceReferenceStatus(project,b.asset)).state).toBe('checking');
  const claim=await claimReferenceCopy(b.path,await dev(b.path));slow(0);
  claim.release({fingerprint:b.asset.fingerprint,info:await info(b.path)});await referenceVerificationTesting.idle();
  expect(read(b.path)).toBe(await size(b.path));expect(await sequenceReferenceStatus(project,b.asset)).toEqual({state:'ok'});
});
it('tells the advice which links are being copied (from the claim to the release; drop ends it too)',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);
  expect((await referenceReadState(project,a.asset))?.copying).toBeUndefined();
  const claims=await claimReferenceCopies([{path:a.path,dev:await dev(a.path)},{path:b.path,dev:await dev(b.path)}]);
  expect((await referenceReadState(project,a.asset))?.copying).toBe(true);expect((await referenceReadState(project,b.asset))?.copying).toBe(true);
  claims.get(a.path)!.release();claims.get(b.path)!.drop();
  expect((await referenceReadState(project,a.asset))?.copying).toBeUndefined();expect((await referenceReadState(project,b.asset))?.copying).toBeUndefined();
});
it('refuses a second claim on the same file while one is held, and ignores a second release',async()=>{
  const a=await unverified('a.wav',4,1),claim=await claimReferenceCopy(a.path,await dev(a.path));
  await expect(claimReferenceCopy(a.path,await dev(a.path))).rejects.toThrow('コピー中');
  claim.release();const again=await claimReferenceCopy(a.path,await dev(a.path));claim.release();
  expect(await sequenceReferenceStatus(project,a.asset)).toEqual(copyingStatus);again.release();
});

// ---- レビューの指摘（Important・Minor 1〜4） ----
it('lets "stop the rest" cancel the wait for another file\'s check: no claim is left and the held check goes back to the queue',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2);reads.bytes.clear();slow(300);
  expect((await sequenceReferenceStatus(project,a.asset)).state).toBe('checking');expect((await sequenceReferenceStatus(project,b.asset)).state).toBe('checking');
  const stop=new AbortController(),reason=new Error('残りを中止');
  const claiming=claimReferenceCopy(b.path,await dev(b.path),stop.signal);await sleep(50);
  expect(referenceVerificationTesting.claims()).toBe(1);stop.abort(reason);
  await expect(claiming).rejects.toBe(reason);expect(referenceVerificationTesting.claims()).toBe(0);
  // 外した b の照合が待ち行列に戻って読まれる（状態確認で作り直す前に確かめる）
  slow(0);await referenceVerificationTesting.idle();expect(read(b.path)).toBe(await size(b.path));expect(await sequenceReferenceStatus(project,b.asset)).toEqual({state:'ok'});
  await expect(claimReferenceCopy(a.path,await dev(a.path),AbortSignal.abort(reason))).rejects.toBe(reason);expect(referenceVerificationTesting.claims()).toBe(0);
});
it('keeps a held check the status keeps asking about through a long copy, and reads it when the copy is cancelled',async()=>{
  const {b,claim}=await heldBehindAnother();
  for(let i=0;i<3;i++){expect(await sequenceReferenceStatus(project,b.asset)).toEqual(copyingStatus);advanceClock(100_000);}   // 300 秒（放棄の 180 秒を超える）、問われ続けた
  slow(0);claim.release();await referenceVerificationTesting.idle();expect(read(b.path)).toBe(await size(b.path));
});
it('drops a held check nobody asked about during a long copy, and checks again when asked',async()=>{
  const {b,claim}=await heldBehindAnother();advanceClock(181_000);slow(0);claim.release();await referenceVerificationTesting.idle();expect(read(b.path)).toBe(0);
  expect(['checking','ok']).toContain((await sequenceReferenceStatus(project,b.asset)).state);await referenceVerificationTesting.idle();expect(read(b.path)).toBe(await size(b.path));
});
it('claims all the items of a copy job at once: releasing one keeps the drive for the rest, so no other check starts between copies',async()=>{
  const a=await unverified('a.wav',4,1),b=await unverified('b.wav',4,2),d=await unverified('d.wav',4,4),drive=await dev(a.path);reads.bytes.clear();
  const claims=await claimReferenceCopies([{path:a.path,dev:drive},{path:b.path,dev:drive}]);expect(referenceVerificationTesting.claims()).toBe(2);
  expect(await sequenceReferenceStatus(project,a.asset)).toEqual(copyingStatus);expect(await sequenceReferenceStatus(project,b.asset)).toEqual(copyingStatus);
  expect((await sequenceReferenceStatus(project,d.asset)).state).toBe('checking');
  const verified=await copied(a);reads.bytes.clear();claims.get(a.path)!.release(verified);await sleep(100);expect(read(d.path)).toBe(0);   // 次のコピーの前に d の照合が始まらない
  expect(await sequenceReferenceStatus(project,a.asset)).toEqual({state:'ok'});expect(read(a.path)).toBe(0);
  claims.get(b.path)!.release();expect(referenceVerificationTesting.claims()).toBe(0);await referenceVerificationTesting.idle();expect(read(d.path)).toBe(await size(d.path));
});
it('drops the held checks of a source no longer needed (a reused copy), without reading the card; asked again, it is checked',async()=>{
  const {b,claim}=await heldBehindAnother();slow(0);claim.drop();await referenceVerificationTesting.idle();expect(read(b.path)).toBe(0);
  expect(referenceVerificationTesting.claims()).toBe(0);expect(referenceReadState(project,b.asset).then(state=>state?.failed)).resolves.toBeUndefined();
  expect(['checking','ok']).toContain((await sequenceReferenceStatus(project,b.asset)).state);await referenceVerificationTesting.idle();expect(read(b.path)).toBe(await size(b.path));
});
it('playback waiting for a copy that then reconnected the asset does not read the card afterwards',async()=>{
  const a=await unverified('a.wav',4,1);reads.bytes.clear();const {generation}=await referenceConnection(project,a.asset);
  const claim=await claimReferenceCopy(a.path,await dev(a.path));const lease=openSequenceReference(project,a.asset);lease.catch(()=>undefined);await sleep(50);
  const result=await copyOneItem(world.io,{path:a.path,expectedFingerprint:a.asset.fingerprint},{folder,name:'a.wav'},hooks());
  await reconnectSequenceReferenceVerified(project,a.asset,{path:result.path,fingerprint:result.fingerprint,identity:result.identity},generation);   // 予約を持ったまま接続を変える
  reads.bytes.clear();claim.drop();
  await expect(lease).rejects.toThrow('変更');expect(read(a.path)).toBe(0);expect(await sequenceReferenceStatus(project,a.asset)).toEqual({state:'ok'});
});
it('forget (a restart in tests) clears claims left behind and what the copy read; idle does not wait for held checks',async()=>{
  const {b}=await heldBehindAnother();slow(0);const verified=await copied(b);reads.bytes.clear();
  await referenceVerificationTesting.idle();   // 外したままの照合は待たない（予約を残して落ちた試験の後片付けが止まらない）
  referenceVerificationTesting.forget();expect(referenceVerificationTesting.claims()).toBe(0);
  const again=await claimReferenceCopy(b.path,await dev(b.path));again.release(verified);   // 再起動の後は、コピーが元を読んだ記憶も無い
  expect(['checking','ok']).toContain((await sequenceReferenceStatus(project,b.asset)).state);await referenceVerificationTesting.idle();expect(read(b.path)).toBe(await size(b.path));
});
