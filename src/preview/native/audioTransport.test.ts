import { afterEach, expect, it, vi } from 'vitest';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { rational as r } from '../../core/sequence/time';
import { NativeAudioTransport } from './audioTransport';

afterEach(()=>vi.useRealTimers());
const plan=()=>new ScenePlan({schemaVersion:2,id:'clock',name:'時計',revision:0,fps:r(30),resolution:{width:2,height:2},sequenceEndFrame:60,background:'#000000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}});
function context(){
  const starts:number[]=[],stops=vi.fn();
  const value={currentTime:10,sampleRate:48000,destination:{},resume:vi.fn(async()=>{}),
    createBuffer:vi.fn((_channels:number,count:number)=>({length:count,copyToChannel:vi.fn()})),
    createBufferSource:vi.fn(()=>({buffer:null,onended:null,connect:vi.fn(),disconnect:vi.fn(),stop:stops,start:(at:number)=>starts.push(at)}))};
  return {value,starts,stops,audio:value as unknown as AudioContext};
}

it.each([1,2,4,8,-1,-2,-4,-8])('uses the signed %sx clock and stops exactly at its direction boundary',async rate=>{
  vi.useFakeTimers();const ctx=context(),onError=vi.fn(),transport=new NativeAudioTransport(ctx.audio,plan(),new Map(),onError,rate);
  transport.seek(48000);await transport.play();
  expect(transport.currentSample()).toBe(48000);expect(transport.isPlaying).toBe(true);
  ctx.value.currentTime=10.175;
  expect(Math.abs(transport.currentSample()-(48000+6000*rate))).toBeLessThanOrEqual(1);
  if(rate<0)expect(ctx.value.createBufferSource).not.toHaveBeenCalled();
  ctx.value.currentTime=12.05;vi.advanceTimersByTime(25);
  expect(transport.currentSample()).toBe(rate>0?96000:0);expect(transport.isPlaying).toBe(false);
  expect(onError).not.toHaveBeenCalled();transport.dispose();
});

it('cancels pending resume and never schedules pre-seek audio at a fractional shuttle sample',async()=>{
  vi.useFakeTimers();const ctx=context();let release!:()=>void;
  ctx.value.resume.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
  const transport=new NativeAudioTransport(ctx.audio,plan(),new Map(),vi.fn(),8);
  transport.seek(1601);const pending=transport.play();transport.pause();release();await pending;
  expect(transport.isPlaying).toBe(false);expect(ctx.starts).toEqual([]);
  await transport.play();expect(ctx.starts[0]).toBeGreaterThanOrEqual(10.05);
  expect(ctx.starts[0]!-10.05).toBeLessThanOrEqual(1/48000);
  ctx.value.currentTime=10.15;transport.pause();const frame=transport.currentSample();
  ctx.value.currentTime=11;expect(transport.currentSample()).toBe(frame);
  expect(ctx.stops).toHaveBeenCalled();transport.dispose();expect(vi.getTimerCount()).toBe(0);
});
