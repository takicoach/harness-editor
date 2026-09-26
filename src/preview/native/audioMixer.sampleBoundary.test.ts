import {expect,it} from 'vitest';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {audioPlaybackPlan} from './audioPlaybackPlan';
import {mixAudioBlock,pcmKey,type WindowedPcm} from './audioMixer';

function fixture(fpsNum:number,startFrame:number,joined=true) {
  const doc:SequenceDocument={schemaVersion:2,id:'sample-boundary',name:'音のカット',revision:0,fps:r(fpsNum,1001),resolution:{width:2,height:2},sequenceEndFrame:startFrame*2,background:'#000000',
    assets:['left','right'].map(id=>({id,kind:'media',name:id,file:`${id}.wav`,fingerprint:id,streams:[{index:0,kind:'audio',duration:r(10),codec:'pcm',sampleRate:48000,channels:2}]})),
    tracks:[{id:'audio',kind:'audio',name:'原音',enabled:true}],
    clips:[...(joined?[{id:'left',startFrame:0}]:[]),{id:'right',startFrame}].map(({id,startFrame:at})=>({id,trackId:'audio',name:id,startFrame:at,durationFrames:startFrame,clock:{offset:r(0),duration:r(startFrame),rate:r(1)},content:{kind:'audio',assetId:id,streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}})),
    transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
  const sources=(speed:number)=>new Map(['left','right'].map(id=>[pcmKey(id,0,r(speed)),{assetId:id,streamIndex:0,rate:r(speed),sampleRate:48000,sampleCount:480000,sample:()=>id==='left'?.25:.5} satisfies WindowedPcm]));
  return {doc,sources};
}

it.each([[60000,60,1],[30000,30,1],[30000,60,2]])('keeps the first PCM sample across an exact NTSC cut: fps numerator%s/frame%s/shuttle%s',(fps,start,speed)=>{
  const {doc,sources}=fixture(fps,start),plan=audioPlaybackPlan(new ScenePlan(doc),speed);
  // In every case, rational arithmetic places the join at sample48048.
  // The old two floating divisions evaluate its frame just below the right clip.
  const expected=[.25,.5,.5];
  expect([...mixAudioBlock(plan,sources(speed),48047,3)[0]]).toEqual(expected);
  const block=mixAudioBlock(plan,sources(speed),47104,4096)[0];
  expect([...block.slice(943,946)]).toEqual(expected);
  expect(mixAudioBlock(plan,sources(speed),48048,1)[1][0]).toBe(.5);
});

it('keeps silence before a clip and a deliberate fade-in at its first sample',()=>{
  const {doc,sources}=fixture(60000,60,false);let plan=new ScenePlan(doc);
  expect([...mixAudioBlock(plan,sources(1),48047,3)[0]]).toEqual([0,.5,.5]);
  const right=doc.clips[0]!;if(right.content.kind!=='audio')throw new Error('fixture');right.content.settings.fadeInFrames=1;
  plan=new ScenePlan(doc);const faded=mixAudioBlock(plan,sources(1),48047,3)[0];
  expect(faded[0]).toBe(0);expect(faded[1]).toBe(0);expect(faded[2]).toBeGreaterThan(0);expect(faded[2]).toBeLessThan(.001);
});
