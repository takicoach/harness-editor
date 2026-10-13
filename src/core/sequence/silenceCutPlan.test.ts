import {expect,it} from 'vitest';
import {planSilenceRanges,type SourceEnvelope} from './silenceCutPlan';
import {silenceFixture} from './silenceCut.fixture';
import {rational as r} from './time';
import {DEFAULT_SILENCE_SETTINGS as settings} from '../../shared/silenceCut';
const envelope=(id='media',quietStart=2,quietEnd=4):SourceEnvelope=>({assetId:id,streamIndex:0,envelope:{sampleRate:48000,hopSamples:480,windowSamples:960,sampleCount:480000,rms:Float32Array.from({length:1000},(_,i)=>i>=quietStart*100&&i<quietEnd*100?0:.5)}});
it('accepts an imported audio track ending slightly before the video frame boundary',()=>{
  const doc=silenceFixture(12640);doc.fps=r(30000,1001);doc.assets[0]!.streams[0]!.duration=r(18599351,44100);
  if(doc.clips[0]!.content.kind==='audio')doc.clips[0]!.content.endBehavior='silence';
  expect(planSilenceRanges(doc,['speech'],[envelope()],settings)).toEqual([{startFrame:64,endFrame:117}]);
});
it('retains an extended silent-end tail instead of calling missing source samples silence',()=>{
  const doc=silenceFixture(600);doc.assets[0]!.streams[0]!.duration=r(10);
  if(doc.clips[0]!.content.kind==='audio')doc.clips[0]!.content.endBehavior='silence';
  expect(planSilenceRanges(doc,['speech'],[envelope()],settings)).toEqual([{startFrame:64,endFrame:117}]);
});
it('inward rounding protects speech and setting changes reuse the same signal',()=>{
  const doc=silenceFixture(),e=envelope();
  expect(planSilenceRanges(doc,['speech'],[e],settings)).toEqual([{startFrame:64,endFrame:117}]);
  expect(planSilenceRanges(doc,['speech'],[e],{...settings,minSilenceSeconds:3})).toEqual([]);
  expect(e.envelope.rms[250]).toBe(0);
});
it.each([r(30000,1001),r(60000,1001)])('rounds inward once at fractional fps %j and respects the selected scope',fps=>{
  const doc=silenceFixture(280);doc.fps=fps;doc.assets[0]!.streams[0]!.duration=r(10);
  const ranges=planSilenceRanges(doc,['speech'],[envelope()],settings,{startFrame:10,endFrame:220});
  const rate=fps.num/fps.den;
  expect(ranges).toEqual([{startFrame:Math.ceil((2.01+.12)*rate),endFrame:Math.floor(Math.min(3.99*rate,220)-.08*rate)}]);
});
it('does not cut empty timeline gaps, excludes music, and rejects a fully silent output',()=>{
  const doc=silenceFixture(600),clip=doc.clips[0]!;clip.startFrame=150;clip.durationFrames=300;
  expect(planSilenceRanges(doc,['speech'],[envelope()],settings)).toEqual([{startFrame:214,endFrame:267}]);
  if(clip.content.kind==='audio')clip.content.role='music';expect(()=>planSilenceRanges(doc,['speech'],[envelope()],settings)).toThrow(/主音声/);
  const all=envelope();all.envelope.rms.fill(0);expect(()=>planSilenceRanges(silenceFixture(),['speech'],[all],{...settings,beforeSeconds:0,afterSeconds:0})).toThrow(/全体/);
});
it('requires simultaneous silence on both microphones, including overlapping clips',()=>{
  const doc=silenceFixture();doc.assets.push({...structuredClone(doc.assets[0]!),id:'second'});doc.tracks.push({id:'a2',kind:'audio',name:'second',enabled:true});
  const second=structuredClone(doc.clips[0]!);second.id='voice2';second.trackId='a2';if(second.content.kind==='audio')second.content.assetId='second';doc.clips.push(second);
  expect(planSilenceRanges(doc,['speech','a2'],[envelope(),envelope('second',3,5)],settings)).toEqual([{startFrame:94,endFrame:117}]);
  second.trackId='speech';expect(planSilenceRanges(doc,['speech'],[envelope(),envelope('second',3,5)],settings)).toEqual([{startFrame:94,endFrame:117}]);
});
it('projects speed and sourceIn before rounding, and never classifies missing audio as silence',()=>{
  const doc=silenceFixture(120),clip=doc.clips[0]!;doc.assets[0]!.streams[0]!.duration=r(10);
  if(clip.content.kind==='audio'){clip.content.sourceIn=r(1);clip.content.rate=r(2);}
  expect(planSilenceRanges(doc,['speech'],[envelope()],settings)).toEqual([{startFrame:19,endFrame:42}]);
  expect(()=>planSilenceRanges(doc,['speech'],[],settings)).toThrow('未解析');
  expect(()=>planSilenceRanges(doc,['speech'],[envelope()],{...settings,thresholdDb:NaN})).toThrow();
});
