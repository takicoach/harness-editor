import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,readFile,readdir,stat,rm,symlink,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readSequenceWaveform,waveformRequestFromQuery,type WaveformRequest} from './waveform';
import type {PreparedAudioFile} from './media';
import {rational as r} from '../../core/sequence/time';

let directory:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'native-waveform-'));});
afterEach(async()=>{vi.restoreAllMocks();await rm(directory,{recursive:true,force:true});});
async function pcm(samples:Array<[number,number]>,rate=r(1)):Promise<PreparedAudioFile>{
  const data=Buffer.alloc(samples.length*8);samples.forEach(([l,r],i)=>{data.writeFloatLE(l,i*8);data.writeFloatLE(r,i*8+4);});
  const file=join(directory,'audio.f32le');await writeFile(file,data);return {file,sampleCount:samples.length,sampleRate:48000,channels:2,rate};
}
const request=(extra:Partial<WaveformRequest>={}):WaveformRequest=>({assetId:'managed-audio',streamIndex:0,rate:r(1),sourceIn:r(0),fps:r(30),startFrame:0,frameCount:1,clipFrames:1,bins:1,loop:false,...extra});

it('preserves right-only and anti-phase sound, counts silence, and includes pulses at exact bin boundaries',async()=>{
  const data:Array<[number,number]>=Array.from({length:3200},()=>[0,0]);
  data[0]=[.5,0];data[1599]=[0,.75];data[1600]=[1,-1];
  const result=await readSequenceWaveform(await pcm(data),request({frameCount:2,clipFrames:2,bins:2}));
  expect(result.bins).toEqual([{peak:.75,rms:Math.sqrt((.25+.5625)/2/1600),samples:1600},{peak:1,rms:Math.sqrt(1/1600),samples:1600}]);
});

it('maps sourceIn through rational speed and keeps trimmed/split time aligned',async()=>{
  const data:Array<[number,number]>=Array.from({length:6400},()=>[0,0]);data[1600]=[.25,.25];data[3200]=[.5,-.5];
  const source=await pcm(data,r(2));
  const whole=await readSequenceWaveform(source,request({rate:r(2),sourceIn:r(1,15),frameCount:2,clipFrames:2,bins:2}));
  const split=await readSequenceWaveform(source,request({rate:r(2),sourceIn:r(2,15)}));
  expect(whole.bins[0]).toEqual({peak:.25,rms:Math.sqrt(.0625/1600),samples:1600});expect(whole.bins[1]).toEqual(split.bins[0]);
  const fractional=await readSequenceWaveform(source,request({rate:r(2),sourceIn:r(3201,48000),fps:r(240),bins:1}));
  expect(fractional.bins[0]).toEqual({peak:.25,rms:Math.sqrt(.0625/200),samples:200});
});

it('returns silence outside clip bounds and after the source, including RMS silence denominator',async()=>{
  const source=await pcm(Array.from({length:800},()=>[.5,-.5]));
  const result=await readSequenceWaveform(source,request({startFrame:-1,frameCount:3,bins:3}));
  expect(result.bins).toEqual([{peak:0,rms:0,samples:1600},{peak:.5,rms:Math.sqrt(.25/2),samples:1600},{peak:0,rms:0,samples:1600}]);
  expect((await readSequenceWaveform(source,request({sourceIn:r(100)}))).bins[0]).toEqual({peak:0,rms:0,samples:1600});
});

it('wraps at prepared length, combines whole cycles, and accepts enormous exact loop offsets',async()=>{
  const source=await pcm([[1,-1],[0,0],[.5,0]]);
  const result=await readSequenceWaveform(source,request({sourceIn:r(2,48000),fps:r(240),loop:true}));
  // 200 frames starting at index2: [2,0,1] repeats66, followed by [2,0].
  expect(result.bins[0]).toEqual({peak:1,rms:Math.sqrt((67*.125+67)/200),samples:200});
  const huge=await readSequenceWaveform(source,request({sourceIn:r(Number.MAX_SAFE_INTEGER),fps:r(240),loop:true}));
  const offset=Number(BigInt(Number.MAX_SAFE_INTEGER)*48000n%3n);
  let energy=0;for(let i=0;i<200;i++)energy+=[1,0,.125][(offset+i)%3]!;
  expect(huge.bins[0]!.rms).toBe(Math.sqrt(energy/200));
});

it('supports negative provisional source offsets without changing persistent clip validation',async()=>{
  const source=await pcm([[1,-1],[0,0],[.5,0]]);
  const silent=await readSequenceWaveform(source,request({sourceIn:r(-1),fps:r(240)}));expect(silent.bins[0]).toEqual({peak:0,rms:0,samples:200});
  const crossing=await readSequenceWaveform(source,request({sourceIn:r(-1,48000),fps:r(240)}));
  expect(crossing.bins[0]).toEqual({peak:1,rms:Math.sqrt(1.125/200),samples:200});
  const loop=await readSequenceWaveform(source,request({sourceIn:r(-1,48000),fps:r(240),loop:true}));
  expect(loop.bins[0]).toEqual({peak:1,rms:Math.sqrt((67*.125+67)/200),samples:200});
});

it('matches an independent sample scan across raw edges, full index blocks and fractional FPS',async()=>{
  const data:Array<[number,number]>=Array.from({length:12003},(_,i)=>[Math.fround((i%19-9)/10),Math.fround((i%23-11)/12)]);
  const source=await pcm(data),input=request({fps:r(30000,1001),sourceIn:r(1,96000),startFrame:-1,frameCount:15,clipFrames:11,bins:17,loop:true});
  const actual=await readSequenceWaveform(source,input);
  for(let bin=0;bin<17;bin++){
    const a=-1+15*bin/17,b=-1+15*(bin+1)/17;
    const start=Math.floor(.5+a/29.97002997002997*48000),end=Math.floor(.5+b/29.97002997002997*48000);
    const from=Math.floor(.5+Math.max(0,a)/29.97002997002997*48000),to=Math.floor(.5+Math.min(11,b)/29.97002997002997*48000);
    let peak=0,energy=0;for(let sample=from;sample<to;sample++){const [l,r]=data[(sample%data.length+data.length)%data.length]!;peak=Math.max(peak,Math.abs(l),Math.abs(r));energy+=(l*l+r*r)/2;}
    expect(actual.bins[bin]!.samples).toBe(end-start);expect(actual.bins[bin]!.peak).toBe(peak);expect(actual.bins[bin]!.rms).toBeCloseTo(Math.sqrt(energy/(end-start)),12);
  }
});

it('reuses a format/stat keyed index and rebuilds it when the PCM changes',async()=>{
  const source=await pcm(Array.from({length:3200},()=>[.25,.25])),input=request({frameCount:2,clipFrames:2,bins:2});
  await readSequenceWaveform(source,input);const index=source.file+'.waveform-v1',before=await stat(index);
  await readSequenceWaveform(source,input);expect((await stat(index)).mtimeMs).toBe(before.mtimeMs);
  await pcm(Array.from({length:3200},()=>[.75,-.75]));expect((await readSequenceWaveform(source,input)).bins[0]!.peak).toBe(.75);
  expect((await readFile(index)).subarray(0,512).toString()).toContain('waveform-v1');
});

it('shares preparation while one caller cancels and rejects already cancelled requests',async()=>{
  const source=await pcm(Array.from({length:200000},()=>[.25,.5])),input=request({clipFrames:200,frameCount:200});
  const abort=new AbortController(),first=readSequenceWaveform(source,input,abort.signal),second=readSequenceWaveform(source,input);
  const rejection=expect(first).rejects.toBeDefined();abort.abort();await rejection;expect((await second).bins[0]!.peak).toBe(.5);
  const early=new AbortController();early.abort();await expect(readSequenceWaveform(source,input,early.signal)).rejects.toBeDefined();
  expect((await readdir(directory)).some(file=>file.endsWith('.tmp'))).toBe(false);
});

it('bounds every PCM/index read and cancels an in-progress build without publishing a partial cache',async()=>{
  const file=join(directory,'large.f32le'),output=await open(file,'wx');
  const chunk=Buffer.alloc(512*1024);for(let i=0;i<chunk.length;i+=8){chunk.writeFloatLE(.5,i);chunk.writeFloatLE(-.5,i+4);}
  try{for(let i=0;i<32;i++)await output.writeFile(chunk);}finally{await output.close();}
  const source:PreparedAudioFile={file,sampleCount:chunk.length*32/8,sampleRate:48000,channels:2,rate:r(1)};
  const handle=await open(file,'r');
  type Reader={read(buffer:Buffer,offset:number,length:number,position:number):Promise<{bytesRead:number;buffer:Buffer}>};
  const prototype=Object.getPrototypeOf(handle) as Reader,original=prototype.read;await handle.close();
  let largest=0,reads=0;const abort=new AbortController();
  const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:Reader,buffer,offset,length,position){
    largest=Math.max(largest,length);reads++;const result=await original.call(this,buffer,offset,length,position);
    if(reads===1)abort.abort();return result;
  });
  await expect(readSequenceWaveform(source,request({frameCount:1200,clipFrames:1200,bins:2400}),abort.signal)).rejects.toBeDefined();
  await expect.poll(async()=>(await readdir(directory)).filter(name=>name.endsWith('.tmp')).length).toBe(0);
  expect((await readdir(directory)).some(name=>name.endsWith('.waveform-v1'))).toBe(false);
  const result=await readSequenceWaveform(source,request({frameCount:1200,clipFrames:1200,bins:2400}));
  expect(result.bins).toHaveLength(2400);expect(result.bins.every(bin=>bin.peak===.5&&bin.rms===.5)).toBe(true);
  expect(largest).toBeLessThanOrEqual(512*1024);expect(reads).toBeGreaterThan(32);spy.mockRestore();
});

it('bounds request inputs and rejects nonfinite PCM, wrong rates and cache symlinks',async()=>{
  const source=await pcm([[NaN,0]]);await expect(readSequenceWaveform(source,request())).rejects.toThrow('有限');
  await pcm([[1,1]]);await expect(readSequenceWaveform(source,request({bins:2401}))).rejects.toThrow('分割数');
  await expect(readSequenceWaveform(source,request({frameCount:86400*30+1}))).rejects.toThrow('24時間');
  await expect(readSequenceWaveform(source,request({rate:r(2)}))).rejects.toThrow('速度');
  await symlink(source.file,source.file+'.waveform-v1');await expect(readSequenceWaveform(source,request())).rejects.toBeDefined();
  expect(()=>waveformRequestFromQuery(new URLSearchParams('asset=a&stream=0&fpsNum=30&startFrame=0&frameCount=1&clipFrames=1&bins=1&loop=true'))).toThrow('loop');
  expect(()=>waveformRequestFromQuery(new URLSearchParams('asset=a&stream=0&fpsNum=30&startFrame=&frameCount=1&clipFrames=1&bins=1'))).toThrow('整数');
});

it('bounds admission to four active plus sixteen queued requests and lets a queued caller cancel',async()=>{
  const source=await pcm(Array.from({length:3200},()=>[.25,.5])),handle=await open(source.file,'r');
  type Reader={read(buffer:Buffer,offset:number,length:number,position:number):Promise<{bytesRead:number;buffer:Buffer}>};
  const prototype=Object.getPrototypeOf(handle) as Reader,original=prototype.read;await handle.close();
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
  const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:Reader,buffer,offset,length,position){await gate;return original.call(this,buffer,offset,length,position);});
  const abort=new AbortController();
  const responses=Array.from({length:21},(_,i)=>readSequenceWaveform(source,request(),i===10?abort.signal:undefined).then(value=>({ok:true,value}),error=>({ok:false,error})));
  try{
    expect(await responses[20]).toMatchObject({ok:false,error:expect.objectContaining({message:'波形の同時取得上限に達しました'})});
    abort.abort();expect(await responses[10]).toMatchObject({ok:false});
    release();const results=await Promise.all(responses);expect(results.filter(result=>result.ok)).toHaveLength(19);
  }finally{release();await Promise.all(responses);spy.mockRestore();}
});
