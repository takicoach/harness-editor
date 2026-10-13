import {afterEach,describe,expect,it,vi} from 'vitest';
import {tmpdir} from 'node:os';
import {isSimulatedCrash,nodeCopyIo,type CopyIo,type SpaceInfo} from './io';
import {fakeClock} from './fakeIo';
import {copyWorld,type CopyWorld} from './__fixtures__/copyWorld';
import {COPY_MARGIN_MIN_BYTES,GiB,MONITOR_BYTES,MONITOR_MS,SpaceMonitor,SpaceReservations,SpaceStopError,evaluateSpace,measureSpace,safetyMargin} from './space';

let world:CopyWorld|undefined;afterEach(async()=>{await world?.cleanup();world=undefined;});
/** bsize 1 の statfs（1バイト単位の境界を試すため。偽ボリュームは 4096 バイト単位に丸める）。 */
const bytesIo=(free:()=>number,capacity=100*GiB,base:Partial<CopyIo>={}):CopyIo=>({...nodeCopyIo,...base,statfs:async()=>({bsize:1,bavail:free(),blocks:capacity})});

it('keeps 20GB or 10% of the capacity, whichever is larger (GB = 1024³ bytes)',()=>{
  expect(GiB).toBe(1024**3);expect(COPY_MARGIN_MIN_BYTES).toBe(20*GiB);expect(MONITOR_BYTES).toBe(GiB);expect(MONITOR_MS).toBe(5000);
  expect(safetyMargin(100*GiB)).toBe(20*GiB);expect(safetyMargin(200*GiB)).toBe(20*GiB);expect(safetyMargin(1000*GiB)).toBe(100*GiB);
  // 境界: 容量 200GB ちょうどで 2 つの式が並び、1 バイト超えると 10% の側（切り上げ）になる
  expect(safetyMargin(200*GiB-1)).toBe(20*GiB);expect(safetyMargin(200*GiB+1)).toBe(20*GiB+1);
});
it('refuses a destination whose free space after the copy would drop below the margin, with the reason',()=>{
  expect(evaluateSpace({free:60*GiB,capacity:100*GiB},0,30*GiB)).toMatchObject({after:30*GiB,margin:20*GiB,selectable:true});
  const low=evaluateSpace({free:45*GiB,capacity:100*GiB},0,30*GiB);expect(low.selectable).toBe(false);expect(low.reason).toContain('安全のための余裕（20.0 GB');
});
it('accepts exactly the margin left after the copy and refuses one byte less (both formulas)',()=>{
  const exact=evaluateSpace({free:50*GiB,capacity:100*GiB},0,30*GiB);expect(exact).toMatchObject({after:20*GiB,selectable:true});expect(exact.reason).toBeUndefined();
  const short=evaluateSpace({free:50*GiB,capacity:100*GiB},0,30*GiB+1);expect(short).toMatchObject({after:20*GiB-1,selectable:false});
  expect(short.reason).toContain('コピー後の空きが 19.9 GB');   // 余裕に届かない値を「20.0」と丸めて見せない
  expect(evaluateSpace({free:130*GiB,capacity:1000*GiB},0,30*GiB)).toMatchObject({margin:100*GiB,after:100*GiB,selectable:true});
  const tenth=evaluateSpace({free:130*GiB,capacity:1000*GiB},0,30*GiB+1);expect(tenth.selectable).toBe(false);expect(tenth.reason).toContain('安全のための余裕（100.0 GB');
});
it('never offers an internal disk that is already under 10% free',()=>{
  expect(evaluateSpace({free:40*GiB,capacity:500*GiB},0,1).selectable).toBe(false);
  // コピーの量に関係なく: 空きがちょうど 10% なら 0 バイトのコピーだけ通り、1 バイト少なければ何も通らない
  expect(evaluateSpace({free:50*GiB,capacity:500*GiB},0,0).selectable).toBe(true);
  const under=evaluateSpace({free:50*GiB-1,capacity:500*GiB},0,0);expect(under.selectable).toBe(false);expect(under.reason).toContain('すでに安全のための余裕（50.0 GB');
});
it('rounds the margin up and the shortfall down, so they never read the same (1TB drive)',async()=>{
  const tb=evaluateSpace({free:1e12,capacity:1e12},0,9e11+1);expect(tb).toMatchObject({margin:1e11,after:1e11-1,selectable:false});
  expect(tb.reason).toContain('コピー後の空きが 93.1 GB');expect(tb.reason).toContain('安全のための余裕（93.2 GB');
  const reservations=new SpaceReservations(),monitor=new SpaceMonitor(bytesIo(()=>1e11-1,1e12),'/x',reservations.reserve('u',0),reservations,safetyMargin(1e12));
  await expect(monitor.check(0)).rejects.toThrow('安全のための余裕（93.2 GB）');
});
it('refuses when the numbers cannot be computed',()=>{
  const broken=evaluateSpace({free:60*GiB,capacity:100*GiB},Number.NaN,1);expect(broken.selectable).toBe(false);expect(broken.reason).not.toContain('NaN');
  // 監視と同じく、予約・コピーの量が 0 以上の有限の数でなければ選ばせない（負の量で空きが増えたように見せない）
  for(const [reserved,copy] of [[-GiB,0],[0,-GiB],[Number.NaN,1],[0,Number.POSITIVE_INFINITY]] as const){
    const result=evaluateSpace({free:60*GiB,capacity:100*GiB},reserved,copy);expect(result.selectable).toBe(false);expect(result.reason).toBe('空き容量を計算できないため選べません');
  }
});
it('sums reservations by space unit (an APFS container is one unit), excluding the caller',()=>{
  const reservations=new SpaceReservations(),a=reservations.reserve('apfs:disk9',10*GiB);reservations.reserve('volume:SD',5*GiB);
  expect(reservations.reservedIn('apfs:disk9')).toBe(10*GiB);expect(reservations.reservedIn('apfs:disk9',a)).toBe(0);
  a.update(4*GiB);expect(reservations.reservedIn('apfs:disk9')).toBe(4*GiB);a.release();expect(reservations.reservedIn('apfs:disk9')).toBe(0);
  const withReserved=evaluateSpace({free:60*GiB,capacity:100*GiB},reservations.reservedIn('volume:SD'),30*GiB);expect(withReserved.after).toBe(25*GiB);
  expect(evaluateSpace({free:55*GiB,capacity:100*GiB},5*GiB,30*GiB+1).reason).toContain('他のコピーの分 5.0 GB');
});
it('keeps a released reservation released, and adds up several reservations in one unit',()=>{
  const reservations=new SpaceReservations(),a=reservations.reserve('apfs:disk9',3*GiB),b=reservations.reserve('apfs:disk9',2*GiB);
  expect(reservations.reservedIn('apfs:disk9')).toBe(5*GiB);expect(reservations.reservedIn('apfs:disk9',b)).toBe(3*GiB);
  a.release();a.update(7*GiB);expect(reservations.reservedIn('apfs:disk9')).toBe(2*GiB);a.release();expect(reservations.reservedIn('apfs:disk9')).toBe(2*GiB);
  b.release();const c=reservations.reserve('apfs:disk9',GiB);b.update(9*GiB);expect(reservations.reservedIn('apfs:disk9')).toBe(GiB);
  c.update(-1);expect(reservations.reservedIn('apfs:disk9')).toBe(0);
  // 解放済みの予約をもう一度解放しても、同じ単位に作り直された別の予約は消さない
  const d=reservations.reserve('volume:SD',GiB);d.release();reservations.reserve('volume:SD',5*GiB);d.release();expect(reservations.reservedIn('volume:SD')).toBe(5*GiB);
  expect(()=>reservations.reserve('u',Number.NaN)).toThrow(RangeError);expect(()=>c.update(Number.POSITIVE_INFINITY)).toThrow(RangeError);
});
describe('measureSpace',()=>{
  it('measures free as bavail × bsize and capacity as blocks × bsize',async()=>{
    expect(await measureSpace({...nodeCopyIo,statfs:async()=>({bsize:4096,bavail:3,blocks:10})},'/x')).toEqual({free:3*4096,capacity:10*4096});
    world=await copyWorld();expect(await measureSpace(world.io,world.ssd)).toEqual({free:900*GiB,capacity:1000*GiB});
    const real=await measureSpace(nodeCopyIo,tmpdir());   // 読むだけ（書かない）
    expect(Number.isSafeInteger(real.free)&&Number.isSafeInteger(real.capacity)&&real.free<=real.capacity&&real.capacity>0).toBe(true);
  });
  it.each<[string,SpaceInfo]>([['NaN',{bavail:Number.NaN,bsize:4096,blocks:1}],['zero capacity',{bavail:0,bsize:4096,blocks:0}],['negative',{bavail:-1,bsize:4096,blocks:10}],['negative block size with a positive count',{bavail:1,bsize:-4096,blocks:-10}],['negative block size',{bavail:-1,bsize:-4096,blocks:-10}],
    ['more free than capacity',{bavail:11,bsize:4096,blocks:10}],['fractional',{bavail:1.5,bsize:4096,blocks:10}]])('fails to measure when statfs returns nonsense (%s)',async(_name,info)=>{
    await expect(measureSpace({...nodeCopyIo,statfs:async()=>info},'/x')).rejects.toBeInstanceOf(SpaceStopError);
  });
  it('fails to measure when statfs fails, keeping the errno, but lets a simulated crash through',async()=>{
    const error=await measureSpace({...nodeCopyIo,statfs:async()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}},'/x').catch((caught:unknown)=>caught);
    expect(error).toBeInstanceOf(SpaceStopError);expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('EIO');
    world=await copyWorld();world.faults.push({op:'statfs',crash:true});
    const crash=await measureSpace(world.io,world.ssd).catch((caught:unknown)=>caught);expect(isSimulatedCrash(crash)).toBe(true);
  });
});
describe('SpaceMonitor',()=>{
  const setup=(free:()=>number)=>{const clock=fakeClock(),statfs=vi.fn(async()=>({bsize:4096,bavail:Math.floor(free()/4096),blocks:Math.floor(100*GiB/4096)}));
    const reservations=new SpaceReservations(),mine=reservations.reserve('volume:X',10*GiB);
    return {clock,statfs,reservations,mine,monitor:new SpaceMonitor({...nodeCopyIo,now:clock.now,statfs},'/x',mine,reservations,20*GiB)};};
  it('measures every 1GB written or every 5 seconds, whichever comes first',async()=>{
    const {clock,statfs,monitor}=setup(()=>80*GiB);
    await monitor.wrote(GiB/2,9*GiB);expect(statfs).toHaveBeenCalledTimes(0);await monitor.wrote(GiB/2,8.5*GiB);expect(statfs).toHaveBeenCalledTimes(1);
    clock.advance(MONITOR_MS-1);await monitor.wrote(1,8.4*GiB);expect(statfs).toHaveBeenCalledTimes(1);clock.advance(1);await monitor.wrote(1,8.4*GiB);expect(statfs).toHaveBeenCalledTimes(2);
  });
  it('restarts the 5-second count when it measures at 1GB',async()=>{
    const {clock,statfs,monitor}=setup(()=>80*GiB);clock.advance(2000);await monitor.wrote(GiB,9*GiB);expect(statfs).toHaveBeenCalledTimes(1);
    clock.advance(4000);await monitor.wrote(1,9*GiB);expect(statfs).toHaveBeenCalledTimes(1);   // 作ってから 6 秒でも、測ってからは 4 秒
    clock.advance(1000);await monitor.wrote(1,9*GiB);expect(statfs).toHaveBeenCalledTimes(2);
  });
  it('measures at exactly 1GB since the last measurement, not one byte earlier',async()=>{
    const {statfs,monitor}=setup(()=>80*GiB);
    await monitor.wrote(GiB-1,9*GiB);expect(statfs).toHaveBeenCalledTimes(0);await monitor.wrote(1,9*GiB-1);expect(statfs).toHaveBeenCalledTimes(1);
    await monitor.wrote(3*GiB,6*GiB);expect(statfs).toHaveBeenCalledTimes(2);await monitor.wrote(GiB-1,5*GiB);expect(statfs).toHaveBeenCalledTimes(2);   // 1回の大きな書き込みでも数え直す
  });
  it('updates its reservation to the bytes still to write, and stops when free minus the rest would fall below the margin',async()=>{
    let free=40*GiB;const {reservations,mine,monitor}=setup(()=>free);reservations.reserve('volume:X',5*GiB);
    await monitor.wrote(GiB,9*GiB);expect(reservations.reservedIn('volume:X',mine)).toBe(5*GiB);expect(reservations.reservedIn('volume:X')).toBe(14*GiB);
    free=33*GiB-1;await expect(monitor.wrote(GiB,8*GiB)).rejects.toThrow('下回る見込み');   // 4096 バイト単位に丸まり、33GiB−4096 − 他の予約 5GiB − 残り 8GiB ＜ 余裕
  });
  it('updates its reservation on every write, also between measurements, and on check',async()=>{
    const {statfs,reservations,monitor}=setup(()=>80*GiB);
    await monitor.wrote(1,7*GiB);expect(statfs).toHaveBeenCalledTimes(0);expect(reservations.reservedIn('volume:X')).toBe(7*GiB);
    await monitor.check(3*GiB);expect(statfs).toHaveBeenCalledTimes(1);expect(reservations.reservedIn('volume:X')).toBe(3*GiB);
  });
  it('continues when exactly the margin would be left after the rest and stops one byte short',async()=>{
    const reservations=new SpaceReservations(),mine=reservations.reserve('apfs:disk9',10*GiB);reservations.reserve('apfs:disk9',5*GiB);reservations.reserve('volume:SD',50*GiB);
    let free=20*GiB+5*GiB+8*GiB;const monitor=new SpaceMonitor(bytesIo(()=>free),'/x',mine,reservations,20*GiB);   // 別の単位（SD）の予約は差し引かない
    await expect(monitor.check(8*GiB)).resolves.toBeUndefined();
    free-=1;const error=await monitor.check(8*GiB).catch((caught:unknown)=>caught);expect(error).toBeInstanceOf(SpaceStopError);expect((error as SpaceStopError).stop).toBe(true);
  });
  it('stops when free space cannot be measured',async()=>{
    const reservations=new SpaceReservations();
    const failing=new SpaceMonitor({...nodeCopyIo,statfs:async()=>{throw Object.assign(new Error('EIO'),{code:'EIO'});}},'/x',reservations.reserve('u',1),reservations,20*GiB);
    await expect(failing.check(1)).rejects.toThrow('測れないため');
    const nonsense=new SpaceMonitor({...nodeCopyIo,statfs:async()=>({bsize:4096,bavail:Number.NaN,blocks:10})},'/x',reservations.reserve('u',1),reservations,20*GiB);
    await expect(nonsense.check(1)).rejects.toThrow('測れないため');
  });
  it('stops when the margin it was given is not a number',async()=>{
    const reservations=new SpaceReservations(),monitor=new SpaceMonitor(bytesIo(()=>90*GiB),'/x',reservations.reserve('u',GiB),reservations,Number.NaN);
    await expect(monitor.check(GiB)).rejects.toThrow('下回る見込み');
  });
  it('stops when the bytes still to write are not a number',async()=>{
    const {statfs,monitor}=setup(()=>80*GiB);await expect(monitor.wrote(1,Number.NaN)).rejects.toBeInstanceOf(SpaceStopError);await expect(monitor.check(Number.NaN)).rejects.toBeInstanceOf(SpaceStopError);
    expect(statfs).toHaveBeenCalledTimes(0);
  });
  it('lets a simulated crash through instead of turning it into a clean stop',async()=>{
    world=await copyWorld();world.faults.push({op:'statfs',crash:true});const reservations=new SpaceReservations();
    const monitor=new SpaceMonitor(world.io,world.ssd,reservations.reserve('apfs:disk9',GiB),reservations,20*GiB);
    const error=await monitor.check(GiB).catch((caught:unknown)=>caught);expect(isSimulatedCrash(error)).toBe(true);expect(error).not.toBeInstanceOf(SpaceStopError);
  });
});
