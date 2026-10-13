/** @vitest-environment jsdom */
import {expect,it,vi} from 'vitest';
import {VIDEO_DURATION_READS,readVideoDuration,readVideoDurations} from './videoDuration';
const element=(duration:number)=>{const video={duration,preload:'',muted:false,src:'',onloadedmetadata:null as null|(()=>void),onerror:null as null|(()=>void),removeAttribute:vi.fn(),load:vi.fn()};
  Object.defineProperty(video,'src',{set(value:string){if(value&&duration>=0)setTimeout(()=>video.onloadedmetadata?.(),0);else if(value)setTimeout(()=>video.onerror?.(),0);},get(){return '';}});return video;};
const url={createObjectURL:vi.fn(()=>'blob:x'),revokeObjectURL:vi.fn()};
it('reads the metadata duration and releases the object URL',async()=>{
  expect(await readVideoDuration(new File(['x'],'a.mp4'),{create:()=>element(2.5) as unknown as HTMLVideoElement,url})).toBe(2.5);
  expect(url.revokeObjectURL).toHaveBeenCalledWith('blob:x');
});
it('gives up on an unreadable file or after the timeout',async()=>{
  expect(await readVideoDuration(new File(['x'],'a.mp4'),{create:()=>element(-1) as unknown as HTMLVideoElement,url})).toBeUndefined();
  const silent={...element(1),preload:''};Object.defineProperty(silent,'src',{set(){},get(){return '';}});
  expect(await readVideoDuration(new File(['x'],'a.mp4'),{create:()=>silent as unknown as HTMLVideoElement,url,timeoutMs:5})).toBeUndefined();
});

// ---- Task 8: 後始末・鍵・同時数 ----
it('releases the element and the object URL after an error and after the timeout',async()=>{
  const failing=element(-1),revoke=vi.fn(),own={createObjectURL:vi.fn(()=>'blob:e'),revokeObjectURL:revoke};
  expect(await readVideoDuration(new File(['x'],'a.mp4'),{create:()=>failing as unknown as HTMLVideoElement,url:own})).toBeUndefined();
  expect(failing.removeAttribute).toHaveBeenCalledWith('src');expect(failing.load).toHaveBeenCalledTimes(1);expect(revoke).toHaveBeenCalledWith('blob:e');
  expect([failing.onloadedmetadata,failing.onerror]).toEqual([null,null]);
  const silent=element(1);Object.defineProperty(silent,'src',{set(){},get(){return '';}});revoke.mockClear();
  expect(await readVideoDuration(new File(['x'],'a.mp4'),{create:()=>silent as unknown as HTMLVideoElement,url:own,timeoutMs:5})).toBeUndefined();
  expect(silent.removeAttribute).toHaveBeenCalledWith('src');expect(silent.load).toHaveBeenCalledTimes(1);expect(revoke).toHaveBeenCalledWith('blob:e');
  expect([silent.onloadedmetadata,silent.onerror]).toEqual([null,null]);
});
/** 名前ごとの長さで読む偽の video。生きている（src を外していない）要素の最大数を数える。 */
const library=(seconds:Record<string,number>)=>{
  let alive=0,peak=0;
  const create=()=>{alive++;peak=Math.max(peak,alive);
    const video={duration:Number.NaN,preload:'',muted:false,onloadedmetadata:null as null|(()=>void),onerror:null as null|(()=>void),removeAttribute:vi.fn(()=>{alive--;}),load:vi.fn()};
    Object.defineProperty(video,'src',{set(value:string){const known=seconds[value.slice('blob:'.length)];
      setTimeout(()=>{if(known!==undefined){video.duration=known;video.onloadedmetadata?.();}else video.onerror?.();},1);},get(){return '';}});
    return video as unknown as HTMLVideoElement;};
  return {deps:{create,url:{createObjectURL:(file:Blob|MediaSource)=>`blob:${(file as File).name}`,revokeObjectURL:vi.fn()}},peak:()=>peak};
};
it('keys each length by the file index and skips the files it could not read',async()=>{
  const {deps}=library({'a.mp4':2.5,'c.mp4':1.5}),read:Array<[string,number]>=[];
  const lengths=await readVideoDurations([new File(['a'],'a.mp4'),new File(['b'],'b.mp4'),new File(['c'],'c.mp4')],{deps,onRead:(key,value)=>{read.push([key,value]);}});
  expect([...lengths].sort()).toEqual([['0',2.5],['2',1.5]]);expect(read.sort()).toEqual([['0',2.5],['2',1.5]]);
});
it(`never keeps more than ${VIDEO_DURATION_READS} video elements at once, and still reads every file`,async()=>{
  const names=Array.from({length:10},(_,index)=>`clip${index}.mp4`),{deps,peak}=library(Object.fromEntries(names.map((name,index)=>[name,index+1])));
  const lengths=await readVideoDurations(names.map(name=>new File(['x'],name)),{deps});
  expect(peak()).toBe(VIDEO_DURATION_READS);expect(lengths.size).toBe(10);expect(lengths.get('9')).toBe(10);
});
it('starts no new reads once stopped',async()=>{
  const names=Array.from({length:10},(_,index)=>`clip${index}.mp4`),{deps}=library(Object.fromEntries(names.map(name=>[name,1])));
  const stop=new AbortController(),create=vi.fn(deps.create);stop.abort();
  expect((await readVideoDurations(names.map(name=>new File(['x'],name)),{deps:{...deps,create},signal:stop.signal})).size).toBe(0);expect(create).not.toHaveBeenCalled();
});
