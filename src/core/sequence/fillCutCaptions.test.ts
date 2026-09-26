import {expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {type SequenceDocument,sourceTimeAt,effectFrameAt,clipEnd} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence} from './validate';
import {cutInclusivePreview} from '../../app/native/cutInclusivePreview';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}

function withoutCaptions(){const d=fixture();d.clips=d.clips.slice(0,2);d.transcripts=[{assetId:'media',streamIndex:1,words:[{id:'w1',text:'保存される',start:r(2),end:r(3)},{id:'w2',text:'字幕です',start:r(3),end:r(4)}]}];return d;}
it('fills saved cuts after caption generation, persists, restores, and is idempotent',()=>{
  const original=withoutCaptions();let d=applySequenceCommand(original,{type:'ripple-delete',startFrame:30,endFrame:60});
  const caption=fixture().clips[2]!;delete caption.anchor;caption.durationFrames=10;
  d=applySequenceCommand(d,{type:'insert',clips:[caption]});const before=structuredClone(d);
  const next=applySequenceCommand(d,{type:'fill-cut-captions',templateClipId:'t1'});
  expect(d).toEqual(before);expect(next.clips).toEqual(before.clips);
  const archived=next.cutArchive!.entries[0]!.clips.filter(c=>c.content.kind==='telop');expect(archived).toHaveLength(1);expect(archived[0]!.name).toBe('保存される字幕です');
  expect(applySequenceCommand(next,{type:'fill-cut-captions',templateClipId:'t1'}).cutArchive).toEqual(next.cutArchive);
  const saved=parseSequence(serializeSequence(next));const restored=applySequenceCommand(saved,{type:'restore-cut',entryId:saved.cutArchive!.entries[0]!.id});
  expect(restored.clips.find(c=>c.name==='保存される字幕です')).toMatchObject({startFrame:30,durationFrames:30});
});
it('never replaces an existing cut caption or invents silence captions',()=>{
  const original=fixture();original.transcripts=withoutCaptions().transcripts;
  const d=applySequenceCommand(original,{type:'ripple-delete',startFrame:30,endFrame:60});
  expect(applySequenceCommand(d,{type:'fill-cut-captions',templateClipId:'t1'}).cutArchive).toEqual(d.cutArchive);
});
it('review exactly reproduces each saved frame including media speed, effect clocks and captions',()=>{
  const original=fixture();const d=applySequenceCommand(original,{type:'ripple-delete',startFrame:30,endFrame:60}),before=structuredClone(d);
  const p=cutInclusivePreview(d).document;
  const sample=(doc:SequenceDocument,f:number)=>doc.clips.filter(c=>c.startFrame<=f&&clipEnd(c)>f).map(c=>({track:c.trackId,clock:effectFrameAt(c,f),source:c.content.kind==='video'||c.content.kind==='audio'?sourceTimeAt(c,f,doc.fps):null,text:c.content.kind==='telop'?c.content.data.text:null})).sort((a,b)=>a.track.localeCompare(b.track));
  for(let f=0;f<120;f++)expect(sample(p,f)).toEqual(sample(original,f));
  expect(d).toEqual(before);expect(p.sequenceEndFrame).toBe(120);expect(d.sequenceEndFrame).toBe(90);expect(p.cutArchive).toBeUndefined();
});
it('leaves ambiguous cuts out of playback while preserving every proven cut and the saved document',()=>{
  let d=applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:70,endFrame:80});
  d=applySequenceCommand(d,{type:'ripple-delete',startFrame:30,endFrame:40});
  d.cutArchive!.entries[0]!.boundary.ambiguous=true;
  const before=serializeSequence(d),p=cutInclusivePreview(d);
  expect(p.map.unresolved).toHaveLength(1);expect(p.map.cuts).toHaveLength(1);
  expect(p.document.sequenceEndFrame).toBe(d.sequenceEndFrame+10);
  expect(serializeSequence(d)).toBe(before);
  expect(p.document.clips.filter(c=>c.trackId==='v').flatMap(c=>Array.from({length:c.durationFrames},(_,i)=>sourceTimeAt(c,c.startFrame+i,p.document.fps))))
    .toEqual(Array.from({length:120},(_,f)=>f).filter(f=>f<70||f>=80).map(f=>sourceTimeAt(fixture().clips[0]!,f,d.fps)));
});
it('keeps live playback available when all cut positions are ambiguous',()=>{
  const d=applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:30,endFrame:60});d.cutArchive!.entries[0]!.boundary.ambiguous=true;
  const p=cutInclusivePreview(d);expect(p.document.sequenceEndFrame).toBe(d.sequenceEndFrame);expect(p.map.cuts).toHaveLength(0);expect(p.map.unresolved).toHaveLength(1);
});
it('groups overlapping transcript timestamps without overlapping generated captions',()=>{
  const original=withoutCaptions();original.transcripts[0]!.words=[{id:'x',text:'長い文章のテストです。ここで区切る予定です。',start:r(2),end:r(7,2)},{id:'y',text:'重なる発話',start:r(3),end:r(4)}];
  let d=applySequenceCommand(original,{type:'ripple-delete',startFrame:30,endFrame:60});const caption=fixture().clips[2]!;delete caption.anchor;caption.durationFrames=10;
  d=applySequenceCommand(d,{type:'insert',clips:[caption]});const next=applySequenceCommand(d,{type:'fill-cut-captions',templateClipId:'t1'});
  expect(next.cutArchive!.entries[0]!.clips.filter(c=>c.content.kind==='telop')).toHaveLength(1);
});
