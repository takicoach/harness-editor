import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { importSequenceAsset } from './assets';
import { prepareSequenceAudio } from './media';
import { writeSequenceAudio } from './exportAudio';
import { ScenePlan } from '../../core/sequence/scenePlan';
import type { SequenceDocument } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';
import { mixAudioBlock, pcmKey, type PreparedPcm } from '../../preview/native/audioMixer';

it('writes exactly the preview PCM with bounded source windows across speed, fades and loops',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-export-audio-')),ffmpeg=resolveFfmpegBin();if(!ffmpeg.ok)throw new Error(ffmpeg.message);
  try {
    const source=join(directory,'tone.wav');execFileSync(ffmpeg.bin,['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2',source]);
    const asset=await importSequenceAsset(directory,source),doc:SequenceDocument={schemaVersion:2,id:'audio',name:'音声比較',revision:0,fps:r(30),resolution:{width:2,height:2},sequenceEndFrame:90,background:'#000000',assets:[asset],
      tracks:[{id:'a',kind:'audio',name:'A',enabled:true},{id:'b',kind:'audio',name:'B',enabled:true}],clips:[r(1),r(3,2)].map((rate,index)=>({id:`clip-${index}`,trackId:index?'b':'a',name:'音楽',startFrame:index*3,durationFrames:90-index*3,
        clock:{offset:r(0),rate:r(1),duration:r(90)},content:{kind:'audio',assetId:asset.id,streamIndex:0,sourceIn:r(1,10),rate,role:'music',loop:true,settings:{gainDb:index?-12:-3,muted:false,fadeInFrames:10,fadeOutFrames:15}}})),transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
    const plan=new ScenePlan(doc),destination=join(directory,'mixed.f32le'),result=await writeSequenceAudio(plan,directory,destination,new AbortController().signal);
    const sources=new Map<string,PreparedPcm>();
    for(const clip of doc.clips) {
      const content=clip.content;if(content.kind!=='audio')throw new Error('fixture');
      const prepared=await prepareSequenceAudio(directory,asset,0,content.rate),data=await readFile(prepared.file),channels=[new Float32Array(prepared.sampleCount),new Float32Array(prepared.sampleCount)];
      for(let i=0;i<prepared.sampleCount;i++)for(let channel=0;channel<2;channel++)channels[channel]![i]=data.readFloatLE(i*8+channel*4);
      sources.set(pcmKey(asset.id,0,content.rate),{assetId:asset.id,streamIndex:0,rate:content.rate,sampleRate:48000,channels});
    }
    const expectedChannels=mixAudioBlock(plan,sources,0,result.sampleCount),expected=Buffer.alloc(result.sampleCount*8);
    for(let i=0;i<result.sampleCount;i++)for(let channel=0;channel<2;channel++)expected.writeFloatLE(expectedChannels[channel]![i]!,i*8+channel*4);
    expect(await readFile(destination)).toEqual(expected);expect(result.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(result.sampleCount).toBe(144000);expect(result.peakWindowBytes).toBeLessThan(100000);
  } finally {await rm(directory,{recursive:true,force:true});}
},20000);
