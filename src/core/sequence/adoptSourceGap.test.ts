import {expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {inspectNativeSourceGaps} from './sourceGapRecovery';
import {clipEnd,sourceTimeAt,effectFrameAt,type SequenceDocument} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence,validateSequenceDocument} from './validate';

function original():SequenceDocument{return {schemaVersion:2,id:'doc',name:'原本',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:300,background:'#000',
 tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
 assets:[{id:'asset',kind:'media',name:'原本',file:'source.mp4',fingerprint:'a',streams:[{index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180},{index:1,kind:'audio',codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],
 clips:[{id:'v1',name:'映像',trackId:'v',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},linkGroupId:'link',content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}},
 {id:'a1',name:'原音',trackId:'a',startFrame:0,durationFrames:300,clock:{offset:r(0),rate:r(1),duration:r(300)},linkGroupId:'link',content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:-8,muted:false,fadeInFrames:0,fadeOutFrames:0}}}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'}};}
function fixture(){const doc=applySequenceCommand(original(),{type:'ripple-delete',startFrame:90,endFrame:120});delete doc.cutArchive;return doc;}
function candidate(doc:SequenceDocument){const values=inspectNativeSourceGaps(doc).candidates;expect(values).toHaveLength(1);return values[0]!;}
function adopt(doc=fixture(),atFrame?:number){const gap=candidate(doc);return applySequenceCommand(doc,{type:'adopt-source-gap',candidateId:gap.id,ownerClipId:gap.ownerChoices[0]!.ownerClipId,...(atFrame===undefined?{}:{atFrame})});}
it('adds a source-provenance band without changing any live editing data or the input object',()=>{
 const doc=fixture(),before=structuredClone(doc),next=adopt(doc),entry=next.cutArchive!.entries[0]!;
 expect(doc).toEqual(before);const live=structuredClone(next);delete live.cutArchive;live.revision=doc.revision;expect(live).toEqual(doc);
 expect(entry.durationFrames).toBe(30);expect(entry.sourceRecovery).toMatchObject({version:1,documentId:'doc',revision:doc.revision,sources:[{assetId:'asset',streamIndex:0,start:r(3),end:r(4)},{assetId:'asset',streamIndex:1,start:r(3),end:r(4)}]});
 for(const clip of entry.clips){expect(sourceTimeAt(clip,0,doc.fps)).toEqual(r(3));expect(effectFrameAt(clip,0)).toEqual(r(90));}
 expect(inspectNativeSourceGaps(next).candidates).toHaveLength(0);
});
it('uses the existing serialized archive restoration for every original AV sample',()=>{
 const doc=adopt(),saved=parseSequence(serializeSequence(doc)),next=applySequenceCommand(saved,{type:'restore-cut',entryId:saved.cutArchive!.entries[0]!.id});
 expect(next.sequenceEndFrame).toBe(300);
 expect(inspectNativeSourceGaps(next).candidates).toHaveLength(0);
 for(let frame=0;frame<300;frame++)for(const trackId of ['v','a']){
  const clip=next.clips.find(c=>c.trackId===trackId&&c.startFrame<=frame&&frame<clipEnd(c))!;
  expect(sourceTimeAt(clip,frame,next.fps)).toEqual(r(frame,30));expect(effectFrameAt(clip,frame)).toEqual(r(frame));
 }
});
it('preserves reconstruction provenance on both partial remnants and existing edited subtitle text',()=>{
 const doc=fixture();doc.tracks.push({id:'text-track',kind:'visual',name:'字幕',enabled:true});doc.clips.push({id:'text',name:'字幕',trackId:'text-track',startFrame:130,durationFrames:20,clock:{offset:r(0),rate:r(1),duration:r(20)},content:{kind:'telop',data:{text:'今の編集を残す'}}});
 const adopted=adopt(doc),entry=adopted.cutArchive!.entries[0]!;
 const next=applySequenceCommand(adopted,{type:'restore-cut',entryId:entry.id,range:{startFrame:5,endFrame:20}});
 expect(next.cutArchive!.entries).toHaveLength(2);for(const remaining of next.cutArchive!.entries)expect(remaining.sourceRecovery).toEqual(entry.sourceRecovery);
 expect(inspectNativeSourceGaps(next).candidates).toHaveLength(0);
 expect(next.clips.find(c=>c.id==='text')).toMatchObject({startFrame:145,content:{data:{text:'今の編集を残す'}}});validateSequenceDocument(next);
});
it('requires a location for a gap whose surviving completion edges no longer agree',()=>{
 const doc=fixture();for(const clip of doc.clips)if(clip.startFrame===90)clip.startFrame+=3;doc.sequenceEndFrame+=3;
 expect(candidate(doc).placement.frame).toBeNull();expect(()=>adopt(doc)).toThrow('位置');
 expect(adopt(doc,90).cutArchive!.entries[0]!.boundary.hintFrame).toBe(90);
});
it('rejects a stale candidate or an owner from another use, and malformed source provenance',()=>{
 const doc=fixture(),gap=candidate(doc);
 expect(()=>applySequenceCommand(doc,{type:'adopt-source-gap',candidateId:gap.id,ownerClipId:'other'})).toThrow('使用箇所');
 const adopted=adopt(doc);expect(()=>applySequenceCommand(adopted,{type:'adopt-source-gap',candidateId:gap.id,ownerClipId:gap.ownerChoices[0]!.ownerClipId})).toThrow('使用範囲');
 adopted.cutArchive!.entries[0]!.sourceRecovery!.sources[0]!.end=r(20);expect(()=>validateSequenceDocument(adopted)).toThrow('補完元');
});
