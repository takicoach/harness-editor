import {expect,it} from 'vitest';
import {applySequenceCommand,type SequenceCommand} from './commands';
import type {SequenceDocument} from './model';
import {ScenePlan} from './scenePlan';
import {rational as r} from './time';
function fixture():SequenceDocument{return {schemaVersion:2,id:'duck',name:'duck',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000',ducking:{enabled:false,strength:'mid'},
  assets:[{id:'source',name:'source',file:'media/audio.wav',kind:'media',fingerprint:'sha',streams:[{index:0,kind:'audio',codec:'pcm_s16le',duration:r(6),sampleRate:48000,channels:2}]}],
  tracks:['speech','music','effect'].map(id=>({id,name:id,kind:'audio',enabled:true})),transitions:[],
  transcripts:[{assetId:'source',streamIndex:0,words:[{id:'word',text:'話す',start:r(1),end:r(2)}]}],
  clips:(['speech','music','effect'] as const).map(role=>({id:role,name:role,trackId:role,startFrame:0,durationFrames:180,clock:{offset:r(0),rate:r(1),duration:r(180)},content:{kind:'audio',role,assetId:'source',streamIndex:0,sourceIn:r(0),rate:r(1),loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}))};}
it('changes only shared ducking settings and evaluates music during and outside speech',()=>{
  const before=fixture(),enabled=applySequenceCommand(before,{type:'set-ducking',patch:{enabled:true}}),strong=applySequenceCommand(enabled,{type:'set-ducking',patch:{strength:'strong'}});
  expect(strong).toEqual({...before,revision:2,ducking:{enabled:true,strength:'strong'}});expect(before.ducking).toEqual({enabled:false,strength:'mid'});
  const plan=new ScenePlan(strong);expect(plan.audioGain(strong.clips[1]!,45)).toBe(.25);expect(plan.audioGain(strong.clips[1]!,0)).toBe(1);
  expect(plan.audioGain(strong.clips[0]!,45)).toBe(1);expect(plan.audioGain(strong.clips[2]!,45)).toBe(1);
  expect(applySequenceCommand(strong,{type:'set-ducking',patch:{strength:'strong'}})).toBe(strong);
});
it('retains archived cuts and timing while changing the project mix',()=>{
  const cut=applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:35,endFrame:40}),after=applySequenceCommand(cut,{type:'set-ducking',patch:{enabled:true,strength:'weak'}});
  expect(after).toEqual({...cut,revision:cut.revision+1,ducking:{enabled:true,strength:'weak'}});
});
it.each([null,[],{enabled:'yes'},{strength:'loud'},{unexpected:true},{strength:undefined}])('rejects invalid direct command patch %j',patch=>{
  const before=fixture();expect(()=>applySequenceCommand(before,{type:'set-ducking',patch} as SequenceCommand)).toThrow();expect(before.revision).toBe(0);
});
