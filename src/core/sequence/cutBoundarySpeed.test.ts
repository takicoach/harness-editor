import {expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {resolveCutBoundary} from './cutArchive';
import {type SequenceDocument} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence,sequenceContentBytes} from './validate';
import {SequenceSession} from './session';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}
const fixed=()=>{const d=fixture();delete d.clips[2]!.anchor;return d;};
const cut=(d:SequenceDocument)=>applySequenceCommand(d,{type:'ripple-delete',startFrame:30,endFrame:60});
const register=(d:SequenceDocument)=>applySequenceCommand(d,{type:'register-native-speed',groupId:'g',mainClipIds:d.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:d.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:d.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))});
const rate=(d:SequenceDocument,n:number)=>applySequenceCommand(d,{type:'set-native-global-speed',rate:r(n)});
const ready=(first:boolean)=>applySequenceCommand(first?cut(register(fixed())):register(cut(fixed())),{type:'upgrade-native-speed-operations'});
it.each([true,false])('rebinds all references after speed for register-first=%s without moving fixed captions',first=>{
 const before=ready(first),bytes=serializeSequence(before),entry=before.cutArchive!.entries[0]!,captions=before.clips.filter(c=>c.content.kind==='telop');
 expect(resolveCutBoundary(before,entry).frame).toBe(30);
 const next=rate(before,4),changed=next.cutArchive!.entries[0]!;
 expect(resolveCutBoundary(next,changed).frame).toBe(15);
 expect(changed.boundary.references.map(r=>r.clipId)).toEqual(entry.boundary.references.map(r=>r.clipId));
 expect(next.clips.filter(c=>c.content.kind==='telop')).toEqual(captions);
 expect(changed.clips).toEqual(entry.clips);expect(changed.durationFrames).toBe(30);
 expect(sequenceContentBytes(rate(parseSequence(serializeSequence(next)),2))).toBe(sequenceContentBytes(before));
 expect(serializeSequence(before)).toBe(bytes);
 const session=new SequenceSession('speed-cut',before);session.execute({sessionId:session.id,expectedRevision:before.revision,executionId:'speed',command:{type:'set-native-global-speed',rate:r(4)}});session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'undo',command:{type:'undo'}});expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(before));
});
it('maps the exact seam on individual speed and restores on reset without changing fixed captions',()=>{
 const before=ready(true),main=before.clips.find(c=>c.speed?.kind==='main'&&c.speed.order===0)!;
 const after=applySequenceCommand(before,{type:'set-native-main-speed',clipId:main.id,rate:r(4)});
 expect(resolveCutBoundary(after,after.cutArchive!.entries[0]!).frame).toBe(15);
 expect(sequenceContentBytes(applySequenceCommand(after,{type:'reset-native-main-speed',clipId:main.id}))).toBe(sequenceContentBytes(before));
});
it.each(['flag','external-move'] as const)('does not rehabilitate an already unresolved %s boundary',kind=>{
 let before=ready(true);if(kind==='flag')before.cutArchive!.entries[0]!.boundary.ambiguous=true;
 else {const c=before.clips.filter(c=>c.content.kind==='telop').at(-1)!;before=applySequenceCommand(before,{type:'move',clipIds:[c.id],deltaFrames:1,linked:false});}
 expect(resolveCutBoundary(before,before.cutArchive!.entries[0]!).frame).toBeNull();
 const after=rate(before,4);expect(resolveCutBoundary(after,after.cutArchive!.entries[0]!).frame).toBeNull();
});
it('keeps the fixed completion floor and fixed caption bytes when rebinding a main-end cut',()=>{
 const input=fixed();input.sequenceEndFrame=180;input.clips[2]!.durationFrames=180;
 const before=applySequenceCommand(register(input),{type:'ripple-delete',startFrame:120,endFrame:150}),after=rate(before,4);
 expect(before.sequenceEndFrame).toBe(150);expect(after.sequenceEndFrame).toBe(90);
 expect(resolveCutBoundary(before,before.cutArchive!.entries[0]!).frame).toBe(120);
 expect(resolveCutBoundary(after,after.cutArchive!.entries[0]!).frame).toBe(60);
 expect(after.clips.filter(c=>c.content.kind==='telop')).toEqual(before.clips.filter(c=>c.content.kind==='telop'));
});
import {rebindCutBoundariesForSpeed} from './cutBoundarySpeed';
it('does not force agreement when explicit main owners project the old seam to different positions',()=>{
 const before=ready(true);let after=rate(before,4);
 const right=after.clips.find(c=>c.speed?.kind==='main'&&c.startFrame===15)!;
 after=applySequenceCommand(after,{type:'move',clipIds:[right.id],deltaFrames:1,linked:true});
 const refs=structuredClone(after.cutArchive!.entries[0]!.boundary.references),clips=structuredClone(after.clips);
 rebindCutBoundariesForSpeed(before,after);
 expect(after.cutArchive!.entries[0]!.boundary.ambiguous).toBe(before.cutArchive!.entries[0]!.boundary.ambiguous);expect(resolveCutBoundary(after,after.cutArchive!.entries[0]!).frame).toBeNull();
 expect(after.cutArchive!.entries[0]!.boundary.references).toEqual(refs);expect(after.clips).toEqual(clips);
});
it.each([false,true])('does not mutate an unresolved saved band on same-rate Enter and permits rate-back (disagreement=%s)',disagreement=>{
 const original=ready(true);let before=rate(original,4);
 if(disagreement)before.cutArchive!.entries[0]!.boundary=structuredClone(original.cutArchive!.entries[0]!.boundary);
 const bytes=sequenceContentBytes(before),same=rate(before,4);
 expect(sequenceContentBytes(same)).toBe(bytes);expect(before.cutArchive!.entries[0]!.boundary.ambiguous).toBe(false);
 const back=rate(parseSequence(serializeSequence(before)),2);
 expect(resolveCutBoundary(back,back.cutArchive!.entries[0]!).frame).toBe(30);
 expect(back.cutArchive!.entries[0]!.boundary.ambiguous).toBe(false);
});
it('permits an unowned gap boundary to agree naturally again when restoring its original rate',()=>{
 const input=fixed();input.sequenceEndFrame=150;
 const before=applySequenceCommand(register(input),{type:'ripple-delete',startFrame:125,endFrame:145});
 expect(resolveCutBoundary(before,before.cutArchive!.entries[0]!).frame).toBe(125);
 const fast=rate(before,4);expect(resolveCutBoundary(fast,fast.cutArchive!.entries[0]!).frame).toBeNull();
 const back=rate(fast,2);expect(resolveCutBoundary(back,back.cutArchive!.entries[0]!).frame).toBe(125);expect(back.cutArchive!.entries[0]!.boundary.ambiguous).toBe(false);
});
it('keeps two cut seams through mixed left override/right global and exact reset',()=>{
 let before=applySequenceCommand(cut(register(fixed())),{type:'ripple-delete',startFrame:60,endFrame:70});before=applySequenceCommand(before,{type:'upgrade-native-speed-operations'});
 const main=before.clips.find(c=>c.speed?.kind==='main'&&c.speed.order===0)!;
 expect(before.cutArchive!.entries.map(e=>resolveCutBoundary(before,e).frame)).toEqual([30,60]);
 const changed=applySequenceCommand(before,{type:'set-native-main-speed',clipId:main.id,rate:r(4)});
 expect(changed.cutArchive!.entries.map(e=>resolveCutBoundary(changed,e).frame)).toEqual([15,45]);
 const back=applySequenceCommand(parseSequence(serializeSequence(changed)),{type:'reset-native-main-speed',clipId:main.id});expect(sequenceContentBytes(back)).toBe(sequenceContentBytes(before));
});
it('retains a missing latent caption witness and rebinds it when the same reserved ID revives',()=>{
 const input=fixture(),caption=input.clips[2]!;caption.startFrame=9;caption.durationFrames=5;caption.clock={offset:r(0),rate:r(1),duration:r(5)};
 if(caption.anchor?.kind==='source'){caption.anchor.sourceStart=r(3,5);caption.anchor.sourceEnd=r(14,15);}
 const before=applySequenceCommand(applySequenceCommand(register(input),{type:'ripple-delete',startFrame:10,endFrame:11}),{type:'upgrade-native-speed-operations'});
 const e=before.cutArchive!.entries[0]!,left=before.clips.find(c=>c.content.kind==='telop'&&c.startFrame===9)!;expect(e.boundary.references.some(ref=>ref.clipId===left.id)).toBe(true);
 const fast=rate(before,4);expect(fast.clips.some(c=>c.id===left.id)).toBe(false);expect(fast.cutArchive!.entries[0]!.boundary.references.some(ref=>ref.clipId===left.id)).toBe(true);
 const back=rate(fast,2);expect(back.clips.find(c=>c.id===left.id)).toEqual(left);expect(resolveCutBoundary(back,back.cutArchive!.entries[0]!).frame).toBe(10);expect(sequenceContentBytes(back)).toBe(sequenceContentBytes(before));
});
