/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {rational as r} from '../../core/sequence/time';
import {FRAME_FETCH_CONCURRENCY,MAX_CACHED_THUMBS,cachedThumb,loadThumbs,nearestThumb,queuedThumbRequests,resetThumbs,thumbOwner} from './frameThumbnails';
afterEach(()=>{resetThumbs();vi.unstubAllGlobals();});
const source=(assetId:string)=>({projectId:'p',assetId,streamIndex:0,fingerprint:'f'.repeat(64)});
function server(){
  const pending:Array<{url:URL;resolve():void}>=[];let inFlight=0,peak=0;
  vi.stubGlobal('fetch',vi.fn((input:string,init?:RequestInit)=>{const url=new URL(input,'http://localhost');inFlight++;peak=Math.max(peak,inFlight);
    return new Promise((resolve,reject)=>{init?.signal?.addEventListener('abort',()=>{inFlight--;reject(init.signal!.reason);});
      pending.push({url,resolve:()=>{inFlight--;const times=url.searchParams.get('times')!.split(',');
        resolve({ok:true,json:async()=>({version:1,frames:times.map((time,frame)=>({time,frame,data:`data:image/jpeg;base64,${btoa(time)}`})),failed:[]})});}});});}));
  return {pending,peak:()=>peak};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
it('never holds more than the allowed browser connections for filmstrips, whatever the number of clips',async()=>{
  expect(FRAME_FETCH_CONCURRENCY).toBe(2);// Task 1 の確定値
  const s=server(),signal=new AbortController().signal,loads=['a','b','c','d'].map(id=>loadThumbs(source(id),[r(1),r(2)],signal));
  expect(s.pending).toHaveLength(FRAME_FETCH_CONCURRENCY);
  while(s.pending.length){s.pending.shift()!.resolve();await tick();}
  await Promise.all(loads);expect(s.peak()).toBe(FRAME_FETCH_CONCURRENCY);
  expect(cachedThumb(thumbOwner(source('d')),'2/1')).toBe(`data:image/jpeg;base64,${btoa('2/1')}`);
});
it('drops a cancelled request from the queue before it reaches the server',async()=>{
  const s=server(),keep=new AbortController(),cancel=new AbortController();
  const a=loadThumbs(source('a'),[r(1)],keep.signal),b=loadThumbs(source('b'),[r(1)],keep.signal),c=loadThumbs(source('c'),[r(1)],cancel.signal);
  expect(queuedThumbRequests()).toBe(1);cancel.abort(new Error('scrolled away'));await expect(c).rejects.toThrow('scrolled away');expect(queuedThumbRequests()).toBe(0);
  s.pending.splice(0).forEach(p=>p.resolve());await Promise.all([a,b]);await tick();expect(s.pending).toHaveLength(0);
});
it('requests only the missing times and offers the nearest fetched frame while dragging',async()=>{
  const s=server(),signal=new AbortController().signal;
  const first=loadThumbs(source('a'),[r(1),r(3)],signal);s.pending.shift()!.resolve();await first;
  const second=loadThumbs(source('a'),[r(1),r(2)],signal);expect(s.pending[0]!.url.searchParams.get('times')).toBe('2/1');s.pending.shift()!.resolve();await second;
  expect(nearestThumb(thumbOwner(source('a')),2.6)).toBe(`data:image/jpeg;base64,${btoa('3/1')}`);
});
it('asks for the explicit stream at the shared height, and keeps another stream of the same file apart',async()=>{
  const s=server(),signal=new AbortController().signal,second={...source('a'),streamIndex:1};
  const load=loadThumbs(second,[r(1)],signal),url=s.pending[0]!.url;
  expect(url.pathname).toBe('/api/sequence/frames');expect(Object.fromEntries(url.searchParams)).toEqual({id:'p',asset:'a',stream:'1',height:'72',times:'1/1'});
  s.pending.shift()!.resolve();await load;
  expect(cachedThumb(thumbOwner(second),'1/1')).toBeDefined();expect(cachedThumb(thumbOwner(source('a')),'1/1')).toBeUndefined();
});
it('drops the least recently read thumb first, across sources and within one source',async()=>{
  const s=server(),signal=new AbortController().signal,answer=async(load:Promise<unknown>)=>{s.pending.shift()!.resolve();await load;};
  const a=thumbOwner(source('a')),b=thumbOwner(source('b'));
  await answer(loadThumbs(source('a'),[r(1),r(2)],signal));await answer(loadThumbs(source('b'),[r(1)],signal));
  expect(cachedThumb(a,'1/1')).toBeDefined();// 読んだので a の 1/1 は新しい側
  await answer(loadThumbs(source('c'),Array.from({length:MAX_CACHED_THUMBS-2},(_,i)=>r(100+i)),signal));
  expect(cachedThumb(b,'1/1')).toBeUndefined();// 上限を1件越えた → 読まれていない b が先に消える
  await answer(loadThumbs(source('c'),[r(5000)],signal));
  expect(cachedThumb(a,'2/1')).toBeUndefined();expect(cachedThumb(a,'1/1')).toBeDefined();// a の中でも読まれていない方が先
});
