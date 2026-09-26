/** @vitest-environment jsdom */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,waitFor} from '@testing-library/react';
import {NativeWaveform} from './NativeWaveform';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {applySequenceCommand} from '../../core/sequence/commands';
import {waveformPresentation,waveformGainAt} from './waveformPresentation';

vi.mock('../layout/useThemeValue',()=>({useThemeValue:()=> 'light'}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
function fixture():SequenceDocument{return {
  schemaVersion:2,id:'wave',name:'wave',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:60,background:'#000000',
  ducking:{enabled:false,strength:'mid'},transitions:[],transcripts:[],tracks:[{id:'a',name:'audio',kind:'audio',enabled:true}],
  assets:[{id:'source',kind:'media',file:'public/source.wav',name:'source',fingerprint:'source',streams:[{index:0,kind:'audio',codec:'pcm',duration:r(60),sampleRate:48000,channels:2}]}],
  clips:[{id:'audio',name:'audio',trackId:'a',startFrame:0,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},
    content:{kind:'audio',assetId:'source',streamIndex:0,rate:r(1),sourceIn:r(0),role:'music',loop:true,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],
};}
function setup(document=fixture()){
  const fillRect=vi.fn();vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({clearRect:vi.fn(),fillRect,fillStyle:''} as unknown as CanvasRenderingContext2D);
  const fetcher=vi.fn(async(input:string)=>{
    const q=new URL(input,'http://localhost').searchParams,n=(key:string)=>Number(q.get(key));
    const request={assetId:q.get('asset'),streamIndex:n('stream'),rate:r(n('rateNum'),n('rateDen')),sourceIn:r(n('sourceInNum'),n('sourceInDen')),fps:r(n('fpsNum'),n('fpsDen')),startFrame:n('startFrame'),frameCount:n('frameCount'),clipFrames:n('clipFrames'),bins:n('bins'),loop:q.get('loop')==='1'};
    return {ok:true,json:async()=>({version:1,precision:'prepared-pcm-sample-floor',sampleRate:48000,sourceSampleCount:192000,request,bins:Array.from({length:request.bins},()=>({peak:.75,rms:.5,samples:24000}))})};
  });vi.stubGlobal('fetch',fetcher);
  const props={projectId:'test',clip:document.clips[0]!,plan:new ScenePlan(document),viewport:{startFrame:0,frameCount:30,left:0,width:60,bins:2},height:20,displayGain:1,sourceOffsetFrames:0,displayDuration:60};
  return {props,fillRect,fetcher};
}
it('accepts an equivalent reduced API response for legal non-reduced rate and fps',async()=>{
  const document=fixture();document.fps={num:60,den:2};const content=document.clips[0]!.content;if(content.kind==='audio')content.rate={num:2,den:2};
  const {props}=setup(document),view=render(<NativeWaveform {...props}/>);
  await waitFor(()=>expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('ready'));
});
it('paints audible loop samples beyond the old clip and document end during an end trim',async()=>{
  const {props,fillRect}=setup();props.displayDuration=90;props.viewport.startFrame=60;
  const view=render(<NativeWaveform {...props}/>);await waitFor(()=>expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('ready'));
  // A .75 peak at unity gain occupies 15 of the 20 canvas pixels, even at local frame 67.5.
  expect(fillRect.mock.calls.some(call=>call[0]===0&&call[3]===15)).toBe(true);
});
it('keeps a derived rational overflow inside the waveform and recovers after cancelling the trim',async()=>{
  const document=fixture(),content=document.clips[0]!.content;if(content.kind==='audio')content.sourceIn=r(1,Number.MAX_SAFE_INTEGER);
  const {props,fetcher}=setup(document);props.sourceOffsetFrames=1;
  const view=render(<NativeWaveform {...props}/>);
  expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('error');expect(fetcher).not.toHaveBeenCalled();
  view.rerender(<NativeWaveform {...props} sourceOffsetFrames={0}/>);
  await waitFor(()=>expect(view.getByRole('img').getAttribute('data-native-waveform')).toBe('ready'));
});
it('projects a start trim with independent source, effect clock and fade expectations',()=>{
  const doc=fixture(),clip=doc.clips[0]!;doc.sequenceEndFrame=120;clip.startFrame=30;clip.durationFrames=90;
  clip.clock={offset:r(7),rate:r(1,2),duration:r(120)};
  if(clip.content.kind!=='audio')throw new Error('audio required');
  clip.content.sourceIn=r(2);clip.content.rate=r(3,2);clip.content.settings={gainDb:-6,muted:false,fadeInFrames:60,fadeOutFrames:20};
  const before=structuredClone(doc),plan=new ScenePlan(doc),viewport={startFrame:0,frameCount:78,left:0,width:156,bins:156};
  const view=waveformPresentation(clip,doc.fps,viewport,12,42,78);expect(view.ok).toBe(true);if(!view.ok)return;
  expect(view.request.sourceIn).toEqual(r(13,5));expect(view.clip.clock).toEqual({offset:r(13),rate:r(1,2),duration:r(120)});
  expect(waveformGainAt(plan,view.clip,10)).toBeCloseTo(10**(-6/20)*18/60,12);
  const committed=applySequenceCommand(doc,{type:'trim',clipId:clip.id,edge:'start',frame:42,linked:false}),committedPlan=new ScenePlan(committed);
  expect(view.clip).toEqual(committed.clips[0]);
  for(const local of [0,10,77.5])expect(waveformGainAt(plan,view.clip,local)).toBe(committedPlan.audioGain(committed.clips[0]!,42+local));
  expect(doc).toEqual(before);
});
it.each(['end','move'] as const)('matches a committed %s beyond the old sequence end while keeping the default mixer boundary',operation=>{
  const doc=fixture(),clip=doc.clips[0]!,plan=new ScenePlan(doc),start=operation==='move'?90:0,duration=operation==='end'?150:60;
  const view=waveformPresentation(clip,doc.fps,{startFrame:0,frameCount:duration,left:0,width:duration*2,bins:duration*2},0,start,duration);
  expect(view.ok).toBe(true);if(!view.ok)return;
  const committed=applySequenceCommand(doc,operation==='end'?{type:'trim',clipId:clip.id,edge:'end',frame:150,linked:false}:{type:'move',clipIds:[clip.id],deltaFrames:90});
  const committedPlan=new ScenePlan(committed);
  expect(view.request.sourceIn).toEqual(r(0));expect(view.clip.clock).toEqual(clip.clock);
  for(const local of [0,30,duration-.5]){
    expect(waveformGainAt(plan,view.clip,local)).toBe(1);
    expect(waveformGainAt(plan,view.clip,local)).toBe(committedPlan.audioGain(committed.clips[0]!,start+local));
  }
  expect(plan.audioGain(view.clip,100)).toBe(0);
});
it('preserves signed source time for a provisional extension before the material start',()=>{
  const doc=fixture(),clip=doc.clips[0]!;clip.startFrame=30;
  const view=waveformPresentation(clip,doc.fps,{startFrame:0,frameCount:90,left:0,width:180,bins:180},-30,0,90);
  expect(view.ok).toBe(true);if(!view.ok)return;
  expect(view.request.sourceIn).toEqual(r(-1));expect(view.clip.clock.offset).toEqual(r(-30));
  expect(waveformGainAt(new ScenePlan({...doc,sequenceEndFrame:90}),view.clip,15)).toBe(1);
});
