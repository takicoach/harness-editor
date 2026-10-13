// src/core/sequence/mainTrack.test.ts
import {describe,expect,it} from 'vitest';
import type {SequenceDocument} from './model';
import {fixture} from './fixtures';
import {applySequenceCommand} from './commands';
import {SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP} from './commandTypes';
import {parseSequence,serializeSequence,validateSequenceDocument} from './validate';
import {mainAppendStart,mainEnd,mainTracks} from './mainTrack';
import {rational as r} from './time';
import {planTransition} from './transitions';

/** fixture の v1/a1 を v-main/a-main に付け替えた、新規作成・移行と同じ名前の文書。 */
const withMainIds=():SequenceDocument=>{const d=fixture();
  d.tracks=d.tracks.map(t=>t.id==='v1'?{...t,id:'v-main'}:t.id==='a1'?{...t,id:'a-main'}:t);
  d.clips=d.clips.map(c=>c.trackId==='v1'?{...c,trackId:'v-main'}:c.trackId==='a1'?{...c,trackId:'a-main'}:c);return d;};

describe('mainTracks',()=>{
  it('uses the explicit main first',()=>{
    expect(mainTracks({...withMainIds(),main:{videoTrackId:'v2'}})).toEqual({videoTrackId:'v2'});
  });
  it('falls back to v-main / a-main only',()=>{
    expect(mainTracks(withMainIds())).toEqual({videoTrackId:'v-main',audioTrackId:'a-main'});
    const silent=withMainIds();silent.tracks=silent.tracks.filter(t=>t.id!=='a-main');silent.clips=silent.clips.filter(c=>c.trackId!=='a-main'&&c.content.kind!=='telop');
    expect(mainTracks(silent)).toEqual({videoTrackId:'v-main'});
  });
  it('never guesses from the speech role or track order',()=>{
    expect(mainTracks(fixture())).toEqual({});
  });
});
describe('mainEnd',()=>{
  it('is the end of the last clip on the main video/audio tracks, ignoring other tracks',()=>{
    expect(mainEnd(withMainIds())).toBe(300);
    expect(mainEnd(fixture())).toBe(0);
  });
  it('appends from the main end, or after the whole length when no main track exists yet',()=>{
    expect(mainAppendStart({...withMainIds(),sequenceEndFrame:420})).toBe(300);
    expect(mainAppendStart({...fixture(),sequenceEndFrame:330})).toBe(330);
  });
});
describe('main の検証',()=>{
  it('accepts tracks that exist with the right kinds and survives a save/load round trip',()=>{
    const doc={...withMainIds(),main:{videoTrackId:'v-main',audioTrackId:'a-main'}};
    validateSequenceDocument(doc);expect(parseSequence(serializeSequence(doc)).main).toEqual({videoTrackId:'v-main',audioTrackId:'a-main'});
  });
  it.each([
    ['missing track',{videoTrackId:'nope'}],
    ['audio track as video',{videoTrackId:'a-main'}],
    ['visual track as audio',{videoTrackId:'v-main',audioTrackId:'v2'}],
    ['unknown key',{videoTrackId:'v-main',extra:'x'}],
  ])('rejects %s',(_name,main)=>{
    expect(()=>validateSequenceDocument({...withMainIds(),main} as unknown as SequenceDocument)).toThrow('メインのトラックの記録が不正です');
  });
});
describe('set-main-tracks / remove-track',()=>{
  it('records main as one edit and is not accepted over HTTP',()=>{
    const doc=withMainIds(),next=applySequenceCommand(doc,{type:'set-main-tracks',main:{videoTrackId:'v-main',audioTrackId:'a-main'}});
    expect(next.main).toEqual({videoTrackId:'v-main',audioTrackId:'a-main'});expect(next.revision).toBe(doc.revision+1);
    expect(SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP).toContain('set-main-tracks');
  });
  it('drops main.audioTrackId when that empty track is removed, and main itself with its video track',()=>{
    const doc:SequenceDocument={...withMainIds(),tracks:[...withMainIds().tracks,{id:'v9',kind:'visual',name:'空',enabled:true},{id:'a9',kind:'audio',name:'空',enabled:true}],main:{videoTrackId:'v9',audioTrackId:'a9'}};
    const noAudio=applySequenceCommand(doc,{type:'remove-track',trackId:'a9'});expect(noAudio.main).toEqual({videoTrackId:'v9'});
    expect(applySequenceCommand(noAudio,{type:'remove-track',trackId:'v9'}).main).toBeUndefined();
  });
  // 場面フェードの空レーンを畳む2経路（転換への置き換え・フェードを外す）も、remove-track と同じ後始末をする。
  it('drops main when the scene-fade lane it points to is folded away',()=>{
    const doc=withMainIds(),first=doc.clips.find(c=>c.id==='video')!;
    first.durationFrames=150;first.clock.duration=r(150);
    doc.clips.push({...structuredClone(first),id:'video2',startFrame:150,linkGroupId:undefined,clock:{offset:r(0),rate:r(1),duration:r(150)},
      content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:r(20),rate:r(1)}});
    doc.clips=doc.clips.filter(c=>c.id!=='telop');
    const target={kind:'join' as const,trackId:'v-main',outClipId:'video',inClipId:'video2'};
    const faded=applySequenceCommand(doc,{type:'set-scene-fades',targets:[target],change:{enabled:true}});
    const lane=faded.tracks.find(t=>!doc.tracks.some(d=>d.id===t.id))!.id;
    const onLane=applySequenceCommand(faded,{type:'set-main-tracks',main:{videoTrackId:lane,audioTrackId:'a-main'}});
    const plan=planTransition(onLane,'join:v-main:video:video2','crossfade',20);if(!('transition' in plan))throw new Error('plan');
    const replaced=applySequenceCommand(onLane,{type:'set-transition',joinKey:'join:v-main:video:video2',transition:plan.transition});
    expect(replaced.tracks.some(t=>t.id===lane)).toBe(false);expect(replaced.main).toBeUndefined();
    const removed=applySequenceCommand(onLane,{type:'set-scene-fades',targets:[target],change:{enabled:false}});
    expect(removed.tracks.some(t=>t.id===lane)).toBe(false);expect(removed.main).toBeUndefined();
  });
});
describe('保管帯のグラフ',()=>{
  // 保管帯はカットした時点のトラックだけを持つ。カットの後にメインのトラックを作って記録した案件でも、部分復元が通り、main が残ること。
  it('restores part of a cut made before the main track existed, keeping main',()=>{
    const cut=applySequenceCommand(withMainIds(),{type:'ripple-delete',startFrame:0,endFrame:60});
    const withNewMain=applySequenceCommand(cut,{type:'batch',commands:[{type:'add-track',track:{id:'v-new',kind:'visual',name:'メイン',enabled:true},index:0},{type:'set-main-tracks',main:{videoTrackId:'v-new'}}]});
    expect(withNewMain.cutArchive!.entries[0]!.tracks.some(t=>t.id==='v-new')).toBe(false);
    const restored=applySequenceCommand(withNewMain,{type:'restore-cut',entryId:withNewMain.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}});
    validateSequenceDocument(restored);expect(restored.main).toEqual({videoTrackId:'v-new'});
  });
});
