import {afterAll,afterEach,beforeAll,describe,expect,expectTypeOf,it,vi} from 'vitest';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fstatSync} from 'node:fs';
import * as assetSources from './assets';
import {registerSequenceReference} from './references';
import {createHash} from 'node:crypto';
import * as media from './media';
import type {SequenceAsset} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {sourceWindowTiming,prepareSequenceSourceWindowAudio as prepare,type SourceWindowAudioRequest,type PreparedSourceWindowAudio} from './sourceWindowAudio';
import {resolveFfmpegBin} from '../resolveFfmpeg';

let dir:string,ffmpeg:string;
const fixtures=new Map<number,{asset:SequenceAsset;raw:Buffer}>();
const window44100:SourceWindowAudioRequest={version:'source-window-v1',start:r(8821,88200),end:r(23521,88200)};
const window48000:SourceWindowAudioRequest={version:'source-window-v1',start:r(1,10),end:r(2,3)};
function execute(args:string[]){execFileSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args]);}
async function wav(raw:Buffer,sr:number,name:string) {
  const rawFile=join(dir,name+'.raw');await writeFile(rawFile,raw);
  execute(['-f','f32le','-ar',String(sr),'-ac','2','-i',rawFile,'-c:a','pcm_f32le',join(dir,name+'.wav')]);
  return media.inspectSequenceAsset(dir,name+'.wav',name);
}
beforeAll(async()=>{
  dir=await mkdtemp(join(tmpdir(),'native-source-window-'));
  const bin=resolveFfmpegBin();if(!bin.ok)throw Error(bin.message);ffmpeg=bin.bin;
  for(const sr of [44100,48000]) {
    const start=sr===44100?4411:4800,end=sr===44100?11761:32000,raw=Buffer.alloc(sr*8);
    for(let i=0;i<sr;i++) {
      raw.writeFloatLE(i>=start&&i<end?0:.75,i*8);
      const value=i===start+123?.875:i===start+2501?-.875:i===end-13?.9375:((i*73%997)/997-.5)*.5;
      raw.writeFloatLE(i>=start&&i<end?value:0,i*8+4);
    }
    fixtures.set(sr,{asset:await wav(raw,sr,'marker-'+sr),raw});
  }
});
afterEach(()=>vi.restoreAllMocks());
afterAll(async()=>{if(dir)await rm(dir,{recursive:true,force:true});});

describe('exact source-window metadata',()=>{
  it('retains the native half-sample origin and phase independently of ideal support',()=>{
    expect(sourceWindowTiming(window44100,44100,r(1))).toMatchObject({firstSourceSample:4411,afterLastSourceSample:11761,sampleOrigin:r(4411,44100),sourcePhase:r(1,88200),
      originOffsetSamples:r(80,147),supportEndSamples:r(8000),rawSupportEndSamples:r(1175920,147),requiredRawSamples:8000});
    expectTypeOf<PreparedSourceWindowAudio>().not.toMatchTypeOf<media.PreparedAudioFile>();
    const fast=sourceWindowTiming(window44100,44100,r(34,25));
    expect(fast.originOffsetSamples).toEqual(r(1000,2499));expect(fast.supportEndSamples).toEqual(r(100000,17));expect(fast.requiredRawSamples).toBe(5882);
    expect(sourceWindowTiming(window48000,48000,r(34,25)).requiredRawSamples).toBe(20000);
    expect(sourceWindowTiming({...window48000,end:r(11,30)},48000,r(16)).requiredRawSamples).toBe(800);
  });
  it.each([
    {...window44100,version:'unknown'}, {...window44100,start:r(-1)}, {...window44100,end:window44100.start},
    {...window44100,end:r(86401)}, {...window44100,start:{num:1,den:0}}, {...window44100,start:r(1,1000000),end:r(2,1000000)},
    {...window44100,loop:true},
  ])('rejects undefined or empty sampling intent %j',request=>{
    expect(()=>sourceWindowTiming(request as SourceWindowAudioRequest,44100,r(1))).toThrow();
  });
  it('rejects invalid rates and unrepresentable phase without rounding it away',()=>{
    expect(()=>sourceWindowTiming(window44100,0,r(1))).toThrow();
    expect(()=>sourceWindowTiming(window44100,44100,r(101))).toThrow();
    expect(()=>sourceWindowTiming(window44100,44100,r(0))).toThrow();
    expect(()=>sourceWindowTiming({...window44100,start:r(1,Number.MAX_SAFE_INTEGER)},44100,r(1))).toThrow(/精度/);
  });
});

describe('actual bounded source DSP',()=>{
  it('isolates integer native-rate boundaries too, without relying on a half-sample special case',async()=>{
    const raw=Buffer.from(fixtures.get(44100)!.raw);
    raw.writeFloatLE(0,4410*8);raw.writeFloatLE(.75,11760*8);
    const asset=await wav(raw,44100,'integer-44100'),result=await prepare(dir,asset,0,r(1),{version:'source-window-v1',start:r(1,10),end:r(4,15)});
    const input=join(dir,'integer-oracle.raw'),output=input+'.pcm';await writeFile(input,raw.subarray(4410*8,11760*8));
    execute(['-f','f32le','-ar','44100','-ac','2','-i',input,'-ar','48000','-f','f32le',output]);
    const actual=await readFile(result.file);expect(actual).toEqual(await readFile(output));
    for(let i=0;i<actual.length;i+=8)expect(actual.readFloatLE(i)).toBe(0);
    expect(result.sourcePhase).toEqual(r(0));expect(result.requiredRawSamples).toBe(8000);
  });
  it.each([r(1),r(34,25),r(25,34)])('isolates native 44.1kHz samples before resampling or tempo at %j',async rate=>{
    const fixture=fixtures.get(44100)!,result=await prepare(dir,fixture.asset,0,rate,window44100),actual=await readFile(result.file);
    // Independent oracle physically slices raw samples before FFmpeg, without production timing/atrim code.
    const input=join(dir,`oracle-${rate.num}-${rate.den}.raw`),output=input+'.pcm';
    await writeFile(input,fixture.raw.subarray(4411*8,11761*8));
    execute(['-f','f32le','-ar','44100','-ac','2','-i',input,...(rate.num===rate.den?[]:['-af',`atempo=${rate.num/rate.den}`]),'-ar','48000','-ac','2','-f','f32le',output]);
    expect(actual).toEqual(await readFile(output)); // Every channel/sample/transient, not just positive energy.
    for(let i=0;i<actual.length;i+=8)expect(actual.readFloatLE(i)).toBe(0);
    expect(actual.length).toBe(result.dspSampleCount*8);
    expect(result.shortfallSamples).toBe(Math.max(0,result.requiredRawSamples-result.dspSampleCount));
    expect(result.excessSamples).toBe(Math.max(0,result.dspSampleCount-result.requiredRawSamples));
    expect(result.assessment.status).toBe(result.shortfallSamples?'insufficient':'unassessed');
  });
  it('preserves every rate1 48kHz allowed sample and each known transient',async()=>{
    const fixture=fixtures.get(48000)!,result=await prepare(dir,fixture.asset,0,r(1),window48000),actual=await readFile(result.file);
    expect(actual).toEqual(fixture.raw.subarray(4800*8,32000*8));
    for(const [at,value] of [[123,.875],[2501,-.875],[27187,.9375]])expect(actual.readFloatLE(at!*8+4)).toBe(value);
    expect(result.assessment).toEqual({status:'unassessed',reason:'quality-not-validated'});
  });
  it('returns the independent 16x short-window deficit without padding or quality success',async()=>{
    // Independent audit: Python random.Random(12345), 12800 stereo f32 samples.
    const raw=await readFile(new URL('./__fixtures__/source-window-short16.f32le',import.meta.url));
    expect(createHash('sha256').update(raw).digest('hex')).toBe('ddf1ee06275302e62f52b0031e022ef2804290cc7bd3e34a461081593cdaaee2');
    const asset=await wav(raw,48000,'short16'),result=await prepare(dir,asset,0,r(16),{version:'source-window-v1',start:r(0),end:r(4,15)});
    const oracle=join(dir,'short16-oracle.pcm');
    execute(['-f','f32le','-ar','48000','-ac','2','-i',join(dir,'short16.raw'),'-af','atempo=2,atempo=2,atempo=2,atempo=2','-f','f32le',oracle]);
    expect(await readFile(result.file)).toEqual(await readFile(oracle));
    expect(result).toMatchObject({requiredRawSamples:800,dspSampleCount:253,shortfallSamples:547,excessSamples:0,assessment:{status:'insufficient',reason:'dsp-shortfall'}});
  });
  it('leaves the old whole-source default, including its cache and PCM, unchanged',async()=>{
    const fixture=fixtures.get(44100)!,old=await media.prepareSequenceAudio(dir,fixture.asset,0,r(1)),before=await readFile(old.file);
    await prepare(dir,fixture.asset,0,r(1),window44100);
    expect(await media.prepareSequenceAudio(dir,fixture.asset,0,r(1))).toEqual(old);expect(await readFile(old.file)).toEqual(before);
    const oracle=join(dir,'whole-source.pcm');execute(['-i',join(dir,'marker-44100.wav'),'-ac','2','-ar','48000','-f','f32le',oracle]);
    expect(before).toEqual(await readFile(oracle));
  });
  it('returns an empty DSP result as insufficient rather than fabricating a playable sample',async()=>{
    const asset=fixtures.get(48000)!.asset,request:SourceWindowAudioRequest={version:'source-window-v1',start:r(0),end:r(1,48000)};
    const result=await prepare(dir,asset,0,r(16),request);
    expect(result).toMatchObject({requiredRawSamples:1,dspSampleCount:0,shortfallSamples:1,assessment:{status:'insufficient'}});
    expect((await readFile(result.file)).length).toBe(0);
    expect(await prepare(dir,asset,0,r(16),request)).toEqual(result);
  });
  it('shares equivalent rationals, separates adjacent/phase windows and invalidates old DSP metadata',async()=>{
    const asset=fixtures.get(48000)!.asset,first=await prepare(dir,asset,0,r(1),{version:'source-window-v1',start:r(0),end:r(1,10)});
    expect(await prepare(dir,asset,0,{num:2,den:2},{version:'source-window-v1',start:{num:0,den:7},end:{num:2,den:20}})).toEqual(first);
    const next=await prepare(dir,asset,0,r(1),{version:'source-window-v1',start:r(1,10),end:r(1,5)});
    const shifted=await prepare(dir,asset,0,r(1),{version:'source-window-v1',start:r(1,96000),end:r(1,10)});
    expect(new Set([first.file,next.file,shifted.file]).size).toBe(3);
    const metadata=JSON.parse(await readFile(next.file+'.json','utf8'));metadata.dspVersion='old-dsp';await writeFile(next.file+'.json',JSON.stringify(metadata));
    const spy=vi.spyOn(media,'run');await prepare(dir,asset,0,r(1),next.request);expect(spy).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(next.file+'.json','utf8')).dspVersion).toBe(next.dspVersion);
    expect(await readFile(first.file)).not.toEqual(await readFile(next.file));
  });
  it('rejects missing stream metadata, EOF overflow and pre-cancelled requests',async()=>{
    const asset=fixtures.get(44100)!.asset;
    await expect(prepare(dir,asset,99,r(1),window44100)).rejects.toThrow(/ストリーム/);
    await expect(prepare(dir,asset,0,r(1),{...window44100,end:r(2)})).rejects.toThrow(/終端/);
    await expect(prepare(dir,{...asset,streams:asset.streams.map(s=>({...s,sampleRate:undefined}))},0,r(1),window44100)).rejects.toThrow(/サンプルレート/);
    const spy=vi.spyOn(media,'run');await expect(prepare(dir,asset,0,r(1),window44100,AbortSignal.abort(Error('stopped')))).rejects.toThrow('stopped');expect(spy).not.toHaveBeenCalled();
  });
});

describe('shared consumers',()=>{
  function controlledRun() {
    const calls:Array<{fd:number;signal:AbortSignal;resolve:()=>Promise<void>}>=[];
    vi.spyOn(media,'run').mockImplementation((_bin,args,signal,fd)=>new Promise((resolve,reject)=>{
      calls.push({fd:fd!,signal:signal!,resolve:async()=>{await writeFile(args.at(-1)!,Buffer.alloc(64));resolve('');}});
      signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});
    }));return calls;
  }
  it('isolates one caller cancellation and does not share mutable metadata',async()=>{
    const external=await mkdtemp(join(dir,'external-'));const project=await mkdtemp(join(dir,'reference-'));await writeFile(join(external,'source.wav'),await readFile(join(dir,'marker-48000.wav')));
    const asset=await registerSequenceReference(project,join(external,'source.wav')),calls=controlledRun(),controller=new AbortController(),request={...window48000,start:r(1,20)};
    const leases:Awaited<ReturnType<typeof assetSources.openSequenceAsset>>[]=[];const original=assetSources.openSequenceAsset;vi.spyOn(assetSources,'openSequenceAsset').mockImplementation(async(...args)=>{const lease=await original(...args);leases.push(lease);return lease;});
    const a=prepare(project,asset,0,r(7),request,controller.signal),b=prepare(project,asset,0,r(7),request),rejection=expect(a).rejects.toThrow('one cancelled');
    await vi.waitFor(()=>expect(calls).toHaveLength(1));controller.abort(Error('one cancelled'));await rejection;
    expect(calls[0]!.signal.aborted).toBe(false);expect(fstatSync(calls[0]!.fd).isFile()).toBe(true);await calls[0]!.resolve();const result=await b;result.request.start.num=123;
    expect((await prepare(project,asset,0,r(7),request)).request.start).toEqual(r(1,20));
    await vi.waitFor(()=>expect(leases.every(lease=>lease.handle.fd===-1)).toBe(true));
  });
  it('rejects a same-size source change during reference decoding and publishes no PCM',async()=>{
    const project=await mkdtemp(join(dir,'changed-project-')),external=await mkdtemp(join(dir,'changed-external-')),path=join(external,'source.wav');
    const bytes=await readFile(join(dir,'marker-48000.wav'));await writeFile(path,bytes);
    const asset=await registerSequenceReference(project,path),calls=controlledRun();
    const task=prepare(project,asset,0,r(3),window48000),failure=expect(task).rejects.toThrow();
    await vi.waitFor(()=>expect(calls).toHaveLength(1));bytes[bytes.length-10]=bytes[bytes.length-10]!^1;await writeFile(path,bytes);await calls[0]!.resolve();await failure;
    expect(await readdir(join(project,'.harness/cache/source-window-audio'))).toEqual([]);
    await vi.waitFor(()=>expect(()=>fstatSync(calls[0]!.fd)).toThrow());
  });
  it('cancels abandoned work, retries and removes temporary cache files',async()=>{
    const asset=fixtures.get(48000)!.asset,calls=controlledRun(),controller=new AbortController(),request={...window48000,start:r(1,19)};
    const first=prepare(dir,asset,0,r(9),request,controller.signal),failure=expect(first).rejects.toThrow('all cancelled');
    await vi.waitFor(()=>expect(calls).toHaveLength(1));controller.abort(Error('all cancelled'));await failure;expect(calls[0]!.signal.aborted).toBe(true);
    await vi.waitFor(()=>expect(()=>fstatSync(calls[0]!.fd)).toThrow());
    const second=prepare(dir,asset,0,r(9),request);await vi.waitFor(()=>expect(calls).toHaveLength(2));await calls[1]!.resolve();const result=await second;
    await vi.waitFor(async()=>expect((await readdir(dirname(result.file))).filter(p=>p.endsWith('.tmp')||p.endsWith('.tmp.json'))).toEqual([]));
  });
});
