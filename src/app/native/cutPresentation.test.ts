import {expect,it} from 'vitest';
import {applySequenceCommand} from '../../core/sequence/commands';
import {rational as r} from '../../core/sequence/time';
import type {SequenceDocument} from '../../core/sequence/model';
import {archivedWords,cutLabel} from './cutPresentation';
import {parseSequence,serializeSequence} from '../../core/sequence/validate';
function fixture():SequenceDocument{
  const content={kind:'audio' as const,assetId:'source',streamIndex:0,sourceIn:r(0),rate:r(1),role:'speech' as const,loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}};
  return {schemaVersion:2,id:'words',name:'発話',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',ducking:{enabled:false,strength:'mid'},transitions:[],
    assets:[{id:'source',kind:'media',name:'音声',file:'source.wav',fingerprint:'fixture',streams:[{index:0,kind:'audio',codec:'pcm_s16le',duration:r(10),sampleRate:48000,channels:1}]}],
    tracks:[{id:'a',kind:'audio',name:'発話',enabled:true}],
    clips:[{id:'fast',name:'同じ発話の2倍速',trackId:'a',startFrame:0,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{...content,rate:r(2)}},
      {id:'normal',name:'同じ発話の等速',trackId:'a',startFrame:60,durationFrames:60,clock:{offset:r(0),rate:r(1),duration:r(60)},content}],
    transcripts:[{assetId:'source',streamIndex:0,words:[{id:'w',text:'ことば',start:r(1,4),end:r(3,4)},{id:'later',text:'つづき',start:r(3,2),end:r(5,2)}]}]};
}
it('maps saved source words to each archived occurrence, with exact outward rounding and clipped ends',()=>{
  const cut=parseSequence(serializeSequence(applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:0,endFrame:120}))),entry=cut.cutArchive!.entries[0]!;
  expect(archivedWords(cut,entry).map(w=>[w.id,w.startFrame,w.endFrame])).toEqual([['fast:w',3,12],['fast:later',22,30],['normal:w',67,83],['normal:later',105,120]]);
  expect(cutLabel(cut,entry)).toBe('ことばつづきことばつづき');
});
it('keeps selected words inside a partially removed source occurrence',()=>{
  const cut=applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:8,endFrame:26}),entry=cut.cutArchive!.entries[0]!;
  expect(archivedWords(cut,entry).map(w=>[w.text,w.startFrame,w.endFrame])).toEqual([['ことば',0,4],['つづき',14,18]]);
});
