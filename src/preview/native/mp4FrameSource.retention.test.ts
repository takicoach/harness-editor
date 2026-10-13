import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Mp4FrameSource,nativeDecodeStats,type ByteSource,type FrameRetention} from './mp4FrameSource';
import {rational as r} from '../../core/sequence/time';

// A decoder that withholds every picture until flush, then outputs the whole GOP
// at once: the burst that makes a small decoded-frame cache drop frames it is
// about to be asked for.
interface TestPicture {timestamp:number;codedWidth:number;codedHeight:number;close:ReturnType<typeof vi.fn>;clone():TestPicture}
const decoders:BurstDecoder[]=[],pictures:TestPicture[]=[],sources:Mp4FrameSource[]=[];
function picture(timestamp:number):TestPicture{
  const value={timestamp,codedWidth:2,codedHeight:2,close:vi.fn(),clone:()=>picture(timestamp)};
  pictures.push(value);return value;
}
class BurstDecoder extends EventTarget {
  state='unconfigured';decodeQueueSize=0;buffered:number[]=[];
  constructor(readonly callbacks:VideoDecoderInit){super();decoders.push(this);}
  configure(){this.state='configured';}
  decode(chunk:EncodedVideoChunk){this.buffered.push(chunk.timestamp);queueMicrotask(()=>this.dispatchEvent(new Event('dequeue')));}
  async flush(){for(const timestamp of this.buffered.splice(0))this.callbacks.output(picture(timestamp) as unknown as VideoFrame);}
  close(){this.state='closed';}
}
const FRAME_BYTES=2*2*4;
/** One 9-frame GOP of 2×2 frames (16 bytes each), cache budget of two frames. */
function source(retention:number|FrameRetention={budgetBytes:2*FRAME_BYTES}){
  const samples=Array.from({length:9},(_,i)=>({timestamp:Math.round(i/30*1e6),identity:{sample:i,pts:r(i,30),duration:r(1,30)},sample:{is_sync:i===0,offset:i*4,size:4,duration:1,timescale:30}}));
  const Constructor=Mp4FrameSource as unknown as new(bytes:ByteSource,config:VideoDecoderConfig,samples:unknown[],retention:number|FrameRetention)=>Mp4FrameSource;
  const value=new Constructor({size:36,read:async(start,end)=>new ArrayBuffer(end-start)},{codec:'avc1.42001e'},samples,retention);
  sources.push(value);return value;
}
async function walk(value:Mp4FrameSource){
  for(let i=0;i<9;i++){const result=await value.acquire(r(i,30));expect(result.identity.sample).toBe(i);result.frame.close();}
}
const cached=(value:Mp4FrameSource)=>(value as unknown as {cache:Map<number,unknown>}).cache.size;
beforeEach(()=>{
  decoders.length=pictures.length=0;
  Object.assign(nativeDecodeStats,{retainedFrames:0,retainedBytes:0,maxRetainedFrames:0,maxRetainedBytes:0});
  vi.stubGlobal('VideoDecoder',BurstDecoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(init:EncodedVideoChunkInit){Object.assign(this,init);}});
});
afterEach(()=>{for(const value of sources.splice(0))value.dispose();vi.unstubAllGlobals();});

it('keeps the byte budget alone by default: a burst larger than it is decoded again',async()=>{
  const value=source(2*FRAME_BYTES);await walk(value);
  expect(decoders.length).toBeGreaterThan(1);expect(cached(value)).toBeLessThanOrEqual(2);
  expect(nativeDecodeStats.maxRetainedFrames).toBeLessThanOrEqual(2);
});
it('keeps at least minFrames beyond the byte budget, so the whole burst is served by one decode',async()=>{
  const value=source({budgetBytes:2*FRAME_BYTES,minFrames:9});await walk(value);
  expect(decoders).toHaveLength(1);expect(cached(value)).toBe(9);
  expect(nativeDecodeStats).toMatchObject({retainedFrames:9,retainedBytes:9*FRAME_BYTES,maxRetainedFrames:9,maxRetainedBytes:9*FRAME_BYTES});
});
it('never lets minFrames exceed the per-source byte ceiling',async()=>{
  const value=source({budgetBytes:2*FRAME_BYTES,minFrames:9,maxBytes:4*FRAME_BYTES});await walk(value);
  expect(decoders.length).toBeGreaterThan(1);expect(nativeDecodeStats.maxRetainedFrames).toBe(4);
  expect(cached(value)).toBeLessThanOrEqual(4);
});
it('reports its retained bytes and returns every cached frame and the page totals on dispose',async()=>{
  const value=source({budgetBytes:2*FRAME_BYTES,minFrames:9});await walk(value);
  expect(value.retainedBytes).toBe(9*FRAME_BYTES);
  value.dispose();
  expect(value.retainedBytes).toBe(0);expect(nativeDecodeStats).toMatchObject({retainedFrames:0,retainedBytes:0});
  // Every decoder output is closed exactly once (cached originals here; the clones by walk()).
  for(const frame of pictures)expect(frame.close).toHaveBeenCalledTimes(1);
});
