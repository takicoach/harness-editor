import {expect,it} from 'vitest';
import {applySequenceCommand,previewCutRestoration} from './commands';
import {type SequenceDocument,effectFrameAt,sourceTimeAt} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence} from './validate';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}
const sample=(d:SequenceDocument,at:number)=>d.clips.filter(c=>c.startFrame<=at&&at<c.startFrame+c.durationFrames).map(c=>({kind:c.content.kind,track:c.trackId,clock:effectFrameAt(c,at),source:c.content.kind==='video'||c.content.kind==='audio'?sourceTimeAt(c,at,d.fps):null,text:c.content.kind==='telop'?c.content.data.text:null})).sort((a,b)=>a.track.localeCompare(b.track));
const cut=(d:SequenceDocument,a=30,b=60)=>applySequenceCommand(d,{type:'ripple-delete',startFrame:a,endFrame:b});
function register(d:SequenceDocument){return applySequenceCommand(d,{type:'register-native-speed',groupId:'selected-speed',mainClipIds:d.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:d.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:d.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))});}
const speed=(d:SequenceDocument,n:number)=>applySequenceCommand(d,{type:'set-native-global-speed',rate:r(n)});
const restore=(d:SequenceDocument)=>applySequenceCommand(d,{type:'restore-cut',entryId:d.cutArchive!.entries[0]!.id});
it.each([1,2,3,4])('registers proven archived AV roles after a cut and restores at global %s',rate=>{
 const original=fixture(),cutDoc=cut(original),before=serializeSequence(cutDoc),registered=register(cutDoc);
 expect(registered.clips.map(c=>({...c,speed:undefined}))).toEqual(cutDoc.clips.map(c=>({...c,speed:undefined})));
 expect(serializeSequence(cutDoc)).toBe(before);expect(registered.cutArchive!.entries[0]!.durationFrames).toBe(30);
 const restored=restore(parseSequence(serializeSequence(speed(registered,rate)))),expected=speed(register(original),rate);
 expect(restored.sequenceEndFrame).toBe(expected.sequenceEndFrame);for(let f=0;f<expected.sequenceEndFrame;f++)expect(sample(restored,f),'frame '+f).toEqual(sample(expected,f));
});

import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
it('preserves old partial units, later live edits and saved registration through reload and another rate',()=>{
 const registered=register(cut(fixture())),dir=mkdtempSync(join(tmpdir(),'cut-register-'));
 try{
  const store=new SequenceStore(dir);store.save({document:registered,executionId:'registered',expectedSavedRevision:null});const bytes=readFileSync(store.file);
  let d=speed(new SequenceStore(dir).load()!.document,4),entry=d.cutArchive!.entries[0]!;
  expect(previewCutRestoration(d,entry.id,{startFrame:10,endFrame:20})).toEqual({durationFrames:5});
  d=applySequenceCommand(d,{type:'restore-cut',entryId:entry.id,range:{startFrame:10,endFrame:20}});expect(d.cutArchive!.entries.map(e=>e.durationFrames)).toEqual([10,10]);
  const caption=d.clips.find(c=>c.content.kind==='telop')!;
  d=applySequenceCommand(d,{type:'update-clip',clipId:caption.id,patch:{name:'later',content:{kind:'telop',data:{text:'後から編集'}}}});
  const persisted=store.save({document:d,executionId:'partial',expectedSavedRevision:registered.revision});expect(readFileSync(store.file)).not.toEqual(bytes);
  d=speed(new SequenceStore(dir).load()!.document,1);while(d.cutArchive?.entries.length)d=restore(d);
  expect(d.sequenceEndFrame).toBe(240);expect(d.clips.some(c=>c.content.kind==='telop'&&c.content.data.text==='後から編集')).toBe(true);expect(d.clips.some(c=>c.content.kind==='telop'&&c.content.data.text==='元の本文')).toBe(true);
  expect(new SequenceStore(dir).load()!.document).toEqual(persisted.document);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('one registration Undo removes only the added roles, and failed batch leaves its input untouched',()=>{
 const before=cut(fixture()),session=new SequenceSession('s',before),registered=register(before);
 const command={type:'register-native-speed' as const,groupId:'selected-speed',mainClipIds:before.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:before.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:before.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))};
 session.execute({sessionId:'s',expectedRevision:before.revision,executionId:'register',command});expect(session.document).toEqual(registered);
 session.execute({sessionId:'s',expectedRevision:registered.revision,executionId:'undo',command:{type:'undo'}});expect({...session.document,revision:before.revision}).toEqual(before);
 expect(()=>applySequenceCommand(before,{type:'batch',commands:[command,{type:'delete',clipIds:['missing']}]})).toThrow();expect(before.cutArchive!.entries[0]!.speed).toBeUndefined();
});
function repeated(){const d=fixture();d.sequenceEndFrame=240;d.clips.push(...structuredClone(d.clips).map(c=>({...c,id:c.id+'-again',startFrame:120,linkGroupId:c.linkGroupId?'av-again':undefined,...(c.anchor?.kind==='source'?{anchor:{...c.anchor,clipOccurrenceId:'a1-again'}}:{})})));return d;}
it('does not bind a fully removed usage to a selected same-asset occurrence',()=>{
 const d=register(cut(repeated(),0,120)),bytes=serializeSequence(d);expect(d.cutArchive!.entries[0]!.speed).toBeUndefined();expect(()=>restore(d)).toThrow('速度登録');expect(serializeSequence(d)).toBe(bytes);
});
it('binds only the surviving explicit occurrence and keeps different-use roles separate',()=>{
 const d=register(cut(repeated())),entry=d.cutArchive!.entries[0]!;expect(entry.clips.find(c=>c.id==='v1')!.speed?.kind).toBe('main');expect(entry.clips.some(c=>c.id.endsWith('-again'))).toBe(false);
 const result=restore(speed(d,1)),expected=speed(register(repeated()),1);expect(result.sequenceEndFrame).toBe(480);for(let f=0;f<480;f++)expect(sample(result,f)).toEqual(sample(expected,f));
});
it.each(['reorder','clock','source','selection-conflict'] as const)('does not guess a role from %s evidence',kind=>{
 let d=cut(fixture());if(kind==='reorder')d.cutArchive!.entries[0]!.boundary.ambiguous=true;
 if(kind==='clock')d.clips.find(c=>c.content.kind==='video')!.clock.offset=r(99);
 if(kind==='source'){for(const c of d.clips.filter(c=>c.startFrame===0))if(c.content.kind==='video'||c.content.kind==='audio')c.content.sourceIn=r(1);for(const c of d.clips)if(c.anchor?.kind==='source'){const occurrenceId=c.anchor.clipOccurrenceId,provider=d.clips.find(p=>p.id===occurrenceId)!;c.anchor.sourceStart=sourceTimeAt(provider,c.startFrame,d.fps);c.anchor.sourceEnd=sourceTimeAt(provider,c.startFrame+c.durationFrames,d.fps);}}
 if(kind==='selection-conflict')d=applySequenceCommand(d,{type:'register-native-speed',groupId:'partial',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});else d=register(d);
 expect(d.cutArchive!.entries[0]!.speed).toBeUndefined();
});
it.each([[0,30],[90,120]])('accepts a head or tail cut with a surviving exact boundary at %j',(a,b)=>{
 const d=register(cut(fixture(),a,b)),result=restore(d);expect(result.sequenceEndFrame).toBe(120);for(let f=0;f<120;f++)expect(sample(result,f)).toEqual(sample(fixture(),f));
});

it('keeps saved roles of a mixed-rate registration at their explicit original overrides',()=>{
 const original=repeated();for(const c of original.clips.filter(c=>c.id.endsWith('-again')))if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);
 const caption=original.clips.find(c=>c.id==='t1-again')!;if(caption.anchor?.kind==='source')caption.anchor.sourceEnd=r(4);
 const registered=register(cut(original)),entry=registered.cutArchive!.entries[0]!;expect(entry.speed!.globalRate).toEqual(r(1));const main=entry.clips.find(c=>c.content.kind==='video')!.speed!;expect(main.kind==='main'&&main.override).toEqual(r(2));
 const actual=restore(speed(registered,4)),expected=speed(register(original),4);expect(actual.sequenceEndFrame).toBe(expected.sequenceEndFrame);for(let f=0;f<expected.sequenceEndFrame;f++)expect(sample(actual,f)).toEqual(sample(expected,f));
});
it('retains explicit group order through registration and restores two adjacent cuts',()=>{
 const d=register(cut(cut(fixture()),30,40));expect(d.cutArchive!.groups).toHaveLength(1);let next=d;while(next.cutArchive?.entries.length)next=restore(next);expect(next.sequenceEndFrame).toBe(120);for(let f=0;f<120;f++)expect(sample(next,f)).toEqual(sample(fixture(),f));
});

it('keeps live video-only registration valid after unlinking saved AV, without assigning the old band',()=>{
 const cutDoc=cut(fixture());const unlinked=applySequenceCommand(cutDoc,{type:'unlink',clipIds:cutDoc.clips.filter(c=>c.content.kind==='video').map(c=>c.id)});
 const before=serializeSequence(unlinked),archive=structuredClone(unlinked.cutArchive);
 const result=applySequenceCommand(unlinked,{type:'register-native-speed',groupId:'video-only',mainClipIds:unlinked.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:[]});
 expect(result.speed?.groupId).toBe('video-only');expect(result.clips.filter(c=>c.content.kind==='video').every(c=>c.speed?.kind==='main')).toBe(true);
 expect(result.clips.filter(c=>c.content.kind==='audio').every(c=>!c.speed)).toBe(true);expect(result.cutArchive).toEqual(archive);expect(serializeSequence(unlinked)).toBe(before);
 expect(()=>restore(result)).toThrow('速度登録');
});

import {readCutBoundaryGroup} from './cutBoundary';
function sameFrames(actual:SequenceDocument,expected:SequenceDocument){expect(actual.sequenceEndFrame).toBe(expected.sequenceEndFrame);for(let f=0;f<expected.sequenceEndFrame;f++)expect(sample(actual,f),'frame '+f).toEqual(sample(expected,f));}
it.each(['start','end'] as const)('shrinks and extends the attached v2-operations %s edge, then restores its group at another rate',edge=>{
 const original=fixture();let d=speed(register(cut(original)),4),entry=d.cutArchive!.entries[0]!;
 expect(entry.clips.some(c=>!!c.speed?.operationBasis)).toBe(true);expect(d.clips.some(c=>!!c.speed?.operationBasis)).toBe(true);
 d=applySequenceCommand(d,{type:'resize-cut-boundary',cut:{kind:'entry',id:entry.id},edge,target:{kind:'archived',entryId:entry.id,localFrame:edge==='start'?10:20}});
 expect(d.sequenceEndFrame).toBe(50);expect(d.cutArchive!.entries[0]!.durationFrames).toBe(20);
 let group=readCutBoundaryGroup(d,{kind:'entry',id:d.cutArchive!.entries[0]!.id});
 const live=d.clips.find(c=>c.content.kind==='video'&&group.adjacentLive[edge].includes(c.id))!;
 d=applySequenceCommand(d,{type:'resize-cut-boundary',cut:group.cut,edge,target:{kind:'live',clipId:live.id,frame:group.frame!+(edge==='start'?-5:5)}});
 group=readCutBoundaryGroup(d,{kind:'group',id:d.cutArchive!.groups![0]!.id});
 expect(group.entries.map(e=>e.entry.durationFrames)).toEqual(edge==='start'?[5,20]:[20,5]);
 expect(group.entries.map(e=>e.entry.speed!.globalRate)).toEqual(edge==='start'?[r(4),r(2)]:[r(2),r(4)]);
 d=speed(parseSequence(serializeSequence(d)),1);const target=group.entries[edge==='start'?group.entries.length-1:0]!.entry;
 d=applySequenceCommand(d,{type:'resize-cut-boundary',cut:group.cut,edge,target:{kind:'archived',entryId:target.id,localFrame:edge==='start'?target.durationFrames:0}});
 expect(d.cutArchive).toBeUndefined();sameFrames(d,speed(register(original),1));
});
it.each(['before','after'] as const)('keeps a later adjacent %s cut ordered after attaching archived registration',side=>{
 const original=fixture();let d=speed(register(cut(original)),4);
 d=cut(d,side==='before'?10:15,side==='before'?15:20);
 let group=readCutBoundaryGroup(d,{kind:'group',id:d.cutArchive!.groups![0]!.id});
 expect(group.entries.map(e=>e.entry.durationFrames)).toEqual(side==='before'?[5,30]:[30,5]);
 d=parseSequence(serializeSequence(d));const target=group.entries.at(-1)!.entry;
 d=applySequenceCommand(d,{type:'resize-cut-boundary',cut:group.cut,edge:'start',target:{kind:'archived',entryId:target.id,localFrame:target.durationFrames}});
 expect(d.cutArchive).toBeUndefined();sameFrames(d,speed(register(original),4));
});
