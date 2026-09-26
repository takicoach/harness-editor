import {it,expect} from 'vitest';
import {applySequenceCommand} from '../../core/sequence/commands';
import {ScenePlan} from '../../core/sequence/scenePlan';
import type {SequenceDocument} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {mixAudioBlock,pcmReadRanges,pcmKey,type PcmSource} from './audioMixer';
it.each([8,48000])('does not adopt the sixth source frame after own 5fr/r1→r3 rounds to 2fr, at %d Hz',sr=>{
 const doc:SequenceDocument={schemaVersion:2,id:'own-pcm',name:'own',revision:0,fps:r(1),resolution:{width:2,height:2},sequenceEndFrame:5,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
 assets:[{id:'asset',kind:'media',name:'audio',file:'source.wav',fingerprint:'test',streams:[{index:0,kind:'audio',codec:'pcm',sampleRate:sr,channels:1,duration:r(10)}]}],tracks:[{id:'a',kind:'audio',name:'a',enabled:true}],
 clips:[{id:'a',trackId:'a',name:'audio',startFrame:0,durationFrames:5,clock:{offset:r(0),rate:r(1),duration:r(5)},content:{kind:'audio',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1),loop:false,role:'effect',settings:{muted:false,gainDb:0,fadeInFrames:0,fadeOutFrames:0}}}]};
 const registered=applySequenceCommand(doc,{type:'register-native-insert-own-speed',clipId:'a',linked:true});
 const changed=applySequenceCommand(registered,{type:'set-native-insert-own-speed',clipId:'a',linked:true,rate:r(3)}),plan=new ScenePlan(changed);
 const firstOutside=Math.ceil(5/3*sr),reads:number[]=[];
 const pcm:PcmSource={assetId:'asset',streamIndex:0,rate:r(3),sampleRate:sr,sampleCount:sr*4,sample(_ch,index){reads.push(index);return index<firstOutside ? .25 : 99;}};
 const sources=new Map([[pcmKey('asset',0,r(3)),pcm]]),ranges=pcmReadRanges(plan,sources,0,sr*2,sr);
 expect(ranges.values().next().value).toEqual([{from:0,to:firstOutside}]);
 const output=mixAudioBlock(plan,sources,0,sr*2,sr)[0];expect([...output.slice(firstOutside)].every(v=>v===0)).toBe(true);expect(output[0]).toBe(.25);expect(Math.max(...reads.slice(-20))).toBeLessThan(firstOutside);
 expect(reads.every(i=>i<firstOutside)).toBe(true);
 const ordinary=structuredClone(changed);delete ordinary.insertOwnSpeed;delete ordinary.clips[0]!.insertOwnSpeed;
 expect(mixAudioBlock(new ScenePlan(ordinary),sources,0,sr*2,sr)[0][firstOutside]).toBe(99);
 const fractional=structuredClone(doc);if(fractional.clips[0]!.content.kind==='audio')fractional.clips[0]!.content.sourceIn=r(1,7);
 const exactRegistration=applySequenceCommand(fractional,{type:'register-native-insert-own-speed',clipId:'a',linked:true});
 const ramp:PcmSource={assetId:'asset',streamIndex:0,rate:r(1),sampleRate:sr,sampleCount:sr*10,sample(_ch,i){return .2+i/(sr*100);}},rampSources=new Map([[pcmKey('asset',0,r(1)),ramp]]);
 expect(mixAudioBlock(new ScenePlan(exactRegistration),rampSources,0,sr*5,sr)).toEqual(mixAudioBlock(new ScenePlan(fractional),rampSources,0,sr*5,sr));
});
