import {expect,it} from 'vitest';
import {speechDocument} from './__fixtures__/audioFixFixture';
import type {SequenceDocument} from '../../core/sequence/model';
import {audioFixCandidates,audioFixLabels,audioFixRoot} from './audioFixTarget';

const multi=():SequenceDocument=>{const d=speechDocument({applied:['denoise']}),speech=d.clips[0]!;
  return {...d,tracks:[{id:'a-main',kind:'audio',name:'原音1',enabled:true}],assets:[...d.assets,{...d.assets[0]!,id:'second',name:'second.mp4',fingerprint:'9'.repeat(64)}],
    clips:[{...speech,trackId:'a-main'},{...structuredClone(speech),id:'speech-2',trackId:'a-main',startFrame:300,content:{...(speech.content as Extract<typeof speech.content,{kind:'audio'}>),assetId:'second'}}]};};
it('offers only the first speech source when there is one (unchanged)',()=>{
  expect(audioFixCandidates(speechDocument()).map(c=>c.rootId)).toEqual(['source']);
});
it('offers each main speech source once, by its original asset',()=>{
  expect(audioFixRoot(multi(),'source-denoise')).toBe('source');
  expect(audioFixCandidates(multi()).map(c=>[c.rootId,c.clip.id])).toEqual([['source','speech'],['second','speech-2']]);
});
const fixed=(id:string,from:string)=>({...speechDocument().assets[0]!,id,name:`${id}.mp4`,fingerprint:id.padStart(64,'f'),origin:{kind:'audio-fix' as const,from,fix:'denoise' as const}});
it('stops on a cyclic, self-referencing or broken fix history and keeps the asset itself',()=>{
  const base=speechDocument(),doc={...base,assets:[...base.assets,fixed('a','b'),fixed('b','a'),fixed('self','self'),fixed('broken','gone')]};
  expect(audioFixRoot(doc,'a')).toBe('a');
  expect(audioFixRoot(doc,'self')).toBe('self');
  expect(audioFixRoot(doc,'broken')).toBe('broken');
  expect(audioFixRoot(doc,'unknown')).toBe('unknown');
});
/** 最初の原音がメイン外（B ロール）で、同じ原本がメインにもある。 */
const offMainFirst=():SequenceDocument=>{const d=multi(),speech=d.clips[0]!;
  return {...d,tracks:[{id:'b-roll',kind:'audio',name:'Bロール',enabled:true},...d.tracks],clips:[{...structuredClone(speech),id:'broll',trackId:'b-roll'},...d.clips]};};
it('keeps the same original on another track as its own choice (track + original)',()=>{
  expect(audioFixCandidates(offMainFirst()).map(c=>[c.clip.trackId,c.rootId,c.clip.id])).toEqual([['b-roll','source','broll'],['a-main','source','speech'],['a-main','second','speech-2']]);
});
it('labels candidates by name, adding the track name or start time only when names repeat',()=>{
  expect(audioFixLabels(multi(),audioFixCandidates(multi()))).toEqual(['main.mp4','second.mp4']);
  expect(audioFixLabels(offMainFirst(),audioFixCandidates(offMainFirst()))).toEqual(['main.mp4（Bロール）','main.mp4（原音1）','second.mp4']);
  const d=multi(),same={...d,assets:d.assets.map(a=>a.id==='second'?{...a,name:'main.mp4'}:a)};
  expect(audioFixLabels(same,audioFixCandidates(same))).toEqual(['main.mp4（0:00から）','main.mp4（0:10から）']);
});
