import { expect, it } from 'vitest';
import { ScenePlan } from '../../core/sequence/scenePlan';
import { rational as r } from '../../core/sequence/time';
import type { SequenceDocument } from '../../core/sequence/model';
import { mixAudioBlock, pcmReadRanges, pcmKey, type WindowedPcm, type PreparedPcm } from './audioMixer';

it('windowed reads preserve exact mixing through NTSC boundaries, resampling, offsets and repeated loops', () => {
  const doc: SequenceDocument = { schemaVersion:2,id:'audio-window',name:'音声窓',revision:0,fps:r(30000,1001),resolution:{width:2,height:2},sequenceEndFrame:60,background:'#000000',
    assets:[{id:'audio',kind:'media',name:'原音',file:'source.wav',fingerprint:'fixture',streams:[{index:0,kind:'audio',duration:r(10),codec:'pcm',sampleRate:44100,channels:2}]}],
    tracks:[{id:'a',kind:'audio',name:'音声',enabled:true}],clips:[{id:'clip',trackId:'a',name:'音声',startFrame:1,durationFrames:59,clock:{offset:r(0),rate:r(1),duration:r(59)},
      content:{kind:'audio',assetId:'audio',streamIndex:0,sourceIn:r(7,100),rate:r(3,2),role:'music',loop:true,settings:{gainDb:-3,muted:false,fadeInFrames:4,fadeOutFrames:8}}}],transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'} };
  const key = pcmKey('audio',0,r(3,2)), channels = [Float32Array.from({length:1470},(_,i)=>Math.sin(i*.027)),Float32Array.from({length:1470},(_,i)=>Math.cos(i*.04))];
  const pcm: PreparedPcm = {assetId:'audio',streamIndex:0,rate:r(3,2),sampleRate:44100,channels};
  for (const loop of [true,false]) {
    if(doc.clips[0]!.content.kind==='audio') doc.clips[0]!.content.loop=loop;
    const plan = new ScenePlan(doc), full = new Map([[key,pcm]]);
    for(const start of [0,1601,1684,2300,3999,20000,93000]) {
      const ranges = pcmReadRanges(plan,full,start,4096).get(key) ?? [];
      const window:WindowedPcm = {...pcm,sampleCount:1470,sample(channel,index) {
        expect(ranges.some(range=>range.from<=index && index<range.to)).toBe(true); return channels[channel]![index]!;
      }};
      expect(mixAudioBlock(plan,new Map([[key,window]]),start,4096)).toEqual(mixAudioBlock(plan,full,start,4096));
    }
  }
});
