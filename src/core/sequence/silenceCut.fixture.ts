import type {SequenceDocument} from './model';
import {rational as r} from './time';

/** Synthetic, owned timeline; never points at a user's project. */
export function silenceFixture(frames=300):SequenceDocument {
  return {schemaVersion:2,id:'silence-fixture',name:'無音カット検証',revision:0,fps:r(30),resolution:{width:320,height:180},
    sequenceEndFrame:frames,background:'#000000',transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},
    assets:[{id:'media',kind:'media',file:'media/synthetic.wav',name:'synthetic',fingerprint:'synthetic',streams:[
      {index:0,kind:'audio',codec:'pcm_s16le',duration:r(frames,30),sampleRate:48000,channels:2}]}],
    tracks:[{id:'speech',kind:'audio',name:'主音声',enabled:true}],
    clips:[{id:'voice',trackId:'speech',name:'トーク',startFrame:0,durationFrames:frames,
      clock:{offset:r(0),rate:r(1),duration:r(frames)},
      content:{kind:'audio',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,
        settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}]};
}
