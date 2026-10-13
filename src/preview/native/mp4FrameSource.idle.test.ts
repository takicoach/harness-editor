import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {DECODE_IDLE_TIMEOUT_MS,Mp4FrameSource,nativeDecodeStats,type ByteSource,type FrameRetention} from './mp4FrameSource';
import {exportRendererOptions} from './exportSourceRelease';
import {rational as r} from '../../core/sequence/time';

// A decoder that outputs each picture as soon as its chunk is decoded, so a session stays
// live (not flushed) between requests: what the idle close acts on.
const decoders:PromptDecoder[]=[],sources:Mp4FrameSource[]=[];
class PromptDecoder extends EventTarget {
  state='unconfigured';decodeQueueSize=0;
  constructor(readonly callbacks:VideoDecoderInit){super();decoders.push(this);}
  configure(){this.state='configured';}
  decode(chunk:EncodedVideoChunk){queueMicrotask(()=>{
    if(this.state==='closed')return;
    this.callbacks.output({timestamp:chunk.timestamp,codedWidth:2,codedHeight:2,close(){},clone(){return this;}} as unknown as VideoFrame);
    this.dispatchEvent(new Event('dequeue'));
  });}
  async flush(){}
  close(){this.state='closed';}
}
function source(retention:FrameRetention){
  const samples=Array.from({length:30},(_,i)=>({timestamp:Math.round(i/30*1e6),identity:{sample:i,pts:r(i,30),duration:r(1,30)},sample:{is_sync:i===0,offset:i*4,size:4,duration:1,timescale:30}}));
  const Constructor=Mp4FrameSource as unknown as new(bytes:ByteSource,config:VideoDecoderConfig,samples:unknown[],retention:FrameRetention)=>Mp4FrameSource;
  const value=new Constructor({size:120,read:async(start,end)=>new ArrayBuffer(end-start)},{codec:'avc1.42001e'},samples,retention);
  sources.push(value);return value;
}
beforeEach(()=>{
  decoders.length=0;nativeDecodeStats.idleCloses=0;
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  vi.stubGlobal('VideoDecoder',PromptDecoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(init:EncodedVideoChunkInit){Object.assign(this,init);}});
});
afterEach(()=>{for(const value of sources.splice(0))value.dispose();vi.unstubAllGlobals();vi.useRealTimers();});
async function take(value:Mp4FrameSource,frame:number){const result=await value.acquire(r(frame,30));expect(result.identity.sample).toBe(frame);result.frame.close();}

it('preview: closes a decoder idle for a second, and the next frame decodes again from the keyframe',async()=>{
  const value=source({});
  await take(value,0);await take(value,1);
  expect(decoders).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(DECODE_IDLE_TIMEOUT_MS+1);
  expect(nativeDecodeStats.idleCloses).toBe(1);expect(decoders[0]!.state).toBe('closed');
  await take(value,2);
  expect(decoders).toHaveLength(2);
});
// A parallel-export worker waits on its full queue for as long as the head block needs: an idle close there
// would bring back decoding from the keyframe (and open-GOP leading pictures) at every resume.
it('export: keeps the decoder open however long the worker waits; sources are released by the export instead',async()=>{
  const value=source(exportRendererOptions(8).retention!);
  await take(value,0);await take(value,1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nativeDecodeStats.idleCloses).toBe(0);expect(decoders[0]!.state).toBe('configured');
  await take(value,2);
  expect(decoders).toHaveLength(1);
  // Disposal (the export's release after the last use, or closing the page) still closes it.
  value.dispose();expect(decoders[0]!.state).toBe('closed');
});
