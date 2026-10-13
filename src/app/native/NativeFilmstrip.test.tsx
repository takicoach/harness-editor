/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,waitFor} from '@testing-library/react';
import {NativeFilmstrip} from './NativeFilmstrip';
import {MAX_CACHED_THUMBS,cachedThumb,loadThumbs,resetThumbs,thumbOwner} from './frameThumbnails';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
afterEach(()=>{cleanup();resetThumbs();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
function props(){
 const document:SequenceDocument={schemaVersion:2,id:'doc',name:'doc',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:60,background:'#000',tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'},
  assets:[{id:'original',kind:'media',file:'public/o.mp4',name:'原本',fingerprint:'a'.repeat(64),streams:[{index:2,kind:'video',codec:'h264',duration:r(100),frameRate:r(24),width:320,height:180},{index:3,kind:'video',codec:'h264',duration:r(100),frameRate:r(24),width:320,height:180}]}]};
 const clip={id:'c',name:'映像',trackId:'v',startFrame:0,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content:{kind:'video' as const,assetId:'original',streamIndex:2,sourceIn:r(1),rate:r(2)}};
 return {document,clip,projectId:'p',sourceOffsetFrames:30,displayStartFrame:100,displayDuration:30,pixelsPerFrame:4,scrollLeft:400,viewportWidth:252};
}
function serve(){const fetch=vi.fn(async(input:string)=>{const times=new URL(input,'http://localhost').searchParams.get('times')!.split(',');
  return {ok:true,json:async()=>({version:1,frames:times.map((time,frame)=>({time,frame,data:`data:image/jpeg;base64,${frame}`})),failed:[]})};});vi.stubGlobal('fetch',fetch);return fetch;}
const settle=(ms:number)=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms));});
it('asks the server for the exact source times of the visible cells and never creates a <video>',async()=>{
 const fetch=serve(),create=vi.spyOn(document,'createElement'),view=render(<NativeFilmstrip {...props()}/>);
 await waitFor(()=>expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('ready'));
 const url=new URL(fetch.mock.calls[0]![0] as string,'http://localhost');
 expect(url.pathname).toBe('/api/sequence/frames');expect(url.searchParams.get('stream')).toBe('2');expect(url.searchParams.get('times')).toBe('52/15,67/15');
 expect([...view.container.querySelectorAll('img')].map(img=>img.getAttribute('data-native-filmstrip-time'))).toEqual(['52/15','67/15']);
 expect(create.mock.calls.some(([tag])=>tag==='video')).toBe(false);
 expect(view.container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');expect((view.container.firstElementChild as HTMLElement).style.pointerEvents).toBe('none');
});
it('while dragging, reorders fetched frames by nearest time instead of asking again; asks after release',async()=>{
 const fetch=serve(),p=props(),view=render(<NativeFilmstrip {...p}/>);
 await waitFor(()=>expect(view.container.querySelectorAll('img')).toHaveLength(2));const calls=fetch.mock.calls.length;
 view.rerender(<NativeFilmstrip {...p} sourceOffsetFrames={33} frozen/>);
 await settle(300);
 expect(fetch.mock.calls.length).toBe(calls);expect(view.container.querySelectorAll('img')).toHaveLength(2);
 view.rerender(<NativeFilmstrip {...p} sourceOffsetFrames={33}/>);
 await waitFor(()=>expect(fetch.mock.calls.length).toBe(calls+1));
});
it('shows nothing for a missing stream or an offscreen piece, without asking',async()=>{
 const fetch=serve(),p=props();p.clip.content.streamIndex=9;const view=render(<NativeFilmstrip {...p}/>);
 expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('missing-source');
 view.rerender(<NativeFilmstrip {...props()} scrollLeft={10000}/>);expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('outside');
 await settle(200);expect(fetch).not.toHaveBeenCalled();
});
it('before the first preview picture (held), asks nothing and shows only exact frames already at hand; asks once released',async()=>{
 const fetch=serve(),p=props(),view=render(<NativeFilmstrip {...p} held/>);
 await settle(300);expect(fetch).not.toHaveBeenCalled();expect(view.container.querySelectorAll('img')).toHaveLength(0);
 expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('held');
 view.rerender(<NativeFilmstrip {...p}/>);
 await waitFor(()=>expect(view.container.querySelectorAll('img')).toHaveLength(2));expect(fetch).toHaveBeenCalledTimes(1);
 // 同じ時刻はキャッシュから出す。時刻が変わったら、近い時刻のコマで代えずに何も出さない（ドラッグ中とは違う）。
 view.rerender(<NativeFilmstrip {...p} held/>);expect(view.container.querySelectorAll('img')).toHaveLength(2);
 view.rerender(<NativeFilmstrip {...p} sourceOffsetFrames={33} held/>);
 await settle(300);expect(fetch).toHaveBeenCalledTimes(1);expect(view.container.querySelectorAll('img')).toHaveLength(0);
});
it('asks again for shown frames that the cache dropped, on the next render',async()=>{
 const fetch=serve(),p=props(),view=render(<NativeFilmstrip {...p}/>),status=()=>view.container.firstElementChild?.getAttribute('data-native-filmstrip');
 await waitFor(()=>expect(status()).toBe('ready'));
 const source={projectId:'p',assetId:'original',streamIndex:2,fingerprint:'a'.repeat(64)};
 await loadThumbs(source,Array.from({length:MAX_CACHED_THUMBS},(_,i)=>r(1000+i)),new AbortController().signal);
 expect(cachedThumb(thumbOwner(source),'52/15')).toBeUndefined();// 存在検査: 表示中のコマが本当に追い出された
 const calls=fetch.mock.calls.length;view.rerender(<NativeFilmstrip {...p}/>);
 await waitFor(()=>expect(status()).toBe('ready'));expect(fetch.mock.calls.length).toBe(calls+1);
 expect([...view.container.querySelectorAll('img')].map(img=>img.getAttribute('data-native-filmstrip-time'))).toEqual(['52/15','67/15']);
});
/** 503・通信エラー・一部欠けを順に返し、尽きたら全部返すサーバ。 */
function flaky(answers:Array<number|'network'|'partial'>){
 const fetch=vi.fn(async(input:string)=>{const times=new URL(input,'http://localhost').searchParams.get('times')!.split(','),next=answers.shift();
  if(next==='network')throw new TypeError('Failed to fetch');
  if(typeof next==='number')return {ok:false,status:next,json:async()=>({error:'混雑しています'})};
  const shown=next==='partial'?times.slice(0,1):times;
  return {ok:true,status:200,json:async()=>({version:1,frames:shown.map((time,frame)=>({time,frame,data:`data:image/jpeg;base64,${frame}`})),failed:times.slice(shown.length).map(time=>({time,error:'混雑'}))})};});
 vi.stubGlobal('fetch',fetch);return fetch;
}
const advance=(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
/** 各待ち時間の直前では呼ばず、ちょうどで呼ぶこと。 */
async function expectWaits(fetch:ReturnType<typeof flaky>,waits:number[]){
 for(const wait of waits){const before=fetch.mock.calls.length;await advance(wait-1);expect(fetch).toHaveBeenCalledTimes(before);await advance(1);expect(fetch).toHaveBeenCalledTimes(before+1);}
}
it('keeps asking with growing waits while the server is busy (503 three times), then draws',async()=>{
 vi.useFakeTimers();const fetch=flaky([503,503,503]),view=render(<NativeFilmstrip {...props()}/>);
 await expectWaits(fetch,[120,1500,3000,6000]);
 expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('ready');expect(view.container.querySelectorAll('img')).toHaveLength(2);
 await advance(30000);expect(fetch).toHaveBeenCalledTimes(4);
});
it('retries a network error and a partly failed answer too, waiting at most 10 seconds between tries',async()=>{
 vi.useFakeTimers();const fetch=flaky(['network',503,503,'partial',503,503]),view=render(<NativeFilmstrip {...props()}/>);
 await expectWaits(fetch,[120,1500,3000,6000,10000,10000,10000]);
 expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('ready');
});
it('stops on a client error (4xx) instead of asking again',async()=>{
 vi.useFakeTimers();const fetch=flaky([400]),view=render(<NativeFilmstrip {...props()}/>);
 await advance(120);expect(fetch).toHaveBeenCalledTimes(1);await advance(60000);expect(fetch).toHaveBeenCalledTimes(1);
 expect(view.container.querySelectorAll('img')).toHaveLength(0);
});
/** 1つの時刻だけ切り出せない（応答はするが failed に入る）サーバ。 */
function brokenAt(key:string){
 const fetch=vi.fn(async(input:string)=>{const times=new URL(input,'http://localhost').searchParams.get('times')!.split(','),shown=times.filter(time=>time!==key);
  return {ok:true,status:200,json:async()=>({version:1,frames:shown.map((time,frame)=>({time,frame,data:`data:image/jpeg;base64,${frame}`})),failed:times.filter(time=>time===key).map(time=>({time,error:'切り出せません'}))})};});
 vi.stubGlobal('fetch',fetch);return fetch;
}
it('asks again at most three times for a frame the server answers but cannot cut, until the view changes',async()=>{
 vi.useFakeTimers();const fetch=brokenAt('67/15'),p=props(),view=render(<NativeFilmstrip {...p}/>);
 await expectWaits(fetch,[120,1500,3000,6000]);
 const asked=()=>fetch.mock.calls.map(([input])=>new URL(input,'http://localhost').searchParams.get('times'));
 expect(asked()).toEqual(['52/15,67/15','67/15','67/15','67/15']);// 存在検査: 欠けたコマだけを取り直している
 await advance(60000);expect(fetch).toHaveBeenCalledTimes(4);expect(view.container.querySelectorAll('img')).toHaveLength(1);
 view.rerender(<NativeFilmstrip {...p} sourceOffsetFrames={33}/>);await advance(120);expect(fetch).toHaveBeenCalledTimes(5);
});
it('keeps retrying a busy server (503) past three times',async()=>{
 vi.useFakeTimers();const fetch=flaky([503,503,503,503,503]),view=render(<NativeFilmstrip {...props()}/>);
 await expectWaits(fetch,[120,1500,3000,6000,10000,10000]);
 expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('ready');
});
/** 最初の count 回は key を混雑（busy）で落とし、その後は全部返すサーバ。 */
function busyAt(key:string,count:number){
 const fetch=vi.fn(async(input:string)=>{const times=new URL(input,'http://localhost').searchParams.get('times')!.split(','),busy=count-->0,shown=busy?times.filter(time=>time!==key):times;
  return {ok:true,status:200,json:async()=>({version:1,frames:shown.map((time,frame)=>({time,frame,data:`data:image/jpeg;base64,${frame}`})),failed:busy?times.filter(time=>time===key).map(time=>({time,error:'混雑',busy:true})):[]})};});
 vi.stubGlobal('fetch',fetch);return fetch;
}
it('keeps retrying frames the server dropped because it was busy, past three times, with growing waits',async()=>{
 vi.useFakeTimers();const fetch=busyAt('67/15',5),view=render(<NativeFilmstrip {...props()}/>);
 await expectWaits(fetch,[120,1500,3000,6000,10000,10000]);
 expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('ready');expect(view.container.querySelectorAll('img')).toHaveLength(2);
});
it('asks again at most three times on another server error (5xx but 503), and again once the document changes',async()=>{
 vi.useFakeTimers();const fetch=flaky(Array(20).fill(500)),p=props(),view=render(<NativeFilmstrip {...p}/>);
 await expectWaits(fetch,[120,1500,3000,6000]);await advance(60000);expect(fetch).toHaveBeenCalledTimes(4);
 view.rerender(<NativeFilmstrip {...p}/>);await advance(60000);expect(fetch).toHaveBeenCalledTimes(4);// 同じ表示・同じ版では取り直さない
 view.rerender(<NativeFilmstrip {...p} document={{...p.document,revision:1}}/>);await expectWaits(fetch,[120,1500,3000,6000]);
 await advance(60000);expect(fetch).toHaveBeenCalledTimes(8);
});
it('a 5xx that clears within three tries draws the frames',async()=>{
 vi.useFakeTimers();const fetch=flaky([500,502]),view=render(<NativeFilmstrip {...props()}/>);
 await expectWaits(fetch,[120,1500,3000]);expect(view.container.firstElementChild?.getAttribute('data-native-filmstrip')).toBe('ready');
});
it('counts a frame the server cannot cut again from zero once the document changes',async()=>{
 vi.useFakeTimers();const fetch=brokenAt('67/15'),p=props(),view=render(<NativeFilmstrip {...p}/>);
 await expectWaits(fetch,[120,1500,3000,6000]);await advance(60000);expect(fetch).toHaveBeenCalledTimes(4);
 view.rerender(<NativeFilmstrip {...p} document={{...p.document,revision:1}}/>);await expectWaits(fetch,[120,1500,3000,6000]);
 await advance(60000);expect(fetch).toHaveBeenCalledTimes(8);
});
