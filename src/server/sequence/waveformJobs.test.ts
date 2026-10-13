import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {rational as r} from '../../core/sequence/time';
import type {SequenceAsset} from '../../core/sequence/model';
import {FfmpegBusyError} from './ffmpegGate';
const control=vi.hoisted(()=>({prepared:0,priorities:[] as string[],release:undefined as undefined|((value:unknown)=>void),fail:undefined as undefined|((error:Error)=>void)}));
vi.mock('./assets',()=>({verifiedSequenceAssetPath:vi.fn(async()=>'/source')}));
vi.mock('./media',()=>({prepareSequenceAudio:vi.fn((_d:string,_a:unknown,_s:number,_r:unknown,_signal:unknown,priority:string)=>{control.prepared++;control.priorities.push(priority);
  return new Promise((resolve,reject)=>{control.release=resolve;control.fail=reject;});})}));
vi.mock('./waveform',async load=>{const actual=await load<typeof import('./waveform')>();return {...actual,prepareWaveformIndex:vi.fn(async()=>'/index'),
  readSequenceWaveform:vi.fn(async(_pcm:unknown,request:unknown)=>({version:1,precision:'prepared-pcm-sample-floor',sampleRate:48000,sourceSampleCount:48000,request,bins:[{peak:1,rms:.5,samples:1600}]}))};});
import {readSequenceWaveform} from './waveform';
import {forgetWaveformPreparations,respondWaveform,waveformPreparationId,waveformPreparationStatuses,WAVEFORM_FAILED_RETRY_MS} from './waveformJobs';
let directory:string,other:string;
beforeAll(()=>{directory=mkdtempSync(join(tmpdir(),'harness-waveform-jobs-'));other=mkdtempSync(join(tmpdir(),'harness-waveform-other-'));});
afterEach(()=>{forgetWaveformPreparations();control.prepared=0;control.priorities.length=0;});
afterAll(()=>{rmSync(directory,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});});
const asset:SequenceAsset={id:'audio',kind:'media',file:'a.wav',name:'a',fingerprint:'f'.repeat(64),streams:[{index:0,kind:'audio',codec:'pcm',duration:r(10),sampleRate:48000,channels:2}]};
const request={assetId:'audio',streamIndex:0,rate:r(1),sourceIn:r(0),fps:r(30),startFrame:0,frameCount:30,clipFrames:30,bins:1,loop:false};
it('answers "preparing" at once, shares one preparation per source, and serves bins once ready',async()=>{
  const start=performance.now(),first=await respondWaveform(directory,asset,request),second=await respondWaveform(directory,asset,{...request,bins:2});
  expect(performance.now()-start).toBeLessThan(1000);expect(first).toMatchObject({state:'preparing'});expect(second).toMatchObject({state:'preparing'});
  if(first.state!=='preparing')throw new Error();expect(control.prepared).toBe(1);expect(control.priorities).toEqual(['waveform']);
  expect(waveformPreparationStatuses(directory,[first.preparationId])).toEqual({[first.preparationId]:{state:'preparing'}});
  control.release!({file:'/pcm',sampleRate:48000,channels:2,sampleCount:48000,rate:r(1)});await new Promise(resolve=>setTimeout(resolve,0));
  expect(waveformPreparationStatuses(directory,[first.preparationId])).toEqual({[first.preparationId]:{state:'ready'}});
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'ready',bins:[{peak:1}]});
});
it('keeps preparing after the request that started it is cancelled',async()=>{
  const controller=new AbortController(),pending=respondWaveform(directory,asset,request,controller.signal);controller.abort(new Error('閉じた'));
  await expect(pending).rejects.toThrow();
  control.release!({file:'/pcm',sampleRate:48000,channels:2,sampleCount:48000,rate:r(1)});await new Promise(resolve=>setTimeout(resolve,0));
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'ready'});expect(control.prepared).toBe(1);
});
it('reports a failure, and retries only after a pause',async()=>{
  const first=await respondWaveform(directory,asset,request);if(first.state!=='preparing')throw new Error();
  control.fail!(new Error('音声を取り出せません'));await new Promise(resolve=>setTimeout(resolve,0));
  expect(waveformPreparationStatuses(directory,[first.preparationId])).toEqual({[first.preparationId]:{state:'failed',error:'音声を取り出せません'}});
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'failed',error:'音声を取り出せません'});expect(control.prepared).toBe(1);
  const now=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(now+WAVEFORM_FAILED_RETRY_MS+1);
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'preparing'});expect(control.prepared).toBe(2);clock.mockRestore();
});
it('does not tell one project about another project\'s preparation',async()=>{
  const first=await respondWaveform(directory,asset,request);if(first.state!=='preparing')throw new Error();
  expect(waveformPreparationStatuses(other,[first.preparationId,'0'.repeat(32)])).toEqual({[first.preparationId]:{state:'missing'},['0'.repeat(32)]:{state:'missing'}});
});
it('passes a full FFmpeg queue to the caller instead of remembering it as a failure',async()=>{
  const id=waveformPreparationId(directory,asset,0,r(1)),pending=respondWaveform(directory,asset,request);
  await vi.waitFor(()=>expect(control.prepared).toBe(1));control.fail!(new FfmpegBusyError());
  await expect(pending).rejects.toBeInstanceOf(FfmpegBusyError);
  expect(waveformPreparationStatuses(directory,[id])).toEqual({[id]:{state:'missing'}});
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'preparing',preparationId:id});expect(control.prepared).toBe(2);
});
it('forgets a preparation pushed out of the FFmpeg queue after "preparing", so the browser asks again',async()=>{
  const first=await respondWaveform(directory,asset,request);if(first.state!=='preparing')throw new Error();
  control.fail!(new FfmpegBusyError());await new Promise(resolve=>setTimeout(resolve,0));
  expect(waveformPreparationStatuses(directory,[first.preparationId])).toEqual({[first.preparationId]:{state:'missing'}});
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'preparing'});expect(control.prepared).toBe(2);
});
it('prepares again, once, when the prepared PCM vanished from the cache',async()=>{
  const first=await respondWaveform(directory,asset,request);if(first.state!=='preparing')throw new Error();
  control.release!({file:'/pcm',sampleRate:48000,channels:2,sampleCount:48000,rate:r(1)});await new Promise(resolve=>setTimeout(resolve,0));
  vi.mocked(readSequenceWaveform).mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory, lstat '/pcm'"),{code:'ENOENT'}));
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'preparing',preparationId:first.preparationId});expect(control.prepared).toBe(2);
});
it('keeps the shared preparation when only reading the bins fails',async()=>{
  const first=await respondWaveform(directory,asset,request);if(first.state!=='preparing')throw new Error();
  control.release!({file:'/pcm',sampleRate:48000,channels:2,sampleCount:48000,rate:r(1)});await new Promise(resolve=>setTimeout(resolve,0));
  vi.mocked(readSequenceWaveform).mockRejectedValueOnce(new Error('波形の同時取得上限に達しました'));
  await expect(respondWaveform(directory,asset,request)).rejects.toThrow('波形の同時取得上限に達しました');
  expect(waveformPreparationStatuses(directory,[first.preparationId])).toEqual({[first.preparationId]:{state:'ready'}});
  expect(await respondWaveform(directory,asset,request)).toMatchObject({state:'ready'});expect(control.prepared).toBe(1);
});
