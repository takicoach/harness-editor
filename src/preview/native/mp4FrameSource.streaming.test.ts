import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DECODE_PROGRESS_TIMEOUT_MS,Mp4FrameSource,type ByteSource} from './mp4FrameSource';
import {rational as r} from '../../core/sequence/time';

type Mode='normal'|'stalled'|'buffered'|'flush-stalled'|'delayed';
let mode:Mode='normal';
interface TestPicture {timestamp:number;codedWidth:number;codedHeight:number;displayWidth:number;displayHeight:number;close:ReturnType<typeof vi.fn>;clone():TestPicture}
const instances:FakeDecoder[]=[],owned:TestPicture[]=[],sources:Mp4FrameSource[]=[];
function picture(timestamp:number):TestPicture{
  const value={timestamp,codedWidth:2,codedHeight:2,displayWidth:2,displayHeight:2,close:vi.fn(),clone:()=>picture(timestamp)};
  owned.push(value);return value;
}
class FakeDecoder extends EventTarget {
  state='unconfigured';decodeQueueSize=0;chunks:number[]=[];buffered:number[]=[];flushes=0;closes=0;
  constructor(readonly callbacks:VideoDecoderInit){super();instances.push(this);}
  configure(){this.state='configured';}
  decode(chunk:EncodedVideoChunk){
    this.chunks.push(chunk.timestamp);this.decodeQueueSize++;
    if(mode==='stalled')return;
    queueMicrotask(()=>{
      this.decodeQueueSize--;
      if(mode==='normal')this.callbacks.output(picture(chunk.timestamp) as unknown as VideoFrame);
      else {
        this.buffered.push(chunk.timestamp);
        if(mode==='delayed'&&this.buffered.length>2)this.callbacks.output(picture(this.buffered.shift()!) as unknown as VideoFrame);
      }
      this.dispatchEvent(new Event('dequeue'));
    });
  }
  async flush(){
    this.flushes++;
    if(mode==='flush-stalled')return new Promise<void>(()=>{});
    for(const timestamp of this.buffered.splice(0))this.callbacks.output(picture(timestamp) as unknown as VideoFrame);
  }
  close(){this.closes++;this.state='closed';}
}
const microtasks=async()=>{for(let i=0;i<16;i++)await Promise.resolve();};
function source(read:ByteSource['read']=async(start,end)=>new ArrayBuffer(end-start),count=9){
  const samples=Array.from({length:count},(_,i)=>({timestamp:Math.round(i/30*1e6),identity:{sample:i,pts:r(i,30),duration:r(1,30)},sample:{is_sync:i%3===0,offset:i*4,size:4,duration:1,timescale:30}}));
  const Constructor=Mp4FrameSource as unknown as new(bytes:ByteSource,config:VideoDecoderConfig,samples:unknown[],budget:number)=>Mp4FrameSource;
  const value=new Constructor({size:count*4,read},{codec:'avc1.42001e'},samples,32);sources.push(value);return value;
}
async function acquire(value:Mp4FrameSource,index:number){const result=await value.acquire(r(index,30));expect(result.frame.timestamp).toBe(Math.round(index/30*1e6));result.frame.close();return result;}
beforeEach(()=>{
  mode='normal';instances.length=owned.length=0;
  vi.stubGlobal('VideoDecoder',FakeDecoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(init:EncodedVideoChunkInit){Object.assign(this,init);}});
});
afterEach(()=>{for(const value of sources.splice(0))value.dispose();vi.useRealTimers();vi.unstubAllGlobals();});

it('continues each compressed GOP once and leaves caller clones independent of decoder disposal',async()=>{
  const value=source(),first=await value.acquire(r(0));
  expect(instances).toHaveLength(1);expect(instances[0]!.state).toBe('configured');
  for(let i=1;i<9;i++)await acquire(value,i);
  expect(instances).toHaveLength(1);expect(instances.flatMap(i=>i.chunks)).toHaveLength(9);
  value.dispose();expect(first.frame.close).not.toHaveBeenCalled();first.frame.close();
  for(const frame of owned)expect(frame.close).toHaveBeenCalledTimes(1);
  for(const decoder of instances)expect(decoder.closes).toBe(1);
});
it('cancels a pending byte read immediately and never creates a decoder from its late result',async()=>{
  let finish!:(value:ArrayBuffer)=>void;
  const value=source(()=>new Promise(resolve=>{finish=resolve;})),work=value.acquire(r(0));
  const rejected=expect(work).rejects.toThrow('閉じ');await microtasks();value.dispose();await rejected;
  finish(new ArrayBuffer(12));await microtasks();expect(instances).toHaveLength(0);
});
it('rejects pending decode work on disposal and closes late output without retaining it',async()=>{
  mode='stalled';const value=source(),work=value.acquire(r(0));const rejected=expect(work).rejects.toThrow('閉じ');
  await microtasks();expect(instances).toHaveLength(1);value.dispose();await rejected;
  const late=picture(0);instances[0]!.callbacks.output(late as unknown as VideoFrame);
  expect(late.close).toHaveBeenCalledTimes(1);expect(instances[0]!.closes).toBe(1);
});
it('bounds an unresponsive decoder and permits a fresh retry after the timeout',async()=>{
  vi.useFakeTimers();mode='stalled';const value=source(),work=value.acquire(r(0));
  const rejected=expect(work).rejects.toThrow('タイムアウト');await microtasks();
  await vi.advanceTimersByTimeAsync(DECODE_PROGRESS_TIMEOUT_MS);await rejected;
  expect(instances[0]!.closes).toBe(1);expect(vi.getTimerCount()).toBe(0);
  mode='normal';await acquire(value,0);expect(instances).toHaveLength(2);
});
it('surfaces an asynchronous decoder failure and recreates the session on retry',async()=>{
  const value=source();await acquire(value,0);const failure=new DOMException('decoder failed');
  instances[0]!.callbacks.error(failure);
  await expect(value.acquire(r(1,30))).rejects.toBe(failure);expect(instances[0]!.closes).toBe(1);
  await acquire(value,1);expect(instances).toHaveLength(2);
});
it('rejects an error arriving with the requested output before the acquire settles',async()=>{
  mode='stalled';const value=source(),work=value.acquire(r(0)),failure=new DOMException('same-task failure');
  const rejected=expect(work).rejects.toBe(failure);await microtasks();
  instances[0]!.callbacks.output(picture(0) as unknown as VideoFrame);instances[0]!.callbacks.error(failure);
  await rejected;expect(instances[0]!.closes).toBe(1);
});
it('restarts from a keyframe for an evicted backward seek and serializes concurrent source requests',async()=>{
  const value=source();for(let i=0;i<6;i++)await acquire(value,i);
  expect(instances).toHaveLength(1);await acquire(value,0);
  await Promise.all([acquire(value,1),acquire(value,2)]);
  expect(instances).toHaveLength(2);expect(instances[1]!.chunks).toEqual([0,33333,66667]);
});
it('flushes a decoder that ignores the latency hint and still returns evicted frames correctly',async()=>{
  mode='buffered';const value=source();for(let i=0;i<3;i++)await acquire(value,i);
  expect(instances).toHaveLength(2);expect(instances.map(i=>i.flushes)).toEqual([1,1]);
});
it('cancels a stalled flush as well as the output/dequeue wait',async()=>{
  mode='flush-stalled';const value=source(),work=value.acquire(r(0));const rejected=expect(work).rejects.toThrow('閉じ');
  // Observe the actual flush boundary; speculative I/O adds promise callbacks.
  await vi.waitFor(()=>expect(instances[0]?.flushes).toBe(1));value.dispose();await rejected;
  expect(instances[0]!.closes).toBe(1);
});
it('releases an idle partial decoder while retaining usable cached frames',async()=>{
  vi.useFakeTimers();const value=source();await acquire(value,0);
  await vi.advanceTimersByTimeAsync(1001);
  expect(instances[0]!.state).toBe('closed');expect(vi.getTimerCount()).toBe(0);
  await acquire(value,0);expect(instances).toHaveLength(1);
  await acquire(value,1);expect(instances).toHaveLength(2);
});
it('closes a fully flushed decoder immediately instead of retaining idle native resources',async()=>{
  vi.useFakeTimers();mode='buffered';const value=source();await acquire(value,0);
  expect(instances[0]!.state).toBe('closed');expect(vi.getTimerCount()).toBe(0);
  await acquire(value,1);expect(instances).toHaveLength(1);
});
it('does not run idle cleanup while the next request is actively waiting for output',async()=>{
  vi.useFakeTimers();const value=source();await acquire(value,0);await vi.advanceTimersByTimeAsync(900);
  mode='stalled';const work=value.acquire(r(1,30)),rejected=expect(work).rejects.toThrow('閉じ');await microtasks();
  await vi.advanceTimersByTimeAsync(1500);expect(instances[0]!.state).toBe('configured');
  value.dispose();await rejected;
});
it('still releases the previous session after rejecting an out-of-range seek',async()=>{
  vi.useFakeTimers();const value=source();await acquire(value,0);
  await expect(value.acquire(r(100))).rejects.toThrow('指定時刻');
  await vi.advanceTimersByTimeAsync(1001);expect(instances[0]!.state).toBe('closed');
});

it('keeps delayed output across GOP boundaries and flushes only at EOF',async()=>{
  mode='delayed';const value=source();
  for(let i=0;i<9;i++)await acquire(value,i);
  expect(instances).toHaveLength(1);expect(instances[0]!.chunks).toHaveLength(9);
  expect(instances[0]!.flushes).toBe(1);expect(instances[0]!.closes).toBe(1);
});
it('bounds rolling timestamp and output history to the current and previous GOP',async()=>{
  const value=source(undefined,300);
  for(let i=0;i<300;i++){
    await acquire(value,i);
    const session=(value as any).session;
    expect(session.byTimestamp.size).toBeLessThanOrEqual(6);
    expect(session.outputSamples.size).toBeLessThanOrEqual(6);
  }
  expect(instances).toHaveLength(1);expect(instances[0]!.chunks).toHaveLength(300);
});
it('rejects a failed next-GOP read and permits a fresh keyframe retry',async()=>{
  let fail=true;
  const value=source(async(start,end)=>{if(start===12&&fail){fail=false;throw new Error('next read failed');}return new ArrayBuffer(end-start);});
  for(let i=0;i<3;i++)await acquire(value,i);
  await expect(value.acquire(r(3,30))).rejects.toThrow('next read failed');
  expect(instances[0]!.closes).toBe(1);
  await acquire(value,3);expect(instances).toHaveLength(2);
});
it('cancels a pending next-GOP read and discards its late result',async()=>{
  let finish!:(value:ArrayBuffer)=>void;let request:AbortSignal|undefined;
  const value=source(async(start,end,signal)=>start===12?new Promise(resolve=>{finish=resolve;request=signal;}):new ArrayBuffer(end-start));
  for(let i=0;i<3;i++)await acquire(value,i);
  const work=value.acquire(r(3,30)),rejected=expect(work).rejects.toThrow('閉じ');
  await microtasks();value.dispose();await rejected;expect(request?.aborted).toBe(true);
  finish(new ArrayBuffer(12));await microtasks();expect(instances).toHaveLength(1);expect(instances[0]!.chunks).toHaveLength(3);
});
it('flushes already submitted frames when an optional next-GOP read fails',async()=>{
  mode='delayed';const value=source(async(start,end)=>{if(start===12)throw new Error('next unavailable');return new ArrayBuffer(end-start);});
  await acquire(value,0);await acquire(value,1);
  expect(instances[0]!.flushes).toBe(1);expect(instances[0]!.closes).toBe(1);
  await expect(value.acquire(r(3,30))).rejects.toThrow('next unavailable');
});
it('returns a delayed requested frame without waiting for an optional read',async()=>{
  mode='delayed';let finish!:(value:ArrayBuffer)=>void;let request:AbortSignal|undefined;
  const value=source(async(start,end,signal)=>start===12?new Promise(resolve=>{finish=resolve;request=signal;}):new ArrayBuffer(end-start));
  await acquire(value,0);let settled=false;
  const work=value.acquire(r(1,30));void work.then(result=>{settled=true;result.frame.close();},()=>{});
  await microtasks();instances[0]!.buffered.shift();instances[0]!.callbacks.output(picture(33333) as unknown as VideoFrame);
  await microtasks();await microtasks();expect(settled).toBe(true);expect(request?.aborted).toBe(true);
  finish(new ArrayBuffer(12));await microtasks();expect(instances[0]!.chunks).toHaveLength(3);
});

it('bounds returned video frames by the explicit cut while allowing required GOP reference decoding',async()=>{
  const value=source(),window={start:r(2,30),end:r(5,30)};
  const tail=await value.acquire(r(8,30),false,window);
  expect(tail.identity.sample).toBe(4);expect(tail.frame.timestamp).toBe(Math.round(4/30*1e6));tail.frame.close();
  const head=await value.acquire(r(0),false,window);
  expect(head.identity.sample).toBe(2);expect(head.frame.timestamp).toBe(Math.round(2/30*1e6));head.frame.close();
  // The ordinary decoder contract remains unbounded when no cut is supplied.
  await acquire(value,8);
});
it('freezes the source-window and time request before it enters the decode queue',async()=>{
  const value=source(),window={start:r(2,30),end:r(5,30)},time=r(8,30);
  const work=value.acquire(time,false,window);
  window.start=r(0);window.end=r(1,30);time.num=0;
  const result=await work;expect(result.identity.sample).toBe(4);result.frame.close();
});
it('recovers after rejecting an empty source window without allocating a decoder for that request',async()=>{
  const value=source();await expect(value.acquire(r(0),true,{start:r(0),end:r(0)})).rejects.toThrow(/素材範囲/);
  expect(instances).toHaveLength(0);await acquire(value,0);
});
it('rejects a hole before a later media sample even when the cut excludes that later sample',async()=>{
  const value=source(undefined,3),samples=(value as any).samples;
  for(const [index,frame] of [[1,2],[2,3]]){
    samples[index!].identity.pts=r(frame!,30);samples[index!].timestamp=Math.round(frame!/30*1e6);
  }
  const time=r(5,120),window={start:r(0),end:r(1,20)};
  await expect(value.acquire(time,true,window)).rejects.toThrow(/指定時刻/);
  expect(instances).toHaveLength(0);
  await expect(value.acquire(time,true)).rejects.toThrow();
  await acquire(value,0);
  const eof=await value.acquire(r(9,60),true,{start:r(0),end:r(1,6)});
  expect(eof.identity.sample).toBe(2);eof.frame.close();
});
it('treats only undefined as an omitted source window and recovers after malformed values',async()=>{
  const value=source();
  for(const invalid of [null,false,0,''])await expect(value.acquire(r(0),true,invalid as any)).rejects.toThrow(/素材範囲/);
  expect(instances).toHaveLength(0);await acquire(value,0);
});

it('prefetches only the next compressed GOP before it is required and consumes that same read',async()=>{
  let ready!:(data:ArrayBuffer)=>void;
  const read=vi.fn<ByteSource['read']>((start,end)=>start===12?new Promise(resolve=>{ready=resolve;}):Promise.resolve(new ArrayBuffer(end-start)));
  const value=source(read,12);await acquire(value,0);await microtasks();
  expect(read.mock.calls.map(([start,end])=>[start,end])).toEqual([[0,12],[12,24]]);
  ready(new ArrayBuffer(12));await microtasks();
  for(let i=1;i<=3;i++)await acquire(value,i);
  expect(read.mock.calls.filter(([start])=>start===12)).toHaveLength(1);
  expect(read.mock.calls.map(([start])=>start)).toEqual([0,12,24]);
});
it('retains an unused speculative failure without failing an earlier frame, then rejects when required',async()=>{
  const failure=new Error('speculative range failed');
  const read=vi.fn<ByteSource['read']>(async(start,end)=>{if(start===12)throw failure;return new ArrayBuffer(end-start);});
  const value=source(read);await acquire(value,0);await microtasks();
  expect(read.mock.calls.some(([start])=>start===12)).toBe(true);
  await acquire(value,1);await acquire(value,2);
  await expect(value.acquire(r(3,30))).rejects.toBe(failure);
  expect(read.mock.calls.filter(([start])=>start===12)).toHaveLength(1);
});
it('aborts an unused next-GOP read on dispose and ignores its late completion',async()=>{
  let finish!:(data:ArrayBuffer)=>void,signal:AbortSignal|undefined;
  const value=source((start,end,request)=>start===12?new Promise(resolve=>{finish=resolve;signal=request;}):Promise.resolve(new ArrayBuffer(end-start)));
  await acquire(value,0);await microtasks();expect(signal).toBeDefined();
  value.dispose();expect(signal!.aborted).toBe(true);
  finish(new ArrayBuffer(12));await microtasks();expect(instances).toHaveLength(1);expect(instances[0]!.chunks).toEqual([0]);
});
it('keeps a late old-session prefetch out of a seek-created session',async()=>{
  let finish!:(data:ArrayBuffer)=>void,signal:AbortSignal|undefined,first=true;
  const read=vi.fn<ByteSource['read']>((start,end,request)=>{
    if(start===12&&first){first=false;return new Promise(resolve=>{finish=resolve;signal=request;});}
    return Promise.resolve(new ArrayBuffer(end-start));
  });
  const value=source(read,12);await acquire(value,0);await microtasks();expect(signal).toBeDefined();
  await acquire(value,6);expect(signal!.aborted).toBe(true);
  finish(new ArrayBuffer(12));await microtasks();await acquire(value,3);
  expect(read.mock.calls.filter(([start])=>start===12)).toHaveLength(2);
  expect(instances).toHaveLength(3);
});
it.each([0,4])('enforces the combined 64MiB compressed budget (extra next bytes=%i)',async extra=>{
  const size=32*1024*1024,read=vi.fn<ByteSource['read']>(async(start,end)=>new ArrayBuffer(end-start));
  const value=source(read,6),samples=(value as any).samples;
  // Sparse byte ranges model two large GOPs without constructing a media file.
  for(let i=0;i<6;i++){samples[i].sample.offset=i<3?i*4:size+(i-3)*4;samples[i].sample.size=i%3===2?size-8+(i===5?extra:0):4;}
  await acquire(value,0);await microtasks();
  expect(read.mock.calls.map(([start,end])=>[start,end])).toEqual(extra===0?[[0,size],[size,2*size]]:[[0,size]]);
});
it('skips an oversized speculative GOP but still rejects it when explicitly required',async()=>{
  const read=vi.fn<ByteSource['read']>(async(start,end)=>new ArrayBuffer(end-start)),value=source(read,6);
  (value as any).samples[5].sample.size=64*1024*1024;
  await acquire(value,0);await microtasks();expect(read.mock.calls.map(([start])=>start)).toEqual([0]);
  await expect(value.acquire(r(3,30))).rejects.toThrow('キーフレーム間隔');
  expect(read).toHaveBeenCalledTimes(1);
});
it('bounds a stalled speculative read once required and aborts its original request on timeout',async()=>{
  vi.useFakeTimers();let signal:AbortSignal|undefined;
  const value=source((start,end,request)=>{if(start===12){signal=request;return new Promise(()=>{});}return Promise.resolve(new ArrayBuffer(end-start));});
  await acquire(value,0);await microtasks();expect(signal).toBeDefined();
  const work=value.acquire(r(3,30)),rejected=expect(work).rejects.toThrow('タイムアウト');await microtasks();
  await vi.advanceTimersByTimeAsync(DECODE_PROGRESS_TIMEOUT_MS);await rejected;
  expect(signal!.aborted).toBe(true);expect(instances[0]!.closes).toBe(1);expect(vi.getTimerCount()).toBe(0);
});
