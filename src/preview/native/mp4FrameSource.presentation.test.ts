import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {rational as r} from '../../core/sequence/time';
import {Mp4FrameSource} from './mp4FrameSource';

const fixture=vi.hoisted(()=>({samples:[] as Array<Record<string,number|boolean>>,edits:[] as Array<Record<string,number>>}));
vi.mock('./videoOnlyMp4Bytes',()=>({videoOnlyMp4Bytes:async(value:unknown)=>value}));
vi.mock('mp4box',()=>({DataStream:class {},createFile:()=>{
  const file={onReady:undefined as undefined|((info:unknown)=>void),onError:undefined,
    appendBuffer:()=>{file.onReady?.({isFragmented:false,videoTracks:[{id:1,codec:'avc1.42001e',video:{width:2,height:2},timescale:600,movie_timescale:600,edits:fixture.edits}]});return 4096;},
    getTrackById:()=>({mdia:{minf:{stbl:{stsd:{entries:[{}]}}}}}),getTrackSamplesInfo:()=>fixture.samples};return file;
}}));
const sources:Mp4FrameSource[]=[],decoded:number[]=[];
class Decoder extends EventTarget {
  static async isConfigSupported(){return {supported:true};}
  state='configured';decodeQueueSize=0;
  constructor(private readonly callbacks:VideoDecoderInit){super();}
  configure(){}
  decode(chunk:EncodedVideoChunk){decoded.push(chunk.timestamp);this.callbacks.output(picture(chunk.timestamp));}
  async flush(){}
  close(){this.state='closed';}
}
function picture(timestamp:number):VideoFrame {
  return {timestamp,codedWidth:2,codedHeight:2,close(){},clone:()=>picture(timestamp)} as VideoFrame;
}
function setSamples(rows:number[][],start=791,duration=11096){
  fixture.samples=rows.map(([cts,dts,length],index)=>({cts:cts!,dts:dts!,duration:length!,timescale:600,offset:index*4,size:4,is_sync:index===0}));
  fixture.edits=[{media_time:start,segment_duration:duration,media_rate_integer:1,media_rate_fraction:0}];
}
async function open(){const value=await Mp4FrameSource.open({size:4096,read:async(start,end)=>new ArrayBuffer(end-start)});sources.push(value);return value;}
async function identity(source:Mp4FrameSource,time:ReturnType<typeof r>){const result=await source.acquire(time);result.frame.close();return result.identity;}
beforeEach(()=>{decoded.length=0;vi.stubGlobal('VideoDecoder',Decoder);vi.stubGlobal('EncodedVideoChunk',class{constructor(init:EncodedVideoChunkInit){Object.assign(this,init);}});});
afterEach(()=>{for(const source of sources.splice(0))source.dispose();vi.unstubAllGlobals();});

// Integers copied from 274/vfr-raw-index.json, not generated from this implementation.
it('keeps preroll available to decode without selecting it over the first displayed B-frame',async()=>{
  setSamples([[771,161,510],[821,791,10],[801,801,10],[791,811,10],[811,821,10]]);
  const source=await open();expect(await identity(source,r(0))).toEqual({sample:3,pts:r(0),duration:r(1,60)});
  expect(await identity(source,r(1,50))).toMatchObject({sample:2});
  expect(decoded).toContain(1285000); // CTS771 remains a codec dependency.
});
it('uses presentation order through the observed frame35 hole without changing decode sample ids',async()=>{
  setSamples([[1312,1262,10],[1272,1272,20],[1262,1292,20],[1292,1312,10],[1322,1322,10]]);
  const source=await open();expect(await identity(source,r(83237,96840))).toEqual({sample:3,pts:r(501,600),duration:r(1,30)});
  expect(await identity(source,r(521,600))).toMatchObject({sample:0});
});
it('clips the final presentation interval to the finite normal edit end',async()=>{
  setSamples([[11861,11851,10],[11851,11861,10],[11881,11871,10],[11871,11881,10]]);
  const source=await open();expect(await identity(source,r(11095,600))).toEqual({sample:2,pts:r(11090,600),duration:r(1,100)});
  await expect(source.acquire(r(11096,600))).rejects.toThrow(/指定時刻/);
  const held=await source.acquire(r(19),true);expect(held.identity.sample).toBe(2);held.frame.close();
});
it('preserves a leading empty edit and a cut through the first presentation interval',async()=>{
  setSamples([[0,0,20],[40,20,20],[20,40,20]],10,40);
  fixture.edits.unshift({media_time:-1,segment_duration:60,media_rate_integer:1,media_rate_fraction:0});
  const source=await open();await expect(source.acquire(r(0))).rejects.toThrow(/指定時刻/);
  expect(await identity(source,r(1,10))).toEqual({sample:0,pts:r(1,10),duration:r(1,60)});
  const frame=await source.acquire(r(1),false,{start:r(61,600),end:r(65,600)});expect(frame.identity.sample).toBe(0);frame.frame.close();
});
it('preserves unedited CFR B-order and a finite final sample',async()=>{
  setSamples([[0,0,20],[60,20,20],[20,40,20],[40,60,20]],0,80);fixture.edits=[];
  const source=await open();expect(await identity(source,r(1,30))).toEqual({sample:2,pts:r(1,30),duration:r(1,30)});
  expect(await identity(source,r(7,60))).toEqual({sample:1,pts:r(1,10),duration:r(1,30)});
  await expect(source.acquire(r(2,15))).rejects.toThrow(/指定時刻/);
});
it('shows the first frame at zero only when its positive start is within one frame',async()=>{
  setSamples([[10,10,10],[20,20,10]],0,30);fixture.edits=[];
  const near=await open();
  expect(await identity(near,r(0))).toEqual({sample:0,pts:r(1,60),duration:r(1,60)});
  expect(await identity(near,r(1,60))).toMatchObject({sample:0});
  setSamples([[60,60,10],[70,70,10]],0,80);fixture.edits=[];
  const delayed=await open();
  await expect(delayed.acquire(r(0))).rejects.toThrow(/指定時刻/);
});
it('keeps 60000/1001 presentation boundaries exact and returns independent identities',async()=>{
  setSamples([[0,0,1001],[3003,1001,1001],[1001,2002,1001],[2002,3003,1001]]);fixture.edits=[];
  for(const sample of fixture.samples)sample.timescale=60000;
  const source=await open();
  expect(await identity(source,r(1001,60000))).toEqual({sample:2,pts:r(1001,60000),duration:r(1001,60000)});
  const snapshot=source.identities;snapshot[1]!.pts.num=0;
  expect(await identity(source,r(2002,60000))).toMatchObject({sample:3,pts:r(1001,30000)});
  await expect(source.acquire(r(4004,60000))).rejects.toThrow(/指定時刻/);
});
it('never extends a short media tail merely because the normal edit is longer',async()=>{
  setSamples([[0,0,20],[20,20,20]],0,600);
  const source=await open();expect(await identity(source,r(39,600))).toMatchObject({sample:1,duration:r(1,30)});
  await expect(source.acquire(r(40,600))).rejects.toThrow(/指定時刻/);
});
it('keeps unsupported complex/rate edits rejected and rejects an empty-only edit',async()=>{
  setSamples([[0,0,20]],0,20);
  fixture.edits[0]!.media_rate_integer=2;await expect(open()).rejects.toThrow(/速度付き/);
  fixture.edits[0]!.media_rate_integer=1;fixture.edits.push({...fixture.edits[0]!});await expect(open()).rejects.toThrow(/複雑/);
  fixture.edits=[{media_time:-1,segment_duration:60,media_rate_integer:1,media_rate_fraction:0}];
  await expect(open()).rejects.toThrow(/表示区間のない/);
});
