import {afterEach,expect,it,vi} from 'vitest';
import {ScenePlan} from '../../core/sequence/scenePlan';
import {rational as r} from '../../core/sequence/time';
import {NativeAudioTransport} from './audioTransport';

afterEach(()=>vi.useRealTimers());
const plan=()=>new ScenePlan({schemaVersion:2,id:'presentation',name:'clock',revision:0,fps:r(30),resolution:{width:2,height:2},sequenceEndFrame:60,background:'#000',assets:[],tracks:[],clips:[],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}});
async function running(rate=1){
 vi.useFakeTimers();
 const starts:number[]=[],clock={currentTime:10,sampleRate:48000,destination:{},resume:vi.fn(async()=>{}),
  getOutputTimestamp:vi.fn(()=>({contextTime:10.125,performanceTime:1000})),
  createBuffer:vi.fn((_channels:number,count:number)=>({length:count,copyToChannel:vi.fn()})),
  createBufferSource:vi.fn(()=>({onended:null,connect:vi.fn(),disconnect:vi.fn(),stop:vi.fn(),start:(time:number)=>starts.push(time)}))};
 const transport=new NativeAudioTransport(clock as unknown as AudioContext,plan(),new Map(),vi.fn(),rate);
 transport.seek(48000);await transport.play();clock.currentTime=10.175;
 return {transport,clock,starts};
}

it.each([1,2,4,8,-1,-2,-4,-8])('maps the output clock to RAF for signed rate %s without moving the audio clock',async rate=>{
 const {transport,clock,starts}=await running(rate),audio=transport.currentSample(),scheduled=[...starts];
 // Output at RAF1025 is context10.150: 0.100 seconds after play anchor.
 expect(Math.abs(transport.presentationSample(1025)-(48000+4800*rate))).toBeLessThanOrEqual(1);
 expect(transport.currentSample()).toBe(audio);expect(starts).toEqual(scheduled);
 expect(clock.getOutputTimestamp).toHaveBeenCalledTimes(1);
 // Advance only RAF. The graph clock is still held at10.175.
 expect(Math.abs(transport.presentationSample(1030)-(48000+5040*rate))).toBeLessThanOrEqual(1);
 expect(transport.currentSample()).toBe(audio);transport.dispose();
});

it('keeps uniform RAF presentation increments while the raw clock advances in128-sample quanta',async()=>{
 const {transport,clock}=await running(),raw:number[]=[],video:number[]=[];
 for(let tick=0;tick<=12;tick++){
  const at=10.05+tick/60,raf=1000+tick*1000/60;
  clock.currentTime=Math.floor((at+.02)*48000/128)*128/48000;
  clock.getOutputTimestamp.mockReturnValue({contextTime:at,performanceTime:raf});
  raw.push(transport.currentSample());video.push(transport.presentationSample(raf));
  expect(Math.abs(video[tick]!-(48000+tick*800))).toBeLessThanOrEqual(1);
 }
 const deltas=(values:number[])=>values.slice(1).map((value,i)=>value-values[i]!);
 expect(deltas(raw).some(delta=>Math.abs(delta-800)>20)).toBe(true);
 expect(deltas(video).every(delta=>Math.abs(delta-800)<=1)).toBe(true);transport.dispose();
});

it('uses the raw clock for pause and preserves its paused position',async()=>{
 const {transport,clock}=await running();
 const presentation=transport.presentationSample(1025),audio=transport.currentSample();expect(presentation).not.toBe(audio);
 transport.pause();clock.currentTime=11;clock.getOutputTimestamp.mockClear();
 expect(transport.presentationSample(2000)).toBe(audio);expect(clock.getOutputTimestamp).not.toHaveBeenCalled();
 transport.seek(17);expect(transport.presentationSample(2000)).toBe(17);
 transport.dispose();expect(vi.getTimerCount()).toBe(0);
});

it.each([1,-1])('clamps pre-anchor and terminal presentation for rate %s',async rate=>{
 const {transport,clock}=await running(rate);
 clock.getOutputTimestamp.mockReturnValue({contextTime:10.01,performanceTime:1000});
 expect(transport.presentationSample(1000)).toBe(48000);
 clock.getOutputTimestamp.mockReturnValue({contextTime:20,performanceTime:1000});
 expect(transport.presentationSample(1000)).toBe(rate>0?96000:0);transport.dispose();
});

it.each([
 {name:'zero output pair',stamp:{contextTime:0,performanceTime:0},raf:1025},
 {name:'zero context',stamp:{contextTime:0,performanceTime:1000},raf:1025},
 {name:'negative context',stamp:{contextTime:-1,performanceTime:1000},raf:1025},
 {name:'infinite context',stamp:{contextTime:Infinity,performanceTime:1000},raf:1025},
 {name:'NaN performance',stamp:{contextTime:10.125,performanceTime:NaN},raf:1025},
 {name:'negative performance',stamp:{contextTime:10.125,performanceTime:-1},raf:1025},
 {name:'zero performance',stamp:{contextTime:10.125,performanceTime:0},raf:25},
 {name:'old pair',stamp:{contextTime:10.125,performanceTime:900},raf:1000.1},
 {name:'future pair',stamp:{contextTime:10.125,performanceTime:1100.1},raf:1000},
 {name:'NaN RAF',stamp:{contextTime:10.125,performanceTime:1000},raf:NaN},
 {name:'negative RAF',stamp:{contextTime:10.125,performanceTime:1000},raf:-1},
 {name:'infinite RAF',stamp:{contextTime:10.125,performanceTime:1000},raf:Infinity},
])('falls back to the unchanged audio sample for $name',async({stamp,raf})=>{
 const {transport,clock}=await running();clock.getOutputTimestamp.mockReturnValue(stamp);
 expect(transport.presentationSample(raf)).toBe(transport.currentSample());transport.dispose();
});

it('accepts the100ms boundary and releases presentation history when play resumes',async()=>{
 const {transport,clock}=await running();
 expect(Math.abs(transport.presentationSample(1100)-56400)).toBeLessThanOrEqual(1);
 transport.pause();const paused=transport.currentSample();await transport.play();
 clock.getOutputTimestamp.mockReturnValue({contextTime:10.20,performanceTime:1101});
 // Output is before the new anchor. A previous presentation must not leak in.
 expect(transport.presentationSample(1101)).toBe(paused);transport.dispose();
});

it.each(['missing','throw','undefined'] as const)('falls back when output timestamp is %s',async kind=>{
 const {transport,clock}=await running();
 if(kind==='missing')Object.defineProperty(clock,'getOutputTimestamp',{value:undefined});
 else if(kind==='throw')clock.getOutputTimestamp.mockImplementation(()=>{throw new Error('unsupported');});
 else clock.getOutputTimestamp.mockReturnValue(undefined as never);
 expect(transport.presentationSample(1025)).toBe(transport.currentSample());transport.dispose();
});

it.each(['contextTime','performanceTime'] as const)('falls back for a timestamp without %s',async field=>{
 const {transport,clock}=await running();
 const stamp:Partial<AudioTimestamp>={contextTime:10.125,performanceTime:1000};delete stamp[field];
 clock.getOutputTimestamp.mockReturnValue(stamp as never);
 expect(transport.presentationSample(1025)).toBe(transport.currentSample());transport.dispose();
});

it.each([1,-1])('does not reverse presentation after a stale-output fallback at rate %s',async rate=>{
 const {transport,clock}=await running(rate);
 const first=transport.presentationSample(1025);
 // A delayed callback is beyond the 100ms mapping window. Graph time is
 // about20ms ahead of output; the next valid pair must not move video backward.
 clock.currentTime=10.30;
 const fallback=transport.presentationSample(1120),raw=transport.currentSample();expect(fallback).toBe(raw);
 clock.currentTime=10.31;clock.getOutputTimestamp.mockReturnValue({contextTime:10.28,performanceTime:1121});
 const restored=transport.presentationSample(1121);
 expect(restored).toBe(fallback);expect((restored-first)*rate).toBeGreaterThan(0);
 clock.currentTime=10.35;clock.getOutputTimestamp.mockReturnValue({contextTime:10.33,performanceTime:1171});
 expect((transport.presentationSample(1171)-restored)*rate).toBeGreaterThan(0);
 // An explicit seek starts a new presentation history, in either direction.
 const seek=rate>0?1600:90000;transport.seek(seek);await transport.play();
 clock.getOutputTimestamp.mockReturnValue({contextTime:10.40,performanceTime:1200});
 expect(transport.presentationSample(1200)).toBe(seek);
 transport.dispose();
});
