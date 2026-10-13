/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({read:vi.fn()}));
vi.mock('./videoDuration',()=>({readVideoDurations:h.read}));
import {createWithDurations,forgetImportSeconds,handOverImportSeconds,importSeconds,importSecondsHandOverKey,noteImportSeconds,subscribeImportSeconds,takeOverImportSeconds} from './importSeconds';
type Options={onRead?(key:string,seconds:number):void;signal?:AbortSignal};
afterEach(()=>{h.read.mockReset();sessionStorage.clear();});
const files=[new File(['a'],'a.mp4'),new File(['b'],'b.mp4')];
it('asks for the batch before any length is read, and keeps the lengths read before and after it exists',async()=>{
  let options!:Options;h.read.mockImplementation((_files:File[],given:Options)=>{options=given;return new Promise(()=>{});});
  const listener=vi.fn(),stop=subscribeImportSeconds(listener);
  let created!:(view:{batchId:string})=>void;const create=vi.fn(()=>new Promise<{batchId:string}>(done=>{created=done;}));
  const result=createWithDurations(files,create);
  expect(create).toHaveBeenCalledTimes(1);expect(h.read).toHaveBeenCalledWith(files,expect.anything());
  options.onRead!('1',3);expect(importSeconds('imp-early','1')).toBeUndefined();
  created({batchId:'imp-early'});await result;
  expect(importSeconds('imp-early','1')).toBe(3);
  options.onRead!('0',2);expect(importSeconds('imp-early','0')).toBe(2);expect(listener).toHaveBeenCalled();stop();
});
it('stops starting new reads when the batch could not be made',async()=>{
  let options!:Options;h.read.mockImplementation((_files:File[],given:Options)=>{options=given;return new Promise(()=>{});});
  await expect(createWithDurations(files,()=>Promise.reject(new Error('作れません')))).rejects.toThrow('作れません');
  expect(options.signal!.aborted).toBe(true);
});
it('does not read anything without files (the browser version)',async()=>{
  expect((await createWithDurations(null,async()=>({batchId:'imp-none'}))).view).toEqual({batchId:'imp-none'});expect(h.read).not.toHaveBeenCalled();
});
it('tells the listeners when lengths arrive, until they stop listening',()=>{
  const listener=vi.fn(),stop=subscribeImportSeconds(listener);
  noteImportSeconds('imp-note',[['0',1]]);expect(listener).toHaveBeenCalledTimes(1);stop();
  noteImportSeconds('imp-note',[['1',1]]);expect(listener).toHaveBeenCalledTimes(1);expect(importSeconds('imp-note','1')).toBe(1);
});

// ---- Task 8 レビュー1回目: 止める口・ページの読み直しをまたぐ引き継ぎ ----
it('stops reading and forgets the batch through the returned stop, and stops reading when the given signal stops',async()=>{
  const given:Options[]=[];h.read.mockImplementation((_files:File[],options:Options)=>{given.push(options);options.onRead!('0',2);return new Promise(()=>{});});
  const {stop}=await createWithDurations(files,async()=>({batchId:'imp-stop'}));
  expect(importSeconds('imp-stop','0')).toBe(2);stop();expect(given[0]!.signal!.aborted).toBe(true);expect(importSeconds('imp-stop','0')).toBeUndefined();
  const owner=new AbortController();await createWithDurations(files,async()=>({batchId:'imp-owner'}),{signal:owner.signal});
  owner.abort();expect(given[1]!.signal!.aborted).toBe(true);expect(importSeconds('imp-owner','0')).toBe(2);
  const left=new AbortController();left.abort();await createWithDurations(files,async()=>({batchId:'imp-left'}),{signal:left.signal});expect(given[2]!.signal!.aborted).toBe(true);
});
it('forgetting a batch also stops reading its lengths',async()=>{
  let options!:Options;h.read.mockImplementation((_files:File[],given:Options)=>{options=given;return new Promise(()=>{});});
  await createWithDurations(files,async()=>({batchId:'imp-forget'}));forgetImportSeconds('imp-forget');expect(options.signal!.aborted).toBe(true);
});
it('leaves the lengths read so far for one project in the session and takes them over once (fresh module state)',async()=>{
  noteImportSeconds('imp-hand',[['0',2],['2',1.5]]);handOverImportSeconds('p1','imp-hand');handOverImportSeconds('p1','imp-unknown');
  vi.resetModules();const fresh=await import('./importSeconds');
  fresh.takeOverImportSeconds('p2');expect(fresh.importSeconds('imp-hand','0')).toBeUndefined();
  fresh.takeOverImportSeconds('p1');expect([fresh.importSeconds('imp-hand','0'),fresh.importSeconds('imp-hand','2')]).toEqual([2,1.5]);
  fresh.forgetImportSeconds('imp-hand');fresh.takeOverImportSeconds('p1');expect(fresh.importSeconds('imp-hand','0')).toBeUndefined();
});
it('ignores broken or unavailable session storage',async()=>{
  sessionStorage.setItem(importSecondsHandOverKey('p3'),'{broken');expect(()=>takeOverImportSeconds('p3')).not.toThrow();
  sessionStorage.setItem(importSecondsHandOverKey('p3'),JSON.stringify({'imp-bad':{'0':'2','1':-1,'2':3},'imp-list':[1]}));takeOverImportSeconds('p3');
  expect([importSeconds('imp-bad','0'),importSeconds('imp-bad','1'),importSeconds('imp-bad','2')]).toEqual([undefined,undefined,3]);
  const getItem=vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('blocked');});
  const setItem=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new Error('blocked');});
  try{noteImportSeconds('imp-blocked',[['0',1]]);expect(()=>handOverImportSeconds('p4','imp-blocked')).not.toThrow();expect(()=>takeOverImportSeconds('p4')).not.toThrow();}
  finally{getItem.mockRestore();setItem.mockRestore();}
});
