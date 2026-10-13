/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import * as snapIndex from './snapIndex';
import {scheduleSnapTargets,snapTargetsFor} from './snapTargets';
import {fixture} from '../../core/sequence/fixtures';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('builds once per document object, on idle time, and not again when asked first',async()=>{
  vi.stubGlobal('requestIdleCallback',undefined);const build=vi.spyOn(snapIndex,'buildSnapIndex'),a=fixture(),b=fixture();
  scheduleSnapTargets(a);expect(build).not.toHaveBeenCalled();
  await new Promise(resolve=>setTimeout(resolve,0));expect(build).toHaveBeenCalledTimes(1);expect(snapTargetsFor(a)).toBe(snapTargetsFor(a));expect(build).toHaveBeenCalledTimes(1);
  const cancel=scheduleSnapTargets(b);snapTargetsFor(b);cancel();await new Promise(resolve=>setTimeout(resolve,0));expect(build).toHaveBeenCalledTimes(2);
});
// 上の試験は取り消しの前にその場で作るので、取り消しが効かなくても通る。取り消しだけを確かめる。
it('a cancelled schedule never builds (the replaced document costs nothing)',async()=>{
  vi.stubGlobal('requestIdleCallback',undefined);const build=vi.spyOn(snapIndex,'buildSnapIndex'),a=fixture();
  const cancel=scheduleSnapTargets(a);cancel();cancel();await new Promise(resolve=>setTimeout(resolve,0));expect(build).not.toHaveBeenCalled();
  snapTargetsFor(a);expect(build).toHaveBeenCalledTimes(1);
});
it('uses requestIdleCallback with a deadline when present, and cancels that handle',()=>{
  const idle=vi.fn((_:()=>void,__?:{timeout:number})=>7),cancelIdle=vi.fn();vi.stubGlobal('requestIdleCallback',idle);vi.stubGlobal('cancelIdleCallback',cancelIdle);
  const build=vi.spyOn(snapIndex,'buildSnapIndex'),a=fixture(),b=fixture();
  scheduleSnapTargets(a)();expect(idle).toHaveBeenCalledWith(expect.any(Function),{timeout:1000});expect(cancelIdle).toHaveBeenCalledWith(7);expect(build).not.toHaveBeenCalled();
  scheduleSnapTargets(b);idle.mock.calls[1]![0]();expect(build).toHaveBeenCalledTimes(1);
  scheduleSnapTargets(b);expect(idle).toHaveBeenCalledTimes(2);   // 作り終えた文書は予約しない
});
