// 開いた時の案内の速度は、裏の照合が実際に読んだ量と時間から測る（設計 §1。待ち行列の時間は含めない・照合済みの素材は測らない）。
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {copyFile,mkdir,mkdtemp,realpath,rename,rm,stat,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {READ_SPEED_SAMPLE_BYTES,referenceReadSpeed,referenceReadState,referenceVerificationTesting,registerSequenceReference,sequenceReferenceStatus} from './references';
import {wav} from './mediaCopy/__fixtures__/copyProject';

let root='';const delay=process.env.HARNESS_TEST_DIGEST_DELAY_MS,STALL_MS=referenceVerificationTesting.stallMs;
// 1MiB ごとに 60ms 待つ: 24MiB の照合は約 1.5 秒（状態確認の待ち 1 秒を超えて「確認中」になる）。
beforeEach(async()=>{root=await realpath(await mkdtemp(join(tmpdir(),'reference-speed-')));process.env.HARNESS_TEST_DIGEST_DELAY_MS='60';});
afterEach(async()=>{await referenceVerificationTesting.idle();referenceVerificationTesting.forget();referenceVerificationTesting.stallMs=STALL_MS;if(delay===undefined)delete process.env.HARNESS_TEST_DIGEST_DELAY_MS;else process.env.HARNESS_TEST_DIGEST_DELAY_MS=delay;await rm(root,{recursive:true,force:true});});
async function linked(mib:number,name='clip'){const project=join(root,`project-${name}`),card=join(root,`card-${name}`),source=join(card,`${name}.wav`);await mkdir(project);await mkdir(card);await writeFile(source,wav(mib));
  return {project,source,asset:await registerSequenceReference(project,source)};}
/** 照合記録が外れる（抜き差し後と同じ）: 中身は同じまま mtime だけ変える。秒ちょうどにして、同じ時刻を別のファイルにも付けられるようにする。 */
async function touch(path:string,seconds=5){const later=new Date((Math.floor(Date.now()/1000)+seconds)*1000);await utimes(path,later,later);return later;}

it('does not measure an asset that is already verified (no extra read at open)',async()=>{
  const {project,source,asset}=await linked(24);
  expect(await sequenceReferenceStatus(project,asset)).toEqual({state:'ok'});expect(referenceReadSpeed(source)).toBeUndefined();
  expect(await referenceReadState(project,asset)).toEqual({path:source,sizeBytes:(await stat(source)).size,verified:true});
});
it('measures the background check from the bytes it read once it has read enough',async()=>{
  const {project,source,asset}=await linked(24);await touch(source);
  expect(await referenceReadState(project,asset)).toEqual({path:source,sizeBytes:(await stat(source)).size,verified:false});   // 照合が始まる前は測れていない
  expect((await sequenceReferenceStatus(project,asset)).state).toBe('checking');await referenceVerificationTesting.idle();
  const speed=referenceReadSpeed(source);expect(speed).toBeGreaterThan(0);expect(Number.isFinite(speed)).toBe(true);
  // 1MiB ごとに 60ms 待つので、速さはおよそ 1MiB/60ms（読みの時間を測っている。タイマーの揺れを見込んで幅を持たせる）。
  expect(speed).toBeGreaterThan(0.5*1024*1024*1000/60);expect(speed).toBeLessThan(1.5*1024*1024*1000/60);
  expect(await referenceReadState(project,asset)).toMatchObject({verified:true,bytesPerSecond:speed});expect(READ_SPEED_SAMPLE_BYTES).toBe(16*1024*1024);
  referenceVerificationTesting.forget();expect(referenceReadSpeed(source)).toBeUndefined();   // 再起動に相当: 測った速さはメモリだけ
});
it('does not report a speed until 16MiB has been read (counting the bytes actually read)',async()=>{
  const {project,source,asset}=await linked(15);await touch(source);   // 15MiB＋ヘッダー 44 バイト: 1MiB ずつ数えると 16 回で 16MiB に見える
  await sequenceReferenceStatus(project,asset);await referenceVerificationTesting.idle();
  // 照合は確かに走って読み終えた（記録が外れていたのに照合済みになった）が、16MiB 未満では測れたとみなさない。
  expect(await referenceReadState(project,asset)).toEqual({path:source,sizeBytes:(await stat(source)).size,verified:true});expect(referenceReadSpeed(source)).toBeUndefined();
});
it('does not count the time a check waited in the queue behind another one',async()=>{
  const first=await linked(32,'first'),second=await linked(24,'second');await touch(first.source);await touch(second.source);
  // 同時に頼む: 照合は同時に1本なので、2本目は1本目（約 1.9 秒）が終わるまで待ち行列で待つ。
  await Promise.all([sequenceReferenceStatus(first.project,first.asset),sequenceReferenceStatus(second.project,second.asset)]);await referenceVerificationTesting.idle();
  const a=referenceReadSpeed(first.source)!,b=referenceReadSpeed(second.source)!;expect(a).toBeGreaterThan(0);expect(b).toBeGreaterThan(0);
  // 待ち時間を含めると2本目は半分以下の速さに見える。同じ読みの遅さなら同じ程度の速さ。
  expect(b/a).toBeGreaterThan(0.7);expect(b/a).toBeLessThan(1.4);
},15_000);
it('keeps the speed for the same size and modified time (the same card put back) but not after the file was modified',async()=>{
  const {project,source,asset}=await linked(24);const when=await touch(source),sizeBytes=(await stat(source)).size;
  await sequenceReferenceStatus(project,asset);await referenceVerificationTesting.idle();const speed=referenceReadSpeed(source)!;expect(speed).toBeGreaterThan(0);
  // 挿し直しの代わり: 中身・大きさ・更新時刻は同じまま、ino と ctime が変わる（照合記録は外れる）。
  const before=await stat(source),copy=join(dirname(source),'copy.tmp');await copyFile(source,copy);await utimes(copy,when,when);await rename(copy,source);
  const after=await stat(source);expect(after.ino).not.toBe(before.ino);expect(after.ctimeMs).not.toBe(before.ctimeMs);expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(await referenceReadState(project,asset)).toEqual({path:source,sizeBytes,verified:false,bytesPerSecond:speed});
  // 更新時刻が変わった（中身が変わったかもしれない）なら、測り直すまで出さない。
  await touch(source,10);expect(await referenceReadState(project,asset)).toEqual({path:source,sizeBytes,verified:false});
});
it('forgets the speed when the check gives up on a read that stopped',async()=>{
  referenceVerificationTesting.stallMs=400;const {project,source,asset}=await linked(32);await touch(source);
  await sequenceReferenceStatus(project,asset);await vi.waitFor(()=>expect(referenceReadSpeed(source)).toBeGreaterThan(0),{timeout:10_000,interval:20});
  process.env.HARNESS_TEST_DIGEST_DELAY_MS='5000';   // 次の 1MiB の後、読みが止まる（見張りの 400ms を超える）
  await referenceVerificationTesting.idle();
  // 見張りで切り上げた（読み取りのエラーとして覚えている）ことを確かめてから、速さが消えたことを見る。
  expect(await sequenceReferenceStatus(project,asset)).toMatchObject({state:'invalid',message:'参照素材を読み取れません。接続と登録情報を確認してください'});
  expect(referenceReadSpeed(source)).toBeUndefined();expect(await referenceReadState(project,asset)).toEqual({path:source,sizeBytes:(await stat(source)).size,verified:false,failed:true});
},15_000);
it('reports a check that failed (content differs) so the open-time advice leaves it to the error banner',async()=>{
  const {project,source,asset}=await linked(24);await writeFile(source,wav(24,1));   // 同じ大きさで中身だけ違う
  expect(await referenceReadState(project,asset)).toEqual({path:source,sizeBytes:(await stat(source)).size,verified:false});   // 照合の前は失敗ではない
  await sequenceReferenceStatus(project,asset);await referenceVerificationTesting.idle();
  expect((await sequenceReferenceStatus(project,asset)).state).toBe('mismatch');
  expect(await referenceReadState(project,asset)).toMatchObject({path:source,verified:false,failed:true});
});
