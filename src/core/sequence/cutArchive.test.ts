import {expect,it} from 'vitest';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {type SequenceDocument,effectFrameAt,sourceTimeAt} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence,validateSequenceDocument} from './validate';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}
const cut=(d:SequenceDocument,a=30,b=60)=>applySequenceCommand(d,{type:'ripple-delete',startFrame:a,endFrame:b});
const restore=(d:SequenceDocument,range?:{startFrame:number;endFrame:number},atFrame?:number)=>applySequenceCommand(d,{type:'restore-cut',entryId:d.cutArchive!.entries[0]!.id,...(range?{range}:{}),...(atFrame===undefined?{}:{atFrame})} as SequenceCommand);
const sample=(d:SequenceDocument,at:number)=>d.clips.filter(c=>c.startFrame<=at&&at<c.startFrame+c.durationFrames).map(c=>({kind:c.content.kind,track:c.trackId,clock:effectFrameAt(c,at),source:c.content.kind==='video'||c.content.kind==='audio'?sourceTimeAt(c,at,d.fps):null,text:c.content.kind==='telop'?c.content.data.text:null})).sort((a,b)=>a.track.localeCompare(b.track));
it('saves deleted AV/source captions and restores every original source/effect sample after reload',()=>{const original=fixture(),before=structuredClone(original),d=cut(original);expect(d.cutArchive?.entries).toHaveLength(1);expect(d.cutArchive!.entries[0]!.durationFrames).toBe(30);const restored=restore(parseSequence(serializeSequence(d)));expect(restored.sequenceEndFrame).toBe(120);expect(restored.cutArchive?.entries??[]).toHaveLength(0);validateSequenceDocument(restored);for(let f=0;f<120;f++)expect(sample(restored,f)).toEqual(sample(original,f));expect(original).toEqual(before);});
it('preserves unrelated current caption edits while restoring a middle portion and both remaining bands',()=>{let d=cut(fixture());const right=d.clips.find(c=>c.content.kind==='telop'&&c.startFrame===30)!;d=applySequenceCommand(d,{type:'update-clip',clipId:right.id,patch:{content:{kind:'telop',data:{text:'後から直した本文'}}}});d=restore(d,{startFrame:10,endFrame:20});expect(d.cutArchive!.entries).toHaveLength(2);expect(d.sequenceEndFrame).toBe(100);expect(d.clips.some(c=>c.content.kind==='telop'&&c.content.data.text==='後から直した本文')).toBe(true);while(d.cutArchive?.entries.length)d=restore(d);expect(d.sequenceEndFrame).toBe(120);expect(d.clips.find(c=>c.content.kind==='telop'&&c.startFrame===60)?.content).toMatchObject({data:{text:'後から直した本文'}});});
it('keeps a failed batch atomic with archive changes',()=>{const d=fixture(),before=serializeSequence(d);expect(()=>applySequenceCommand(d,{type:'batch',commands:[{type:'ripple-delete',startFrame:30,endFrame:60},{type:'remove-track',trackId:'v'}]})).toThrow();expect(serializeSequence(d)).toBe(before);});
it('preserves registered speed and anchored caption clocks through cut/save/full restore',()=>{const original=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});const d=cut(original);expect(d.cutArchive?.entries).toHaveLength(1);const restored=restore(parseSequence(serializeSequence(d)));expect(restored.speed).toBeDefined();validateSequenceDocument(restored);for(let f=0;f<120;f++)expect(sample(restored,f)).toEqual(sample(original,f));});
import {resolveCutBoundary} from './cutArchive';
it('follows both surviving boundary sides after a linked move',()=>{let d=cut(fixture());d=applySequenceCommand(d,{type:'move',clipIds:d.clips.filter(c=>c.content.kind!=='telop').map(c=>c.id),deltaFrames:10});expect(resolveCutBoundary(d,d.cutArchive!.entries[0]!)).toEqual({frame:40});const next=restore(d);expect(next.sequenceEndFrame).toBe(130);for(let f=10;f<130;f++)expect(sample(next,f)).toEqual(sample(fixture(),f-10));});
it('requires an explicit position when only one boundary moves',()=>{let d=cut(fixture());d=applySequenceCommand(d,{type:'move',clipIds:[d.clips.find(c=>c.content.kind==='video'&&c.startFrame===30)!.id],deltaFrames:5,linked:false});expect(resolveCutBoundary(d,d.cutArchive!.entries[0]!).frame).toBeNull();expect(()=>restore(d)).toThrow('境界');expect(()=>restore(d,undefined,30)).not.toThrow();});
it('restores successive cuts without confusing reused source occurrences',()=>{const original=fixture();original.sequenceEndFrame=240;original.clips.push(...structuredClone(original.clips).map(c=>({...c,id:c.id+'-again',startFrame:c.startFrame+120,linkGroupId:c.linkGroupId?'again':undefined,...(c.anchor?.kind==='source'?{anchor:{...c.anchor,clipOccurrenceId:'a1-again'}}:{})})));let d=cut(cut(original),130,150);while(d.cutArchive?.entries.length)d=restore(d);expect(d.sequenceEndFrame).toBe(240);for(let f=0;f<240;f++)expect(sample(d,f)).toEqual(sample(original,f));});
it('restores removed tracks and refuses reuse of archived clip and track identities',()=>{let d=cut(fixture(),0,120);d=applySequenceCommand(d,{type:'remove-track',trackId:'v'});expect(()=>applySequenceCommand(d,{type:'add-track',track:{id:'v',kind:'visual',name:'別トラック',enabled:true}})).toThrow();expect(()=>applySequenceCommand(d,{type:'insert',clips:[fixture().clips[0]!]})).toThrow();const next=restore(d);expect(next.tracks.find(t=>t.id==='v')).toEqual(fixture().tracks[0]);for(let f=0;f<120;f++)expect(sample(next,f)).toEqual(sample(fixture(),f));});
it('rejects a consumed entry and keeps failed restore batch byte-identical',()=>{const d=cut(fixture()),entryId=d.cutArchive!.entries[0]!.id,bytes=serializeSequence(d);expect(()=>applySequenceCommand(d,{type:'batch',commands:[{type:'restore-cut',entryId},{type:'remove-track',trackId:'v'}]})).toThrow();expect(serializeSequence(d)).toBe(bytes);const next=restore(d);expect(()=>applySequenceCommand(next,{type:'restore-cut',entryId})).toThrow('見つかりません');});
it('restores partial registered speed bands without dropping the current speed ledger',()=>{const original=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});let d=restore(cut(original),{startFrame:10,endFrame:20});validateSequenceDocument(d);while(d.cutArchive?.entries.length)d=restore(parseSequence(serializeSequence(d)));for(let f=0;f<120;f++)expect(sample(d,f)).toEqual(sample(original,f));expect(d.clips.some(c=>c.speed?.captions?.length)).toBe(true);});
it('retains registered insert-own speed, source exposure and completion after restore',()=>{const input=fixture();delete input.clips[2]!.anchor;const original=applySequenceCommand(input,{type:'register-native-insert-own-speed',clipId:'v1',linked:true});const next=restore(cut(original));validateSequenceDocument(next);expect(next.clips.filter(c=>c.insertOwnSpeed).length).toBeGreaterThan(1);expect(next.sequenceEndFrame).toBe(original.sequenceEndFrame);for(let f=0;f<120;f++)expect(sample(next,f)).toEqual(sample(original,f));});
it('validates archived clocks, source references and explicit restore bounds on load',()=>{const d=cut(fixture());for(const mutate of [(x:SequenceDocument)=>x.cutArchive!.entries[0]!.clips[0]!.clock.rate.num=0,(x:SequenceDocument)=>x.cutArchive!.entries[0]!.clips[0]!.trackId='missing',(x:SequenceDocument)=>x.cutArchive!.entries[0]!.durationFrames=1]){const x=structuredClone(d);mutate(x);expect(()=>parseSequence(JSON.stringify(x))).toThrow();}expect(()=>restore(d,{startFrame:0,endFrame:31})).toThrow();expect(()=>restore(d,undefined,999)).toThrow();});
it('retains fractional operation-speed evaluation and remains speed-editable after partial/full restore',()=>{const input=fixture();for(const c of input.clips)if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(3,2);input.clips[2]!.anchor={kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(6)};let original=applySequenceCommand(input,{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});original=applySequenceCommand(original,{type:'upgrade-native-speed-operations'});let d=restore(cut(original,17,46),{startFrame:3,endFrame:18});while(d.cutArchive?.entries.length)d=restore(parseSequence(serializeSequence(d)));for(let f=0;f<120;f++)expect(sample(d,f)).toEqual(sample(original,f));expect(d.clips.some(c=>c.speed?.operationBasis)).toBe(true);expect(()=>applySequenceCommand(d,{type:'set-native-global-speed',rate:r(2)})).not.toThrow();});
it('preserves archived payload while rebinding its known boundary after global speed changes',()=>{let d=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});d=cut(d);const archive=structuredClone(d.cutArchive);d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});const bytes=serializeSequence(d);expect(d.cutArchive!.entries.map(({boundary,...saved})=>saved)).toEqual(archive!.entries.map(({boundary,...saved})=>saved));expect(d.cutArchive!.entries[0]!.boundary.hintFrame).toBe(60);expect(restore(d).sequenceEndFrame).toBe(240);expect(serializeSequence(d)).toBe(bytes);});
it('keeps an empty cut band and restores duration without creating clips',()=>{const d=fixture();d.clips=[];const next=restore(cut(d));expect(next.clips).toEqual([]);expect(next.sequenceEndFrame).toBe(120);});
it('does not remap a user data id/text that happens to match an archived clip identity',()=>{const d=fixture();d.clips[2]!.content={kind:'telop',data:{text:'v1',custom:{id:'v1',providerId:'a1'}}} as never;const next=restore(cut(d));expect(next.clips.filter(c=>c.content.kind==='telop').every(c=>JSON.stringify(c.content)===JSON.stringify(d.clips[2]!.content))).toBe(true);});
it('rejects malformed archive records with domain errors, including unknown nested keys',()=>{
 const mutations=[(e:any)=>e.origin.extra=true,(e:any)=>e.boundary.extra=true,(e:any)=>e.boundary.references[0].extra=true,(e:any)=>e.clips[0]=null];
 for(const mutate of mutations){const d=cut(fixture());mutate(d.cutArchive!.entries[0]);expect(()=>parseSequence(JSON.stringify(d))).toThrow(SequenceError);}
});
it('requires an explicit position for an unanchored empty cut after reordering',()=>{
 const input=fixture();input.clips=[];let d=cut(input);d=applySequenceCommand(d,{type:'reorder-ranges',ranges:[{startFrame:45,endFrame:90},{startFrame:0,endFrame:45}]});
 expect(resolveCutBoundary(d,d.cutArchive!.entries[0]!).frame).toBeNull();expect(()=>restore(d)).toThrow('境界');expect(restore(d,undefined,20).sequenceEndFrame).toBe(120);
});
it('restores the completion floor of an own-speed timeline with an empty tail',()=>{
 const input=fixture();input.clips=input.clips.slice(0,2);input.sequenceEndFrame=150;
 const original=applySequenceCommand(input,{type:'register-native-insert-own-speed',clipId:'v1',linked:true});
 const next=restore(cut(original,125,145));expect(next.sequenceEndFrame).toBe(150);expect(next.insertOwnSpeed!.endFloor).toBe(original.insertOwnSpeed!.endFloor);
});
it('restores an entire own-speed occurrence after its metadata left the live graph',()=>{
 const input=fixture();input.clips=input.clips.slice(0,2);const original=applySequenceCommand(input,{type:'register-native-insert-own-speed',clipId:'v1',linked:true});
 const d=cut(original,0,120);expect(d.insertOwnSpeed).toBeUndefined();const next=restore(parseSequence(serializeSequence(d)));expect(next.insertOwnSpeed).toBeDefined();for(let f=0;f<120;f++)expect(sample(next,f)).toEqual(sample(original,f));
});
it('does not turn a restored insert-own extension into the ordinary completion floor',()=>{
 const input=fixture();input.clips=input.clips.slice(0,2);let original=applySequenceCommand(input,{type:'register-native-insert-own-speed',clipId:'v1',linked:true});
 original=applySequenceCommand(original,{type:'set-native-insert-own-speed',clipId:'v1',rate:r(1),linked:true});expect(original.sequenceEndFrame).toBe(240);expect(original.insertOwnSpeed!.endFloor).toBe(120);
 let d=restore(cut(original,100,160),{startFrame:10,endFrame:30});while(d.cutArchive?.entries.length)d=restore(d);
 expect(d.sequenceEndFrame).toBe(240);expect(d.insertOwnSpeed!.endFloor).toBe(120);for(let f=0;f<240;f++)expect(sample(d,f)).toEqual(sample(original,f));
});
it('restores a removed overriding-speed owner with exact per-frame clocks',()=>{
 const input=fixture();input.sequenceEndFrame=240;input.clips.push(...structuredClone(input.clips).map(c=>({...c,id:c.id+'-again',startFrame:120,linkGroupId:c.linkGroupId?'again':undefined,...(c.anchor?.kind==='source'?{anchor:{...c.anchor,clipOccurrenceId:'a1-again'}}:{})})));
 let original=applySequenceCommand(input,{type:'register-native-speed',groupId:'speed',mainClipIds:['v1','v1-again'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'},{audioClipId:'a1-again',providerId:'v1-again'}]});
 original=applySequenceCommand(original,{type:'set-native-main-speed',clipId:'v1-again',rate:r(4)});const last=original.clips.find(c=>c.id==='v1-again')!;
 const next=restore(cut(original,last.startFrame,last.startFrame+last.durationFrames));expect(next.sequenceEndFrame).toBe(original.sequenceEndFrame);for(let f=0;f<original.sequenceEndFrame;f++)expect(sample(next,f)).toEqual(sample(original,f));
});
import {SequenceError} from './errors';
import {SequenceSession} from './session';
import {buildFinishDisplayMap} from '../../app/native/finishDisplayMap';
it('keeps the exact reported caption-only consecutive deletion visible as one ordered band',()=>{
 const original=fixture();original.clips=[original.clips[2]!];original.clips[0]!.durationFrames=180;original.clips[0]!.clock.duration=r(180);delete original.clips[0]!.anchor;original.sequenceEndFrame=180;
 const a=cut(original,60,90),b=cut(a,60,75),ids=b.cutArchive!.entries.map(e=>e.id);
 expect(b.cutArchive!.groups?.[0]!.entryIds).toEqual(ids);expect(buildFinishDisplayMap(b).cuts).toHaveLength(1);expect(buildFinishDisplayMap(b).unresolved).toEqual([]);
 expect(buildFinishDisplayMap(b).cuts[0]).toMatchObject({start:60,end:105});
});
it.each(['left','right'] as const)('orders a consecutive %s cut and retains AV/text/source clocks after partial restore/save',side=>{
 const original=fixture(),a=cut(original),first=a.cutArchive!.entries[0]!.id,b=side==='right'?cut(a,30,45):cut(a,15,30),second=b.cutArchive!.entries.find(e=>e.id!==first)!.id;
 expect(b.cutArchive!.groups?.[0]!.entryIds).toEqual(side==='right'?[first,second]:[second,first]);
 const saved=parseSequence(serializeSequence(b)),after=applySequenceCommand(saved,{type:'restore-cut',entryId:second,range:{startFrame:3,endFrame:10}});
 expect(buildFinishDisplayMap(after).unresolved).toEqual([]);let restored=after;while(restored.cutArchive?.entries.length)restored=restore(restored);
 expect(restored.sequenceEndFrame).toBe(120);for(let f=0;f<120;f++)expect(sample(restored,f)).toEqual(sample(original,f));
});
it('joins two previously separate ordered boundary bands around the newly removed live interval',()=>{
 const original=fixture(),a=cut(original,30,40),first=a.cutArchive!.entries[0]!.id,b=cut(a,70,80),second=b.cutArchive!.entries.find(e=>e.id!==first)!.id;
 const c=cut(b,30,70),added=c.cutArchive!.entries.find(e=>![first,second].includes(e.id))!.id;
 expect(c.cutArchive!.groups?.[0]!.entryIds).toEqual([first,added,second]);expect(buildFinishDisplayMap(c).unresolved).toEqual([]);
 let restored=c;while(restored.cutArchive?.entries.length)restored=restore(restored);for(let f=0;f<120;f++)expect(sample(restored,f)).toEqual(sample(original,f));
});
it('splits a new band around a known interior archived seam instead of guessing or losing its order',()=>{
 const original=fixture(),a=cut(original,30,40),old=a.cutArchive!.entries[0]!.id,b=cut(a,20,50),ordered=b.cutArchive!.groups![0]!.entryIds.map(id=>b.cutArchive!.entries.find(e=>e.id===id)!);
 expect(ordered.map(e=>e.id===old?'old':e.durationFrames)).toEqual([10,'old',20]);expect(buildFinishDisplayMap(b).cuts[0]).toMatchObject({start:20,end:60});expect(buildFinishDisplayMap(b).unresolved).toEqual([]);
 let restored=parseSequence(serializeSequence(b));while(restored.cutArchive?.entries.length)restored=restore(restored);for(let f=0;f<120;f++)expect(sample(restored,f)).toEqual(sample(original,f));
});
it('preserves unrelated current settings and makes each consecutive cut one undoable operation',()=>{
 const original=fixture(),session=new SequenceSession('adjacent',original);const execute=(command:SequenceCommand|{type:'undo'}|{type:'redo'})=>session.execute({sessionId:'adjacent',expectedRevision:session.document.revision,executionId:`step-${session.document.revision}`,command});
 execute({type:'ripple-delete',startFrame:30,endFrame:60});const first=serializeSequence(session.document);
 execute({type:'ripple-delete',startFrame:30,endFrame:45});const second=sequenceContentForTest(session.document);
 execute({type:'undo'});expect(sequenceContentForTest(session.document)).toEqual(sequenceContentForTest(parseSequence(first)));execute({type:'redo'});expect(sequenceContentForTest(session.document)).toEqual(second);
 const current=session.document,caption=current.clips.find(c=>c.content.kind==='telop'&&c.startFrame>0)!;
 let edited=applySequenceCommand(current,{type:'update-clip',clipId:caption.id,patch:{content:{kind:'telop',data:{text:'後の編集'}}}});const audio=edited.clips.find(c=>c.content.kind==='audio'&&c.startFrame>0)!;if(audio.content.kind==='audio')edited=applySequenceCommand(edited,{type:'update-clip',clipId:audio.id,patch:{content:{...audio.content,settings:{...audio.content.settings,gainDb:-8}}}});while(edited.cutArchive?.entries.length)edited=restore(edited);
 expect(edited.clips.some(c=>c.content.kind==='telop'&&c.content.data.text==='後の編集')).toBe(true);expect(edited.clips.filter(c=>c.content.kind==='audio').every(c=>c.content.kind==='audio'&&c.content.settings.gainDb===(c.startFrame>=75?-8:0))).toBe(true);
});
function sequenceContentForTest(d:SequenceDocument){const {revision,...rest}=d;return rest;}
it('does not infer the order of independent old records at one seam',()=>{
 const d=cut(fixture()),other=structuredClone(d.cutArchive!.entries[0]!);other.id='independent-cut';other.origin.cutId=other.id;d.cutArchive!.entries.push(other);validateSequenceDocument(d);
 const next=cut(d,30,45);expect(next.cutArchive!.groups).toBeUndefined();expect(buildFinishDisplayMap(next).cuts).toEqual([]);expect(buildFinishDisplayMap(next).unresolved.every(e=>e.code==='unknown-order')).toBe(true);
});
it('keeps each saved-band unit while a later cut spans an old seam after global speed changes',()=>{
 const original=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'speed',mainClipIds:['v1'],mainAudioBindings:[{audioClipId:'a1',providerId:'v1'}]});
 let d=cut(original,30,60);const old=d.cutArchive!.entries[0]!.id;d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});d=cut(d,40,80);
 const group=d.cutArchive!.groups![0]!,members=group.entryIds.map(id=>d.cutArchive!.entries.find(e=>e.id===id)!);expect(members.map(e=>e.durationFrames)).toEqual([20,30,20]);expect(members[1]!.id).toBe(old);expect(buildFinishDisplayMap(d).unresolved).toEqual([]);
 const expected=applySequenceCommand(original,{type:'set-native-global-speed',rate:r(1)});while(d.cutArchive?.entries.length)d=restore(parseSequence(serializeSequence(d)));
 expect(d.sequenceEndFrame).toBe(expected.sequenceEndFrame);for(let f=0;f<d.sequenceEndFrame;f++)expect(sample(d,f)).toEqual(sample(expected,f));
});
