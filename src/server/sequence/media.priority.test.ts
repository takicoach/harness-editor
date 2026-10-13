import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const ranks=vi.hoisted(()=>[] as number[]);
vi.mock('./ffmpegGate',async load=>{const actual=await load<typeof import('./ffmpegGate')>();
  return {...actual,withFfmpegSlot:(lane:{rank:number},signal:AbortSignal|undefined,work:()=>Promise<unknown>)=>{ranks.push(lane.rank);return actual.withFfmpegSlot(lane,signal,work);}};});
import {importSequenceAsset} from './assets';
import {prepareSequenceAudio} from './media';
import {rational} from '../../core/sequence/time';
const roots:string[]=[];afterEach(async()=>{ranks.length=0;for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
function wav(){const samples=4000,b=Buffer.alloc(44+samples*2);b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);
  b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);return b;}
it('extracts source PCM through the shared slots at the caller priority (waveform below playback)',async()=>{
  const root=await mkdtemp(join(tmpdir(),'harness-audio-priority-'));roots.push(root);const file=join(root,'source.wav');await writeFile(file,wav());
  const asset=await importSequenceAsset(root,file,'source.wav');
  await prepareSequenceAudio(root,asset,0,rational(1),undefined,'waveform');
  await prepareSequenceAudio(root,asset,0,rational(2));
  expect(ranks).toEqual([1,0]);
},30000);
