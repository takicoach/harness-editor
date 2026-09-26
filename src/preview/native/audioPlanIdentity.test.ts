import { expect, it } from 'vitest';
import type { SequenceDocument } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';
import { audioPlanIdentity } from './audioPlanIdentity';

function document(): SequenceDocument {
  return {schemaVersion:2,id:'audio-identity',name:'identity',revision:1,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000000',
    assets:[{id:'a',kind:'media',name:'音',file:'sound.wav',fingerprint:'original',streams:[{index:0,kind:'audio',duration:r(10),codec:'pcm',sampleRate:48000,channels:2}]}],
    tracks:[{id:'a-track',kind:'audio',name:'音',enabled:true},{id:'v-track',kind:'visual',name:'映像',enabled:true}],
    clips:[{id:'a-clip',trackId:'a-track',name:'音',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},
      content:{kind:'audio',assetId:'a',streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],
    transitions:[{id:'fade',trackId:'a-track',outClipId:'a-clip',kind:'crossfade',startFrame:270,durationFrames:30,audioCurve:'linear'}],
    transcripts:[{assetId:'a',streamIndex:0,words:[{id:'word',text:'声',start:r(1),end:r(2)}]}],ducking:{enabled:true,strength:'mid'}};
}

it('retains audio for visual-only revisions and property reordering without mutating either document',()=>{
  const before=document(),after=structuredClone(before),key=audioPlanIdentity(before);
  after.revision++;after.name='new';after.background='#ffffff';after.resolution={width:1080,height:1920};
  after.tracks[1]!.enabled=false;
  after.assets.push({id:'picture',kind:'image',name:'絵',file:'new.png',fingerprint:'new',streams:[]});
  after.clips.push({id:'caption',trackId:'v-track',name:'文字',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'telop',data:{text:'ドラッグで更新',template:1,animation:'none',position:{x:50,y:20}}}});
  const snapshot=JSON.stringify(after);
  expect(audioPlanIdentity(after)).toBe(key);expect(JSON.stringify(after)).toBe(snapshot);
  after.fps={den:1,num:30};expect(audioPlanIdentity(after)).toBe(key);
});

const changes: [string,(doc:SequenceDocument)=>void][] = [
  ['fps',doc=>{doc.fps=r(60);}], ['end',doc=>{doc.sequenceEndFrame++;}],
  ['timing',doc=>{doc.clips[0]!.startFrame++;}], ['duration',doc=>{doc.clips[0]!.durationFrames--;}],
  ['effect clock',doc=>{doc.clips[0]!.clock.offset=r(1);}],
  ['source clock',doc=>{const c=doc.clips[0]!.content;if(c.kind==='audio')c.sourceIn=r(1);}],
  ['rate',doc=>{const c=doc.clips[0]!.content;if(c.kind==='audio')c.rate=r(2);}],
  ['volume',doc=>{const c=doc.clips[0]!.content;if(c.kind==='audio')c.settings.gainDb=-6;}],
  ['mute',doc=>{const c=doc.clips[0]!.content;if(c.kind==='audio')c.settings.muted=true;}],
  ['fade',doc=>{const c=doc.clips[0]!.content;if(c.kind==='audio')c.settings.fadeInFrames=10;}],
  ['loop',doc=>{const c=doc.clips[0]!.content;if(c.kind==='audio')c.loop=true;}],
  ['role',doc=>{const c=doc.clips[0]!.content;if(c.kind==='audio')c.role='music';}],
  ['track',doc=>{doc.tracks[0]!.enabled=false;}], ['asset',doc=>{doc.assets[0]!.fingerprint='replaced';}],
  ['ducking',doc=>{doc.ducking.strength='strong';}], ['transcript',doc=>{doc.transcripts[0]!.words[0]!.end=r(3);}],
  ['transition',doc=>{doc.transitions[0]!.durationFrames++;}], ['curve',doc=>{doc.transitions[0]!.audioCurve='none';}],
  ['implicit curve',doc=>{delete doc.transitions[0]!.audioCurve;}],
];
it.each(changes)('invalidates the clock when %s changes',(_name,change)=>{
  const before=document(),after=structuredClone(before);change(after);expect(audioPlanIdentity(after)).not.toBe(audioPlanIdentity(before));
});
