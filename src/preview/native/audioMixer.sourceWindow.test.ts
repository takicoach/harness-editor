import {expect,it} from 'vitest';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {mixAudioBlock,pcmReadRanges,type PcmSource} from './audioMixer';

function document():SequenceDocument {
  return {schemaVersion:2,id:'bounded-audio',name:'Source window',revision:0,fps:r(8),resolution:{width:2,height:2},sequenceEndFrame:8,background:'#000000',
    assets:[{id:'media',kind:'media',name:'Original',file:'source.wav',fingerprint:'fixture',streams:[{index:0,kind:'audio',duration:r(2),codec:'pcm',sampleRate:8,channels:1}]}],
    tracks:[{id:'a',kind:'audio',name:'Audio',enabled:true}],clips:[{id:'clip',trackId:'a',name:'Audio',startFrame:0,durationFrames:8,clock:{offset:r(0),rate:r(1),duration:r(8)},content:{kind:'audio',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
}
function bounded() {
  return {kind:'source-window-pcm' as const,assetId:'media',streamIndex:0,rate:r(1),sampleRate:8,channels:[Float32Array.from([11,22,33,444,555])],sourceWindow:{start:r(1,16),end:r(7,16),sampleOrigin:r(1,8)}};
}
it.each([
  {start:0,count:1,expected:[]},
  {start:7,count:1,expected:[]},
  {start:8,count:1,expected:[{from:0,to:1}]},
  {start:0,count:10,expected:[{from:0,to:2}]},
])('plans only available interpolation taps across a stretched fractional origin: %j',({start,count,expected})=>{
  const doc=document(),clip=doc.clips[0]!;
  if(clip.content.kind!=='audio')throw new Error('fixture');
  clip.content.sourceIn=r(1,88200);clip.content.rate=r(1,16);
  const pcm={...bounded(),rate:r(1,16),sampleRate:48000,channels:[new Float32Array(1000).fill(1)],
    sourceWindow:{start:r(1,88200),end:r(1,1000),sampleOrigin:r(1,44100)}};
  const plan=new ScenePlan(doc),ranges=pcmReadRanges(plan,new Map([['@clip:clip',pcm]]),start,count,48000).get('@clip:clip')??[];
  expect(ranges).toEqual(expected);
  const streamed={...pcm,sampleCount:1000,sample(_channel:number,index:number){
    expect(ranges.some(range=>range.from<=index&&index<range.to)).toBe(true);
    return pcm.channels[0]![index]!;
  }};
  const output=mixAudioBlock(plan,new Map([['@clip:clip',pcm]]),start,count,48000);
  expect(mixAudioBlock(plan,new Map([['@clip:clip',streamed]]),start,count,48000)).toEqual(output);
  if(expected.length===0)expect([...output[0]]).toEqual(new Array(count).fill(0));
  if(start===8)expect(output[0][0]).toBeGreaterThan(0);
});
it('uses the explicit clip window, retaining fractional phase and zeroing both interpolation taps outside support',()=>{
  const plan=new ScenePlan(document()),sources=new Map<string,PcmSource>([['@clip:clip',bounded()]]);
  const [left,right]=mixAudioBlock(plan,sources,0,20,32);
  expect([...left]).toEqual([0,0,5.5,8.25,11,13.75,16.5,19.25,22,24.75,27.5,30.25,33,24.75,0,0,0,0,0,0]);
  expect(right).toEqual(left);
});
it('preloads every read tap, never loading the poisoned samples after the allowed source end',()=>{
  const plan=new ScenePlan(document()),pcm=bounded();
  for(const [start,count] of [[0,3],[3,3],[5,8],[12,8],[18,4]]){
    const ranges=pcmReadRanges(plan,new Map([['@clip:clip',pcm]]),start!,count!,32).get('@clip:clip')??[];
    expect(ranges.every(range=>range.from>=0&&range.to<=3)).toBe(true);
    const window={...pcm,sampleCount:5,sample(_channel:number,index:number){expect(ranges.some(range=>range.from<=index&&index<range.to)).toBe(true);return pcm.channels[0]![index]!;}};
    expect(mixAudioBlock(plan,new Map([['@clip:clip',window]]),start!,count!,32)).toEqual(mixAudioBlock(plan,new Map([['@clip:clip',pcm]]),start!,count!,32));
  }
});
it('does not add sourceIn twice and retains the media rate while changing output sample rate',()=>{
  const doc=document(),clip=doc.clips[0]!;clip.startFrame=1;clip.durationFrames=7;
  if(clip.content.kind!=='audio')throw new Error('fixture');clip.content.sourceIn=r(1,4);clip.content.rate=r(2);
  const pcm={...bounded(),rate:r(2),sourceWindow:{start:r(1,4),end:r(3,4),sampleOrigin:r(1,4)}};
  expect([...mixAudioBlock(new ScenePlan(doc),new Map([['@clip:clip',pcm]]),0,10,16)[0]]).toEqual([0,0,11,16.5,22,11,0,0,0,0]);
});
it('uses separate windows for simultaneous occurrences of the same asset and rate',()=>{
  const doc=document(),second=structuredClone(doc.clips[0]!);second.id='other';second.trackId='b';
  if(second.content.kind!=='audio')throw new Error('fixture');second.content.sourceIn=r(1);
  doc.clips.push(second);doc.tracks.push({id:'b',kind:'audio',name:'B',enabled:true});
  const other={...bounded(),channels:[Float32Array.from([77,88,999])],sourceWindow:{start:r(1),end:r(5,4),sampleOrigin:r(1)}};
  expect([...mixAudioBlock(new ScenePlan(doc),new Map([['@clip:clip',bounded()],['@clip:other',other]]),0,5,8)[0]]).toEqual([77,99,22,33,0]);
});
it('rejects DSP shortfall instead of padding missing in-window audio',()=>{
  const plan=new ScenePlan(document()),pcm={...bounded(),channels:[Float32Array.from([11,22])]};
  const sources=new Map([['@clip:clip',pcm]]);
  expect(()=>mixAudioBlock(plan,sources,0,8,8)).toThrow(/不足/);
  expect(()=>pcmReadRanges(plan,sources,0,8,8)).toThrow(/不足/);
});
it('requires an explicit occurrence binding and never shares one bounded window by whole-asset key',()=>{
  const plan=new ScenePlan(document()),sources=new Map([['media:0:1/1',bounded()]]);
  expect(()=>mixAudioBlock(plan,sources,0,8,8)).toThrow(/クリップごと/);
  expect(()=>pcmReadRanges(plan,sources,0,8,8)).toThrow(/クリップごと/);
});
it('rejects bounded looping and identity mismatches while leaving the legacy loop path available',()=>{
  const doc=document(),clip=doc.clips[0]!;
  if(clip.content.kind!=='audio')throw new Error('fixture');clip.content.loop=true;clip.content.role='music';
  const plan=new ScenePlan(doc),sources=new Map([['@clip:clip',bounded()]]);
  expect(()=>mixAudioBlock(plan,sources,0,8,8)).toThrow(/ループ/);
  expect(()=>pcmReadRanges(plan,sources,0,8,8)).toThrow(/ループ/);
  clip.content.loop=false;
  const wrong=new Map([['@clip:clip',{...bounded(),assetId:'unrelated'}]]);
  expect(()=>mixAudioBlock(new ScenePlan(doc),wrong,0,8,8)).toThrow(/形式/);
  expect(()=>pcmReadRanges(new ScenePlan(doc),wrong,0,8,8)).toThrow(/形式/);
});
it.each([
  {start:r(1,16),end:r(1,16),sampleOrigin:r(1,8)},
  {start:r(1,16),end:r(7,16),sampleOrigin:r(0)},
  {start:r(1,16),end:r(7,16),sampleOrigin:r(7,16)},
  {start:r(-1,16),end:r(7,16),sampleOrigin:r(1,8)},
])('rejects inconsistent source window %j',sourceWindow=>{
  expect(()=>mixAudioBlock(new ScenePlan(document()),new Map([['@clip:clip',{...bounded(),sourceWindow}]]),0,8,8)).toThrow(/範囲/);
});
