import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {Mp4FrameSource,type ByteSource} from './mp4FrameSource';
import {rational as r} from '../../core/sequence/time';

// Open GOP (HEVC CRA + RASL): a leading picture follows its keyframe in decode order but is
// shown before it, and references the previous GOP. A decoder that starts at that keyframe
// drops it, as Chromium does. The real
// decoder and pixels are covered by mp4FrameSource.openGop.e2e.test.ts.
const decoders:RaslDecoder[]=[],sources:Mp4FrameSource[]=[];
function picture(timestamp:number){return {timestamp,codedWidth:2,codedHeight:2,close(){},clone:()=>picture(timestamp)};}
class RaslDecoder extends EventTarget {
  state='unconfigured';decodeQueueSize=0;chunks:number[]=[];keys=0;lastKey=-1;
  constructor(readonly callbacks:VideoDecoderInit){super();decoders.push(this);}
  configure(){this.state='configured';}
  decode(chunk:EncodedVideoChunk){
    this.chunks.push(chunk.timestamp);
    if(chunk.type==='key'){this.keys++;this.lastKey=chunk.timestamp;}
    // A leading picture of the first keyframe this decoder saw has no reference: dropped.
    const dropped=chunk.type==='delta'&&this.keys===1&&chunk.timestamp<this.lastKey;
    this.decodeQueueSize++;
    queueMicrotask(()=>{
      this.decodeQueueSize--;
      if(!dropped)this.callbacks.output(picture(chunk.timestamp) as unknown as VideoFrame);
      this.dispatchEvent(new Event('dequeue'));
    });
  }
  async flush(){}
  close(){this.state='closed';}
}
const MiB=1024*1024;
/** Decode-order rows of [presentation index, keyframe]; 30 fps. */
function source(rows:Array<[number,boolean]>,sampleBytes=4,reads:Array<[number,number]>=[]){
  const samples=rows.map(([pts,key],i)=>({timestamp:Math.round(pts/30*1e6),identity:{sample:i,pts:r(pts,30),duration:r(1,30)},
    sample:{is_sync:key,offset:i*sampleBytes,size:sampleBytes,duration:1,timescale:30}}));
  const read:ByteSource['read']=async(start,end)=>{reads.push([start,end]);return new ArrayBuffer(end-start);};
  const Constructor=Mp4FrameSource as unknown as new(bytes:ByteSource,config:VideoDecoderConfig,samples:unknown[],budget:number)=>Mp4FrameSource;
  const value=new Constructor({size:rows.length*sampleBytes,read},{codec:'hvc1.1.6.L93.B0'},samples,64*MiB);sources.push(value);return value;
}
// GOPs start at decode 0 (pts 0), 3 (pts 4) and 7 (pts 8); decode 4 (pts 3) and 8 (pts 7) are leading.
const OPEN:Array<[number,boolean]>=[[0,true],[2,false],[1,false],[4,true],[3,false],[6,false],[5,false],[8,true],[7,false],[9,false]];
const decodeIndex=(rows:Array<[number,boolean]>,pts:number)=>rows.findIndex(([value])=>value===pts);
const firstChunk=()=>decoders.at(-1)!.chunks[0];
const us=(pts:number)=>Math.round(pts/30*1e6);

beforeEach(()=>{
  decoders.length=0;
  vi.stubGlobal('VideoDecoder',RaslDecoder);
  vi.stubGlobal('EncodedVideoChunk',class {constructor(init:EncodedVideoChunkInit){Object.assign(this,init);}});
});
afterEach(()=>{for(const value of sources.splice(0))value.dispose();vi.unstubAllGlobals();});

it('decodes a leading picture on a fresh source from the keyframe before its own',async()=>{
  for(const [pts,previousKey] of [[3,0],[7,4]] as const){
    const value=source(OPEN),result=await value.acquire(r(pts,30));
    expect(result.identity.sample).toBe(decodeIndex(OPEN,pts));expect(result.frame.timestamp).toBe(us(pts));result.frame.close();
    expect(firstChunk()).toBe(us(previousKey));
  }
});
it('still starts every other frame of an open-GOP source at its own keyframe',async()=>{
  for(const [pts,key] of [[0,0],[1,0],[2,0],[4,4],[5,4],[6,4],[8,8],[9,8]] as const){
    const value=source(OPEN),result=await value.acquire(r(pts,30));
    expect(result.identity.sample).toBe(decodeIndex(OPEN,pts));result.frame.close();
    expect(firstChunk()).toBe(us(key));
  }
});
it('serves an open-GOP source in order with one decoder and one pass over the samples',async()=>{
  const value=source(OPEN);
  for(let pts=0;pts<10;pts++){const result=await value.acquire(r(pts,30));expect(result.identity.sample).toBe(decodeIndex(OPEN,pts));result.frame.close();}
  expect(decoders).toHaveLength(1);expect(decoders[0]!.chunks).toHaveLength(10);
});
it('reads and decodes a closed-GOP source exactly as before: one GOP from the own keyframe',async()=>{
  // No leading pictures: everything after a keyframe in decode order is shown after it.
  const CLOSED:Array<[number,boolean]>=[[0,true],[2,false],[1,false],[3,true],[5,false],[4,false],[6,true],[8,false],[7,false]];
  const keys=[0,3,6];
  for(let pts=0;pts<9;pts++){
    const reads:Array<[number,number]>=[],value=source(CLOSED,4,reads),result=await value.acquire(r(pts,30));
    expect(result.identity.sample).toBe(decodeIndex(CLOSED,pts));result.frame.close();
    const key=[...keys].reverse().find(index=>index<=decodeIndex(CLOSED,pts))!;
    expect(firstChunk()).toBe(us(CLOSED[key]![0]));
    // The required read is the own GOP only (a following prefetch may add the next one).
    expect(reads[0]).toEqual([key*4,(keys.find(index=>index>key)??CLOSED.length)*4]);
  }
});
it('keeps the compressed-read limit over both GOPs and stays usable after refusing',async()=>{
  // 10 MiB samples: GOP 0 = 30 MiB, GOP 1 = 40 MiB. A leading picture of GOP 1 needs 70 MiB.
  const reads:Array<[number,number]>=[],value=source(OPEN,10*MiB,reads);
  await expect(value.acquire(r(3,30))).rejects.toThrow('映像のキーフレーム間隔が大きすぎます。プロキシを作成してください');
  expect(reads).toEqual([]);
  const result=await value.acquire(r(5,30));expect(result.identity.sample).toBe(decodeIndex(OPEN,5));result.frame.close();
  expect(reads[0]).toEqual([3*10*MiB,7*10*MiB]);
});
