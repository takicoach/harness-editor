import {expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {type SequenceDocument,effectFrameAt,sourceTimeAt} from './model';
import {rational as r,type Rational} from './time';
import {parseSequence,serializeSequence} from './validate';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}
const sample=(d:SequenceDocument,at:number)=>d.clips.filter(c=>c.startFrame<=at&&at<c.startFrame+c.durationFrames).map(c=>({kind:c.content.kind,track:c.trackId,clock:effectFrameAt(c,at),source:c.content.kind==='video'||c.content.kind==='audio'?sourceTimeAt(c,at,d.fps):null,text:c.content.kind==='telop'?c.content.data.text:null})).sort((a,b)=>a.track.localeCompare(b.track));

const register=(d=fixture())=>applySequenceCommand(d,{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});
const speed=(d:SequenceDocument,rate:Rational)=>applySequenceCommand(d,{type:'set-native-global-speed',rate});
const cut=(d:SequenceDocument,startFrame=30,endFrame=60)=>applySequenceCommand(d,{type:'ripple-delete',startFrame,endFrame});
const restore=(d:SequenceDocument,range?:{startFrame:number;endFrame:number})=>applySequenceCommand(d,{type:'restore-cut',entryId:d.cutArchive!.entries[0]!.id,...(range?{range}:{})});
function sameFrames(actual:SequenceDocument,expected:SequenceDocument){expect(actual.sequenceEndFrame).toBe(expected.sequenceEndFrame);for(let f=0;f<expected.sequenceEndFrame;f++)expect(sample(actual,f),'frame '+f).toEqual(sample(expected,f));}
it.each([r(1),r(3),r(4),r(2,3)])('projects archived source/effect/AV/caption intent into current global rate %j',rate=>{
 const original=register(),expected=speed(original,rate);let d=speed(cut(original),rate);const bytes=serializeSequence(d);
 d=restore(parseSequence(bytes));sameFrames(d,expected);expect(d.cutArchive).toBeUndefined();expect(serializeSequence(parseSequence(bytes))).toBe(bytes);
});
it('keeps partial range units in original archived frames through successive global-rate changes',()=>{
 const original=register();let d=speed(cut(original),r(4));expect(d.cutArchive!.entries[0]!.durationFrames).toBe(30);
 d=restore(d,{startFrame:10,endFrame:20});expect(d.cutArchive!.entries.map(e=>e.durationFrames)).toEqual([10,10]);
 d=speed(parseSequence(serializeSequence(d)),r(1));while(d.cutArchive?.entries.length)d=restore(d);sameFrames(d,speed(original,r(1)));
});
import {previewCutRestoration} from './commands';
it('previews current duration without consuming or changing the original range unit',()=>{
 const d=speed(cut(register()),r(4)),bytes=serializeSequence(d),id=d.cutArchive!.entries[0]!.id;
 expect(previewCutRestoration(d,id)).toEqual({durationFrames:15});expect(previewCutRestoration(d,id,{startFrame:10,endFrame:20})).toEqual({durationFrames:5});expect(serializeSequence(d)).toBe(bytes);
});
function occurrences(count=3){const d=fixture();d.sequenceEndFrame=count*120;const clips=structuredClone(d.clips);for(let i=1;i<count;i++)d.clips.push(...structuredClone(clips).map(c=>({...c,id:c.id+'-'+i,startFrame:i*120,linkGroupId:c.linkGroupId?'av-'+i:undefined,...(c.anchor?.kind==='source'?{anchor:{...c.anchor,clipOccurrenceId:'a1-'+i}}:{})})));return applySequenceCommand(d,{type:'register-native-speed',groupId:'speed',mainClipIds:Array.from({length:count},(_,i)=>i?'v1-'+i:'v1'),mainAudioBindings:Array.from({length:count},(_,i)=>({audioClipId:i?'a1-'+i:'a1',providerId:i?'v1-'+i:'v1'}))});}
it.each([r(1),r(3,2),r(3),r(4)])('retains a saved override when its whole owner is absent at the changed global rate %j',rate=>{
 let original=occurrences(2);original=applySequenceCommand(original,{type:'set-native-main-speed',clipId:'v1-1',rate:r(4)});const second=original.clips.find(c=>c.id==='v1-1')!;
 const d=speed(cut(original,second.startFrame,second.startFrame+second.durationFrames),rate);sameFrames(restore(d),speed(original,rate));
});
it.each([r(1),r(3,2),r(3),r(4)])('keeps original evaluation phase with an unrelated surviving override at rate %j',rate=>{
 let original=occurrences();original=applySequenceCommand(original,{type:'set-native-main-speed',clipId:'v1-1',rate:r(3)});
 const d=speed(cut(original,17,46),rate);sameFrames(restore(d),speed(original,rate));
});
it('preserves later visible caption text and color while only projecting the archived intent',()=>{
 let d=speed(cut(register()),r(4));const clip=d.clips.find(c=>c.content.kind==='telop'&&c.startFrame===15)!;
 d=applySequenceCommand(d,{type:'update-clip',clipId:clip.id,patch:{content:{...clip.content,data:{text:'後で修正した本文'}} as never}});const before=structuredClone(d),next=restore(d);
 expect(next.clips.some(c=>c.content.kind==='telop'&&c.content.data.text==='後で修正した本文')).toBe(true);expect(d).toEqual(before);
});
it('restores a proven late registration but still rejects removed speed roles',()=>{
 const plain=cut(fixture()),registered=applySequenceCommand(plain,{type:'register-native-speed',groupId:'new',mainClipIds:plain.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:plain.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:plain.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))});
 const bytes=serializeSequence(registered);sameFrames(restore(registered),fixture());expect(serializeSequence(registered)).toBe(bytes);
 const removed=cut(register());delete removed.speed;for(const c of removed.clips)delete c.speed;expect(()=>restore(removed)).toThrow('速度登録');
});
import {resolveCutBoundary} from './cutArchive';
import {projectCutSpeed} from './cutSpeedProjection';
it('keeps a fixed overlay clock and rebinds every witness to the known speed-mapped boundary',()=>{
 const input=fixture();input.tracks.push({id:'overlay',kind:'visual',name:'固定図形',enabled:true});input.clips.push({id:'shape',trackId:'overlay',name:'固定',startFrame:0,durationFrames:120,clock:{offset:r(5),rate:r(3,2),duration:r(300)},content:{kind:'shape',data:{kind:'rect',x1:.1,y1:.1,x2:.5,y2:.5,color:'#fff',thickness:'medium',opacity:1}}});
 const d=speed(cut(register(input)),r(4)),entry=d.cutArchive!.entries[0]!,old=entry.clips.find(c=>c.content.kind==='shape')!;
 expect(resolveCutBoundary(d,entry).frame).toBe(15);expect(previewCutRestoration(d,entry.id)).toEqual({durationFrames:15});
 const next=restore(d),piece=next.clips.find(c=>c.content.kind==='shape'&&c.name==='固定'&&c.clock.offset.num===old.clock.offset.num&&c.clock.offset.den===old.clock.offset.den)!;
 expect(piece.clock).toEqual(old.clock);expect(piece.durationFrames).toBe(old.durationFrames);expect(piece.content).toEqual(old.content);expect(piece.startFrame).toBe(30); // fixed-track saved witness preserves its own prefix order; canonical AV seam stays15
});
it('retains original fps rejection and does not consume ranges that collapse at current speed',()=>{
 const d=speed(cut(register()),r(16)),bytes=serializeSequence(d);expect(()=>restore(d,{startFrame:0,endFrame:1})).toThrow();expect(serializeSequence(d)).toBe(bytes);
 const original=register(),different=structuredClone(original);different.speed!.fpsBasis=r(24);expect(()=>projectCutSpeed(different,original,120)).toThrow('fps');
});
it('keeps fixed empty gaps unscaled when the archived band has no main owner',()=>{
 const input=fixture();input.sequenceEndFrame=150;const original=register(input),d=speed(cut(original,125,145),r(4));
 expect(previewCutRestoration(d,d.cutArchive!.entries[0]!.id)).toEqual({durationFrames:20});sameFrames(restore(d),speed(original,r(4)));
});
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SequenceStore} from '../../server/sequence/store';
it('persists the original archive, changes rate after reopening, and saves partially restored source intent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'cut-speed-save-'));try{
  const original=register(),store=new SequenceStore(dir),deleted=cut(original);const first=store.save({document:deleted,expectedSavedRevision:null,executionId:'cut'});
  const originalBytes=readFileSync(store.file),loaded=new SequenceStore(dir).load()!,current=speed(loaded.document,r(4));
  expect(current.cutArchive!.entries.map(({boundary,...saved})=>saved)).toEqual(deleted.cutArchive!.entries.map(({boundary,...saved})=>saved));expect(current.cutArchive!.entries[0]!.boundary.hintFrame).toBe(15);const restored=restore(current,{startFrame:10,endFrame:20});expect(restored.sequenceEndFrame-current.sequenceEndFrame).toBe(5);
  expect(readFileSync(store.file)).toEqual(originalBytes);const saved=store.save({document:restored,expectedSavedRevision:first.savedRevision,executionId:'partial'});
  let next=new SequenceStore(dir).load()!.document;expect(next).toEqual(saved.document);while(next.cutArchive?.entries.length)next=restore(next);sameFrames(next,speed(original,r(4)));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('preserves an override edited on a surviving fragment without lending it to the saved interval',()=>{
 let d=cut(register());d=applySequenceCommand(d,{type:'set-native-main-speed',clipId:'v1',rate:r(4)});d=speed(d,r(1));
 const entry=d.cutArchive!.entries[0]!,at=resolveCutBoundary(d,entry).frame!,amount=previewCutRestoration(d,entry.id).durationFrames,next=restore(d);
 const existingIds=new Set(d.clips.map(c=>c.id)),inserted=next.clips.find(c=>!existingIds.has(c.id)&&c.content.kind==='video')!;
 expect(inserted.content.kind==='video'&&inserted.content.rate).toEqual(r(1));expect(next.clips.find(c=>c.id==='v1')!.speed).toMatchObject({override:r(4)});
 for(let f=0;f<d.sequenceEndFrame;f++)expect(sample(next,f<at?f:f+amount)).toEqual(sample(d,f));
});
