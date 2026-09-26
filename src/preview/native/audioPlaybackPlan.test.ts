import { expect, it } from 'vitest';
import type { SequenceDocument } from '../../core/sequence/model';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { rational as r } from '../../core/sequence/time';
import { audioPlaybackPlan, validatePlaybackRate } from './audioPlaybackPlan';
import { mixAudioBlock, pcmKey, sequenceSampleCount } from './audioMixer';

function document(): SequenceDocument {
  return {schemaVersion:2,id:'shuttle',name:'再生確認',revision:1,fps:r(30),resolution:{width:16,height:16},sequenceEndFrame:90,background:'#000000',
    assets:[{id:'a',kind:'media',name:'音',file:'sound.wav',fingerprint:'fixture',streams:[{index:0,kind:'audio',duration:r(3),codec:'pcm',sampleRate:48000,channels:2}]}],
    tracks:[{id:'audio',kind:'audio',name:'音声',enabled:true}],
    clips:[{id:'c',trackId:'audio',name:'音',startFrame:30,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},
      content:{kind:'audio',assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1),role:'music',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:6,fadeOutFrames:6}}}],
    transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
}

it('keeps the stored/visual plan unchanged and mixes each shuttle at its exact canonical fade frames',()=>{
  const plan=new ScenePlan(document()),before=JSON.stringify(plan.document);
  expect(audioPlaybackPlan(plan,1)).toBe(plan);
  for(const speed of [1,2,4,8]){
    const mix=audioPlaybackPlan(plan,speed),rate=r(speed),sampleRate=48000;
    const pcm={assetId:'a',streamIndex:0,rate,sampleRate,channels:[new Float32Array(144000/speed).fill(1)]};
    const sources=new Map([[pcmKey('a',0,rate),pcm]]);
    expect(sequenceSampleCount(mix,sampleRate)).toBe(144000/speed);
    // Clip starts at 1 s of the timeline. Fade midpoint is frame 33;
    // the monitor reaches these moments speed times sooner, with identical gain.
    const at=(frame:number)=>mixAudioBlock(mix,sources,frame*1600/speed,1)[0][0];
    expect(at(29)).toBe(0);expect(at(30)).toBe(0);expect(at(33)).toBeCloseTo(.5,6);
    // Existing fade-out reaches zero at the last visible frame (59), so its
    // six-frame midpoint is 56, not 57 at the exclusive clip boundary.
    expect(at(40)).toBe(1);expect(at(56)).toBeCloseTo(.5,6);expect(at(60)).toBe(0);
    const full=mixAudioBlock(mix,sources,0,144000/speed);
    const halves=[mixAudioBlock(mix,sources,0,72000/speed),mixAudioBlock(mix,sources,72000/speed,72000/speed)];
    expect([...halves[0]![0],...halves[1]![0]]).toEqual([...full[0]]);
    expect(JSON.stringify(plan.document)).toBe(before);
  }
});

it('requires PCM for the combined source and monitor speed rather than resampling normal PCM',()=>{
  const d=document();if(d.clips[0]!.content.kind==='audio')d.clips[0]!.content.rate=r(3,2);
  const plan=new ScenePlan(d),mix=audioPlaybackPlan(plan,2);
  expect(mix.audibleClips[0]!.content).toMatchObject({rate:r(3)});
  const wrong={assetId:'a',streamIndex:0,rate:r(3,2),sampleRate:48000,channels:[new Float32Array(96000)]};
  expect(()=>mixAudioBlock(mix,new Map([[pcmKey('a',0,r(3,2)),wrong]]),25000,1)).toThrow('音声の準備');
});

it('uses no PCM for reverse and slow shuttles and rejects unsupported monitor speeds',()=>{
  const plan=new ScenePlan(document());
  for(const speed of [-1,-2,-4,-8,.5,-.5]){
    const mix=audioPlaybackPlan(plan,speed);expect(mix.audibleClips).toEqual([]);
    expect([...mixAudioBlock(mix,new Map(),0,10)[0]]).toEqual(Array(10).fill(0));
  }
  // スロー（0.5）は fps を半分にした時計で進む（2 倍が fps を倍にするのと対称）。
  expect(audioPlaybackPlan(plan,.5).document.fps).toEqual(r(15));
  for(const speed of [0,NaN,Infinity,-Infinity,.25,3,16])expect(()=>validatePlaybackRate(speed)).toThrow('再生確認の速度');
});
