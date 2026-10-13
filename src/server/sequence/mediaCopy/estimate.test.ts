import {afterEach,expect,it,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {constants} from 'node:fs';
import {stat,symlink,truncate,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {WRITE_FLAGS} from './io';
import {PROBE_BYTES,PROBE_STALL_MS,SLOW_SECONDS,copyTimeRange,estimateTesting,judgeAddedSource,measureLeadingRead} from './estimate';
import {GiB,MiB,copyWorld,type CopyWorld} from './__fixtures__/copyWorld';

/** 止まる読み: release まで OS の読みから戻らない（カードリーダーの不調・USB の再接続待ち）。 */
const parked:(()=>void)[]=[],park=()=>new Promise<void>(resume=>parked.push(resume)),release=()=>{for(const resume of parked.splice(0))resume();};
let world:CopyWorld;
afterEach(async()=>{release();estimateTesting.stallMs=PROBE_STALL_MS;estimateTesting.probeBytes=PROBE_BYTES;await world?.cleanup();});
const sparse=async(path:string,bytes:number)=>{await writeFile(path,'');await truncate(path,bytes);};   // 中身はゼロ（実際には書かない）
const reads=()=>world.faulty.calls.filter(call=>call.op==='read');
const unchanged=async(path:string)=>{const {size,mtimeMs,ctimeMs}=await stat(path);return {size,mtimeMs,ctimeMs};};

it('reads up to the first 64MB and measures bytes over monotonic time, not the wait before it',async()=>{
  world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);const before=await unchanged(file);
  world.faults.push({op:'open',before:()=>world.clock.advance(5000)});   // 呼ばれてから最初の読みまでに待った時間（測らない）
  expect(await measureLeadingRead(world.io,file)).toEqual({bytes:PROBE_BYTES,ms:64_000});   // SD は仮想で 1MiB/s
  expect(reads().reduce((sum,call)=>sum+(call.bytes??0),0)).toBe(PROBE_BYTES);
  // 元のファイルは読み取り専用・リンクをたどらずに開き、閉じる。中身も識別情報も変えない。
  const opens=world.faulty.calls.filter(call=>call.op==='open');expect(opens).toHaveLength(1);
  expect(opens[0]!.flags!&WRITE_FLAGS).toBe(0);expect(opens[0]!.flags!&constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
  expect(world.faulty.calls.at(-1)?.op).toBe('close');expect(await unchanged(file)).toEqual(before);
});
it('does not measure files under 64MB and reads none of them',async()=>{
  world=await copyWorld();const file=join(world.sd,'small.mp4');await sparse(file,PROBE_BYTES-1);
  expect(await measureLeadingRead(world.io,file)).toBeUndefined();expect(reads()).toHaveLength(0);
  expect(await judgeAddedSource(world.io,file)).toEqual({slow:false,external:true,measured:false,sizeBytes:PROBE_BYTES-1});expect(reads()).toHaveLength(0);
});
it('stops reading as soon as the caller cancels and still closes the file',async()=>{
  world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);const controller=new AbortController();
  world.faults.push({op:'read',nth:2,before:()=>controller.abort(new Error('取り消しました（試験）'))});
  await expect(measureLeadingRead(world.io,file,controller.signal)).rejects.toThrow('取り消しました（試験）');
  expect(reads()).toHaveLength(2);expect(world.faulty.calls.at(-1)?.op).toBe('close');
});
it('returns at once when the caller cancels during a read that does not come back, and closes the file only after that read returns',async()=>{
  world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);const controller=new AbortController();
  world.faults.push({op:'read',nth:2,before:()=>{setTimeout(()=>controller.abort(new Error('取り消しました（試験）')),20);return park();}});
  await expect(measureLeadingRead(world.io,file,controller.signal)).rejects.toThrow('取り消しました（試験）');
  expect(world.faulty.calls.some(call=>call.op==='close')).toBe(false);   // 読み中の fd は閉じない（読みが戻るまで待つ）
  release();await vi.waitFor(()=>expect(world.faulty.calls.at(-1)?.op).toBe('close'));
});
it('gives up on a read that does not come back within the watch time',async()=>{
  estimateTesting.stallMs=50;world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);world.faults.push({op:'read',nth:1,before:park});
  const started=Date.now();await expect(measureLeadingRead(world.io,file)).rejects.toMatchObject({code:'ETIMEDOUT'});expect(Date.now()-started).toBeLessThan(2000);
  expect(PROBE_STALL_MS).toBe(30_000);
});
it('does not open the same file again while an abandoned read is still stuck, and does once that read has returned',async()=>{
  estimateTesting.stallMs=50;world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);world.faults.push({op:'read',nth:1,before:park});
  const opens=()=>world.faulty.calls.filter(call=>call.op==='open').length;
  await expect(measureLeadingRead(world.io,file)).rejects.toMatchObject({code:'ETIMEDOUT'});
  await expect(measureLeadingRead(world.io,file)).rejects.toMatchObject({code:'ETIMEDOUT'});await expect(judgeAddedSource(world.io,file)).rejects.toMatchObject({code:'ETIMEDOUT'});
  expect(opens()).toBe(1);
  release();await vi.waitFor(()=>expect(world.faulty.calls.at(-1)?.op).toBe('close'));
  expect(await measureLeadingRead(world.io,file)).toEqual({bytes:PROBE_BYTES,ms:64_000});expect(opens()).toBe(2);
});
it('does not count a file that shrinks under 64MB while it is being read',async()=>{
  world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);world.faults.push({op:'read',nth:3,before:()=>truncate(file,10*MiB)});
  expect(await measureLeadingRead(world.io,file)).toBeUndefined();expect(reads().reduce((sum,call)=>sum+(call.bytes??0),0)).toBe(10*MiB);
});
it('cuts the last read to what is left when the limit is not a multiple of the read size',async()=>{
  estimateTesting.probeBytes=5*MiB+3;world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);
  expect(await measureLeadingRead(world.io,file)).toMatchObject({bytes:5*MiB+3});expect(reads().map(call=>call.bytes)).toEqual([4*MiB,MiB+3]);
});
it('does not hang on a FIFO in place of a file (opens without waiting for a writer)',async()=>{
  world=await copyWorld();const fifo=join(world.sd,'pipe.mp4');execFileSync('/usr/bin/mkfifo',[fifo]);
  await expect(measureLeadingRead(world.io,fifo)).rejects.toThrow('通常のファイルではありません');expect(reads()).toHaveLength(0);
},5000);
it('opens without following a link, and judges a linked file by where it really is',async()=>{
  world=await copyWorld();const file=join(world.sd,'big.mp4'),link=join(world.home,'link.mp4');await sparse(file,100*MiB);await symlink(file,link);
  await expect(measureLeadingRead(world.io,link)).rejects.toMatchObject({code:'ELOOP'});expect(reads()).toHaveLength(0);
  expect(await judgeAddedSource(world.io,link)).toMatchObject({slow:true,external:true,measured:true,volumeUuid:'SD'});
});
it('judges an external 100MB file at 1MB/s as slow (100 s ≥ 60 s) and at 10MB/s as not slow',async()=>{
  world=await copyWorld();const file=join(world.sd,'big.mp4');await sparse(file,100*MiB);
  expect(await judgeAddedSource(world.io,file)).toMatchObject({slow:true,external:true,measured:true,sizeBytes:100*MiB,seconds:100,bytesPerSecond:MiB,volumeUuid:'SD'});
  await world.cleanup();world=await copyWorld({sdProbeBytesPerSecond:10*MiB});const fast=join(world.sd,'big.mp4');await sparse(fast,100*MiB);
  const judged=await judgeAddedSource(world.io,fast);expect(judged).toMatchObject({slow:false,measured:true});expect(judged.seconds).toBeLessThan(SLOW_SECONDS);
});
it('judges exactly 60 s as slow and just under it as not slow',async()=>{
  world=await copyWorld({sdProbeBytesPerSecond:2*MiB});const file=join(world.sd,'edge.mp4'),under=join(world.sd,'under.mp4');await sparse(file,120*MiB);await sparse(under,120*MiB-1);
  expect(await judgeAddedSource(world.io,file)).toMatchObject({slow:true,seconds:SLOW_SECONDS,bytesPerSecond:2*MiB});
  const judged=await judgeAddedSource(world.io,under);expect(judged.slow).toBe(false);expect(judged.seconds).toBeLessThan(SLOW_SECONDS);
});
it('never judges a file on this Mac as slow, does not read it, and does not ask diskutil',async()=>{
  world=await copyWorld();const file=join(world.home,'big.mp4');await sparse(file,100*MiB);let details=0;const io={...world.io,volumeDetails:async(mountPoint:string)=>{details++;return world.io.volumeDetails(mountPoint);}};
  expect(await judgeAddedSource(io,file)).toEqual({slow:false,external:false,measured:false,sizeBytes:100*MiB});
  expect(world.faulty.calls.some(call=>call.op==='read'||call.op==='open')).toBe(false);expect(details).toBe(0);
});
it('refuses something that is not a regular file without opening it',async()=>{
  world=await copyWorld();
  await expect(judgeAddedSource(world.io,world.sd)).rejects.toThrow('通常のファイルではありません');expect(world.faulty.calls.some(call=>call.op==='open')).toBe(false);
});
it('gives a copy time range (source read + write + verify) and nothing without a measured speed',()=>{
  const bytes=29*GiB,read=bytes/32e6;
  expect(copyTimeRange(bytes,32e6)).toEqual({minSeconds:Math.ceil(read+29),maxSeconds:Math.ceil(read*3)});
  expect(copyTimeRange(bytes)).toBeNull();expect(copyTimeRange(bytes,0)).toBeNull();expect(copyTimeRange(bytes,Number.POSITIVE_INFINITY)).toBeNull();
});
it('reads the drive identity only for a file judged slow (small and fast files call no diskutil)',async()=>{
  world=await copyWorld();const small=join(world.sd,'small.mp4'),slow=join(world.sd,'slow.mp4'),fast=join(world.ssd,'fast.mp4');
  await sparse(small,PROBE_BYTES-1);await sparse(slow,100*MiB);await sparse(fast,100*MiB);
  const identities=()=>world.faulty.calls.filter(call=>call.op==='volumeDetails').length;
  expect(await judgeAddedSource(world.io,small)).toEqual({slow:false,external:true,measured:false,sizeBytes:PROBE_BYTES-1});expect(identities()).toBe(0);
  expect(world.faulty.calls.some(call=>call.op==='open')).toBe(false);
  expect(await judgeAddedSource(world.io,fast)).toMatchObject({slow:false,measured:true});expect(identities()).toBe(0);
  expect(await judgeAddedSource(world.io,slow)).toMatchObject({slow:true,volumeUuid:'SD'});expect(identities()).toBeGreaterThan(0);
});
it('in one batch, a drive whose leading read timed out is not read again: the rest of it is unmeasured, other drives are still measured',async()=>{
  estimateTesting.stallMs=50;world=await copyWorld();const names=['a.mp4','b.mp4','c.mp4'].map(name=>join(world.sd,name)),fast=join(world.ssd,'fast.mp4');
  for(const file of [...names,fast])await sparse(file,100*MiB);world.faults.push({op:'read',path:/\/sd\//,before:park});   // このカードの読みはどれも戻らない
  const opens=(drive:string)=>world.faulty.calls.filter(call=>call.op==='open'&&call.path.startsWith(`${drive}/`)).length,session={stalledDrives:new Set<string>()};
  const started=Date.now();await expect(judgeAddedSource(world.io,names[0]!,undefined,session)).rejects.toMatchObject({code:'ETIMEDOUT'});
  for(const file of names.slice(1))expect(await judgeAddedSource(world.io,file,undefined,session)).toEqual({slow:false,external:true,measured:false,sizeBytes:100*MiB});
  expect(opens(world.sd)).toBe(1);expect(Date.now()-started).toBeLessThan(2000);
  expect(await judgeAddedSource(world.io,fast,undefined,session)).toMatchObject({measured:true});expect(opens(world.ssd)).toBe(1);
  // 別の束（覚えを共有しない）は測り直す。取り消し（時間切れでない）ではドライブを覚えない
  await expect(judgeAddedSource(world.io,names[1]!,undefined,{stalledDrives:new Set()})).rejects.toMatchObject({code:'ETIMEDOUT'});expect(opens(world.sd)).toBe(2);
  const cancelled={stalledDrives:new Set<string>()},controller=new AbortController();setTimeout(()=>controller.abort(new Error('取り消しました（試験）')),10);
  await expect(judgeAddedSource(world.io,names[2]!,controller.signal,cancelled)).rejects.toThrow('取り消しました（試験）');expect(cancelled.stalledDrives.size).toBe(0);
});
