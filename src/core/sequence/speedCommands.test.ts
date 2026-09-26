import {operationBasis} from './speedOperationBasis';
import {captionInputDigest} from './speedCaptionLedger';
import {parseSequence,serializeSequence} from './validate';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
import {describe,it,expect} from 'vitest';
import {applySequenceCommand} from './commands';
import {rational as r} from './time';
import {type SequenceDocument,DEFAULT_TEXT_APPEARANCE} from './model';
import {validateSequenceDocument,sequenceContentBytes} from './validate';
function fixture():SequenceDocument {
  return {schemaVersion:2,id:'split-test',name:'split',revision:0,fps:r(1),resolution:{width:640,height:360},sequenceEndFrame:4,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],
    assets:[{id:'asset',kind:'media',file:'media/test.mp4',name:'test',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),width:640,height:360,frameRate:r(1)},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],
    clips:[{id:'video',trackId:'v',name:'video',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-1),rate:r(1),duration:r(20)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(2)}},
      {id:'audio',trackId:'a',name:'audio',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-3),rate:r(3),duration:r(40)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
      {id:'caption',trackId:'t',name:'caption',startFrame:1,durationFrames:2,clock:{offset:r(0),rate:r(1),duration:r(2)},content:{kind:'telop',data:{text:'保持'},appearance:{...DEFAULT_TEXT_APPEARANCE}},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(2),sourceEnd:r(6)}}],transitions:[]};
}

function registered(input = fixture()): SequenceDocument {
  return applySequenceCommand(applySequenceCommand(input, {type:'register-native-speed',groupId:'group',mainClipIds:['video'],
    mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]}), {type:'upgrade-native-speed'});
}

const content=(d:SequenceDocument)=>sequenceContentBytes({...d,revision:0});
describe('native speed document commands',()=>{
 it('changes the complete document and returns exactly to the explicitly upgraded basis',()=>{
  const input=applySequenceCommand(registered(),{type:'upgrade-native-speed-operations'}),bytes=content(input);
  const slow=applySequenceCommand(input,{type:'set-native-global-speed',rate:r(1)});
  expect(slow.sequenceEndFrame).toBe(8);expect(slow.clips.map(c=>[c.id,c.startFrame,c.durationFrames])).toEqual([['video',0,8],['audio',0,8],['caption',2,4]]);
  expect(content(input)).toBe(bytes);expect(content(applySequenceCommand(slow,{type:'set-native-global-speed',rate:r(2)}))).toBe(bytes);
 });
 it('preserves an explicit equal override until reset removes it',()=>{
  let d=applySequenceCommand(registered(),{type:'set-native-main-speed',clipId:'video',rate:r(2)});expect(d.clips[0]!.speed).toMatchObject({override:r(2)});
  d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});expect(d.clips[0]!.durationFrames).toBe(4);
  d=applySequenceCommand(d,{type:'reset-native-main-speed',clipId:'video'});expect(d.clips[0]!.speed).not.toHaveProperty('override');expect(d.clips[0]!.durationFrames).toBe(8);
 });
 it('separates a child override while retaining saved source intent and exact reset',()=>{
  const split=applySequenceCommand(registered(),{type:'split',clipIds:['video'],frame:1,linked:true});
  const initial=applySequenceCommand(split,{type:'upgrade-native-speed-operations'}),child=initial.clips.find(c=>c.content.kind==='video'&&c.startFrame===1)!;
  const fast=applySequenceCommand(initial,{type:'set-native-main-speed',clipId:child.id,rate:r(4)});validateSequenceDocument(fast);
  const changed=fast.clips.find(c=>c.id===child.id)!;expect(changed.startFrame).toBe(1);expect(changed.durationFrames).toBe(1);expect(changed.content).toMatchObject({sourceIn:r(4),rate:r(4)});expect(changed.speed?.source).toEqual(child.speed!.source);
  expect(content(applySequenceCommand(fast,{type:'reset-native-main-speed',clipId:child.id}))).toBe(content(initial));
 });
 it('rejects all-zero logical text without changing any input or revision',()=>{
  const d=registered(),before=content(d),rev=d.revision;expect(()=>applySequenceCommand(d,{type:'set-native-global-speed',rate:r(16)})).toThrow();expect(content(d)).toBe(before);expect(d.revision).toBe(rev);
 });
 it.each([r(1,10),r(33,100),r(34,25),r(3),r(16)])('keeps full supported rate %j with no zero text constraint',rate=>{
  const raw=fixture();raw.clips=raw.clips.filter(c=>c.id!=='caption');const d=applySequenceCommand(registered(raw),{type:'upgrade-native-speed-operations'});
  const changed=applySequenceCommand(d,{type:'set-native-global-speed',rate});validateSequenceDocument(changed);expect(content(applySequenceCommand(changed,{type:'set-native-global-speed',rate:r(2)}))).toBe(content(d));
 });
});

describe('speed operation basis across later ordinary editing',()=>{
 it.each(['split','trim','move','delete','ripple','reorder','name'] as const)('retains variable piece clocks and later rate roundtrip after %s',kind=>{
  const raw=fixture();raw.sequenceEndFrame=20;raw.clips=raw.clips.filter(c=>c.id!=='caption').map(c=>({...c,durationFrames:20}));
  let d=applySequenceCommand(registered(raw),{type:'split',clipIds:['video'],frame:4,linked:true});const child=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===4)!;
  d=applySequenceCommand(d,{type:'set-native-main-speed',clipId:child.id,rate:r(4)});
  if(kind==='split')d=applySequenceCommand(d,{type:'split',clipIds:[child.id],frame:6,linked:true});
  if(kind==='trim')d=applySequenceCommand(d,{type:'trim',clipId:child.id,edge:'start',frame:5,linked:true});
  if(kind==='move')d=applySequenceCommand(d,{type:'move',clipIds:[child.id],deltaFrames:2,linked:true});
  if(kind==='delete')d=applySequenceCommand(d,{type:'delete',clipIds:['video'],linked:true});
  if(kind==='ripple')d=applySequenceCommand(d,{type:'ripple-delete',startFrame:0,endFrame:2});
  if(kind==='reorder')d=applySequenceCommand(d,{type:'reorder-ranges',ranges:[{startFrame:4,endFrame:12},{startFrame:0,endFrame:4}]});
  if(kind==='name')d=applySequenceCommand(d,{type:'update-clip',clipId:child.id,patch:{name:'編集後'}});
  validateSequenceDocument(d);const before=content(d);const changed=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});expect(content(applySequenceCommand(changed,{type:'set-native-global-speed',rate:r(2)}))).toBe(before);
 });
});

it('restores several simultaneous latent parts in their exact reserved slots around fixed clips',()=>{
 const raw=fixture(),caption=raw.clips.find(c=>c.id==='caption')!;raw.sequenceEndFrame=20;for(const c of raw.clips)if(c.content.kind!=='telop')c.durationFrames=20;
 caption.startFrame=9;caption.durationFrames=3;caption.clock.duration=r(3);if(caption.anchor?.kind==='source'){caption.anchor.sourceStart=r(18);caption.anchor.sourceEnd=r(24);}
 raw.tracks.push({id:'t2',kind:'visual',name:'字幕2',enabled:true},{id:'f',kind:'visual',name:'固定',enabled:true});
 raw.clips.push({...structuredClone(caption),id:'caption2',trackId:'t2'});
 let d=applySequenceCommand(registered(raw),{type:'split',clipIds:['video'],frame:10,linked:true});
 const text=d.clips.filter(c=>c.content.kind==='telop');expect(text).toHaveLength(4);
 const fixed={...structuredClone(text[0]!),id:'fixed',trackId:'f',name:'固定',anchor:{kind:'timeline' as const}};delete fixed.continuationGroupId;
 d.clips.splice(d.clips.indexOf(text[1]!),0,fixed);validateSequenceDocument(d);
 d=applySequenceCommand(d,{type:'upgrade-native-speed-operations'});const before=content(d),ids=d.clips.map(c=>c.id);
 const fast=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(4)});expect(fast.clips.filter(c=>text.some(t=>t.id===c.id))).toHaveLength(2);expect(fast.clips.find(c=>c.id==='fixed')).toEqual(fixed);
 const restored=applySequenceCommand(fast,{type:'set-native-global-speed',rate:r(2)});expect(restored.clips.map(c=>c.id)).toEqual(ids);expect(content(restored)).toBe(before);
});

it('projects saved scene color and both single-clip fades and restores all temporal fields',()=>{
 const raw=fixture();raw.sequenceEndFrame=20;raw.clips=raw.clips.filter(c=>c.id!=='caption').map(c=>({...c,durationFrames:20}));
 raw.tracks.push({id:'color',kind:'visual',name:'色面',enabled:true});
 raw.clips.push({id:'color-clip',trackId:'color',name:'冒頭',startFrame:0,durationFrames:6,clock:{offset:r(0),rate:r(1),duration:r(6)},content:{kind:'scene-fade',phase:'head',color:'#000000'}});
 raw.transitions=[{id:'fade-in',trackId:'v',outClipId:'video',kind:'fadeBlack',edge:'in',startFrame:0,durationFrames:4},{id:'fade-out',trackId:'v',outClipId:'video',kind:'fadeWhite',edge:'out',startFrame:16,durationFrames:4}];
 const d=applySequenceCommand(registered(raw),{type:'upgrade-native-speed-operations'}),before=content(d);
 const slow=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});
 expect(slow.clips.find(c=>c.id==='color-clip')).toMatchObject({startFrame:0,durationFrames:12,clock:{offset:r(0),rate:r(1,2),duration:r(6)}});
 expect(slow.transitions.map(t=>[t.startFrame,t.durationFrames])).toEqual([[0,8],[32,8]]);
 expect(content(applySequenceCommand(slow,{type:'set-native-global-speed',rate:r(2)}))).toBe(before);
});

it('splits a color curve at a changed main rate and merges it to its original ID after reset',()=>{
 const raw=fixture();raw.sequenceEndFrame=20;raw.clips=raw.clips.filter(c=>c.id!=='caption').map(c=>({...c,durationFrames:20}));raw.tracks.push({id:'color',kind:'visual',name:'色面',enabled:true});
 raw.clips.push({id:'color-clip',trackId:'color',name:'接続',startFrame:2,durationFrames:12,clock:{offset:r(0),rate:r(1),duration:r(12)},content:{kind:'scene-fade',phase:'join',color:'#ffffff'}});
 let d=applySequenceCommand(registered(raw),{type:'split',clipIds:['video'],frame:8,linked:true});const child=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===8)!;
 d=applySequenceCommand(d,{type:'upgrade-native-speed-operations'});const before=content(d);
 const faster=applySequenceCommand(d,{type:'set-native-main-speed',clipId:child.id,rate:r(4)}),colors=faster.clips.filter(c=>c.content.kind==='scene-fade');
 expect(colors.map(c=>[c.startFrame,c.durationFrames,c.clock.offset,c.clock.rate])).toEqual([[2,6,r(0),r(1)],[8,3,r(6),r(2)]]);
 expect(content(applySequenceCommand(faster,{type:'reset-native-main-speed',clipId:child.id}))).toBe(before);
});

it.each(['split','trim','move','delete-owner','delete-all','ripple','reorder','name','color','new-color'] as const)('keeps color intent through ordinary %s without changing canonical results',kind=>{
 const raw=fixture();raw.sequenceEndFrame=20;raw.clips=raw.clips.filter(c=>c.id!=='caption').map(c=>({...c,durationFrames:20}));raw.tracks.push({id:'color',kind:'visual',name:'色面',enabled:true});
 raw.clips.push({id:'color-clip',trackId:'color',name:'色面',startFrame:2,durationFrames:12,clock:{offset:r(-2),rate:r(1),duration:r(20)},content:{kind:'scene-fade',phase:'join',color:'#ffffff'}});
 let d=applySequenceCommand(registered(raw),{type:'split',clipIds:['video'],frame:8,linked:true});
 d=applySequenceCommand(d,{type:'upgrade-native-speed-operations'});
 const command:Parameters<typeof applySequenceCommand>[1]=kind==='split'?{type:'split',clipIds:['video'],frame:6,linked:true}:kind==='trim'?{type:'trim',clipId:'color-clip',edge:'start',frame:4,linked:false}:kind==='move'?{type:'move',clipIds:['color-clip'],deltaFrames:1,linked:false}:kind==='delete-owner'?{type:'delete',clipIds:['video'],linked:true}:kind==='delete-all'?{type:'delete',clipIds:d.clips.filter(c=>c.content.kind==='video').map(c=>c.id),linked:true}:kind==='ripple'?{type:'ripple-delete',startFrame:0,endFrame:1}:kind==='reorder'?{type:'reorder-ranges',ranges:[{startFrame:14,endFrame:20},{startFrame:0,endFrame:14}]}:kind==='name'?{type:'update-clip',clipId:'color-clip',patch:{name:'変更'}}:kind==='color'?{type:'update-clip',clipId:'color-clip',patch:{content:{kind:'scene-fade',phase:'join',color:'#ff0000'}}}:{type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true,durationFrames:2,color:'#000000'}};
 const ordinary=structuredClone(d);delete ordinary.speed;for(const c of ordinary.clips)delete c.speed;
 const expected=applySequenceCommand(ordinary,command);d=applySequenceCommand(d,command);validateSequenceDocument(d);
 const stripped=structuredClone(d);delete stripped.speed;for(const c of stripped.clips)delete c.speed;
 // Historical archive metadata differs between registered and ordinary sources.
 // Preserve every existing live presentation assertion; archive clocks have their own gate.
 const expectedVisible=structuredClone(expected);delete stripped.cutArchive;delete expectedVisible.cutArchive;expect(content(stripped)).toBe(content(expectedVisible));
 if(d.clips.some(c=>c.speed?.kind==='main')){const before=content(d),slow=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});expect(content(applySequenceCommand(slow,{type:'set-native-global-speed',rate:r(2)}))).toBe(before);}
 else expect(()=>applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)})).toThrow(/主映像/);
});


it('uses one Undo for upgrade+speed, stable replay, Store reload and atomic failed batches',()=>{
 const before=registered(),session=new SequenceSession('speed',before),request={sessionId:'speed',expectedRevision:before.revision,executionId:'speed-1',command:{type:'set-native-global-speed' as const,rate:r(1)}};
 const first=session.execute(request);expect(first.document.revision).toBe(before.revision+1);expect(session.execute(request).replayed).toBe(true);
 const directory=mkdtempSync(join(tmpdir(),'native-speed-operation-'));try{
  const store=new SequenceStore(directory),save={expectedSavedRevision:null,executionId:'save-1',document:first.document};store.save(save);expect(store.save(save).replayed).toBe(true);const reloaded=new SequenceStore(directory).load()!.document;expect(reloaded).toEqual(first.document);
  expect(content(applySequenceCommand(reloaded,{type:'set-native-global-speed',rate:r(2)}))).toBe(content(applySequenceCommand(before,{type:'upgrade-native-speed-operations'})));
  const undo=session.execute({sessionId:'speed',expectedRevision:first.document.revision,executionId:'undo',command:{type:'undo'}});expect(content(undo.document)).toBe(content(before));
  const redo=session.execute({sessionId:'speed',expectedRevision:undo.document.revision,executionId:'redo',command:{type:'redo'}});expect(content(redo.document)).toBe(content(first.document));
 }finally{rmSync(directory,{recursive:true,force:true});}
 const failed=new SequenceSession('failed',before);expect(()=>failed.execute({sessionId:'failed',expectedRevision:before.revision,executionId:'failed',command:{type:'batch',commands:[{type:'set-native-global-speed',rate:r(1)},{type:'set-native-global-speed',rate:r(16)}]}})).toThrow();expect(failed.document).toEqual(before);expect(failed.canUndo).toBe(false);
});

function withColor():SequenceDocument {
 const raw=fixture();raw.sequenceEndFrame=20;raw.clips=raw.clips.filter(c=>c.id!=='caption').map(c=>({...c,durationFrames:20}));raw.tracks.push({id:'color',kind:'visual',name:'色面',enabled:true});raw.clips.push({id:'color-clip',trackId:'color',name:'色面',startFrame:2,durationFrames:12,clock:{offset:r(-2),rate:r(1),duration:r(20)},content:{kind:'scene-fade',phase:'join',color:'#ffffff'}});
 return applySequenceCommand(registered(raw),{type:'upgrade-native-speed-operations'});
}
it.each(['unknown','key','window','owner','recursive','unused','duplicate-id','template','order'] as const)('rejects operation %s corruption at a different current rate and on reload',kind=>{
 const d=applySequenceCommand(withColor(),{type:'set-native-global-speed',rate:r(1)}),b=operationBasis(d)!,t=b.timing!,record=t.clips[0]!;
 if(kind==='unknown')(b as unknown as Record<string,unknown>).extra=true;
 if(kind==='key')t.baselines[0]!.key='0'.repeat(64);
 if(kind==='window')record.parts[0]!.end={kind:'fixed',frame:100};
 if(kind==='owner'){const p=record.parts[0]!.start;if(p.kind!=='fixed')p.ownerId='absent';}
 if(kind==='recursive'){(t.baselines[0]!.input.providers[0]!.basis as unknown as Record<string,unknown>).operationBasis={version:1,order:[]};const key=captionInputDigest(t.baselines[0]!.input);t.baselines[0]!.key=key;record.snapshotKey=key;}
 if(kind==='unused')t.baselines.push(structuredClone(t.baselines[0]!));
 if(kind==='duplicate-id')record.parts[0]!.renderId='video';
 if(kind==='template')record.original.content={kind:'scene-fade',phase:'head',color:'invalid'};
 if(kind==='order')b.order.reverse();
 expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>parseSequence(JSON.stringify(d))).toThrow();
});
it('keeps non-time edits on a split color piece out of the other saved part',()=>{
 let d=applySequenceCommand(withColor(),{type:'split',clipIds:['video'],frame:8,linked:true});const child=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===8)!;
 d=applySequenceCommand(d,{type:'set-native-main-speed',clipId:child.id,rate:r(4)});const right=d.clips.find(c=>c.content.kind==='scene-fade'&&c.startFrame===8)!;
 const old=operationBasis(d)!.timing!.clips[0]!,oldPoint=structuredClone(old.parts[0]!.start);
 d=applySequenceCommand(d,{type:'update-clip',clipId:right.id,patch:{name:'右だけ',content:{kind:'scene-fade',phase:'join',color:'#ff0000'}}});
 expect(operationBasis(d)!.timing!.clips[0]!.parts[0]!.start).toEqual(oldPoint);
 const normal=applySequenceCommand(d,{type:'reset-native-main-speed',clipId:child.id});expect(normal.clips.filter(c=>c.content.kind==='scene-fade').map(c=>[c.name,c.content.kind==='scene-fade'?c.content.color:''])).toEqual([['色面','#ffffff'],['右だけ','#ff0000']]);
 const again=applySequenceCommand(normal,{type:'set-native-main-speed',clipId:child.id,rate:r(4)});expect(content(again)).toBe(content(d));expect(parseSequence(serializeSequence(again))).toEqual(again);
});
it('moves the operation carrier on one-sided deletion and leaves independent audio unchanged by global speed',()=>{
 let d=applySequenceCommand(registered(),{type:'upgrade-native-speed-operations'});d=applySequenceCommand(d,{type:'delete',clipIds:['audio'],linked:false});
 expect(operationBasis(d)).toBeDefined();const before=structuredClone(d);expect(content(applySequenceCommand(applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)}),{type:'set-native-global-speed',rate:r(2)}))).toBe(content(before));
 let audioOnly=applySequenceCommand(applySequenceCommand(registered(),{type:'upgrade-native-speed-operations'}),{type:'delete',clipIds:['video'],linked:false});expect(audioOnly.clips.find(c=>c.id==='audio')!.speed?.kind).toBe('independent-audio');expect(operationBasis(audioOnly)).toBeDefined();expect(()=>applySequenceCommand(audioOnly,{type:'set-native-global-speed',rate:r(1)})).toThrow(/主映像/);
});

it('keeps full owner overlap cap, transition fields and exact return through a split',()=>{
 const raw=fixture();raw.clips=raw.clips.filter(c=>c.id==='video');raw.clips[0]!.durationFrames=100;raw.clips[0]!.content={kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)};delete raw.clips[0]!.linkGroupId;
 if(raw.assets[0]!.kind==='media')for(const st of raw.assets[0]!.streams)st.duration=r(1000);
 raw.clips.push({...structuredClone(raw.clips[0]!),id:'second',startFrame:80});raw.sequenceEndFrame=180;raw.transitions=[{id:'overlap',trackId:'v',outClipId:'video',inClipId:'second',kind:'crossfade',startFrame:80,durationFrames:20,audioCurve:'none'}];
 let d=applySequenceCommand(raw,{type:'register-native-speed',groupId:'g',mainClipIds:['video','second'],mainAudioBindings:[]});d=applySequenceCommand(d,{type:'split',clipIds:['video'],frame:70,linked:true});d=applySequenceCommand(d,{type:'upgrade-native-speed-operations'});const before=content(d);
 const fast=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(2)});expect(fast.sequenceEndFrame).toBe(90);expect(fast.transitions).toEqual([{...d.transitions[0]!,startFrame:40,durationFrames:10}]);expect(fast.clips.map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,35],[35,15],[40,50]]);
 expect(content(applySequenceCommand(fast,{type:'set-native-global-speed',rate:r(1)}))).toBe(before);
 let error:unknown;try{applySequenceCommand(d,{type:'set-native-main-speed',clipId:'second',rate:r(2)});}catch(e){error=e;}expect(error).toMatchObject({code:'INVALID_RANGE'});expect(content(d)).toBe(before);
});
it('projects joinFrame the same way as startFrame/durationFrames on an overlapping transition (R3-M5)',()=>{
 // set-transition already refuses to touch a transition once speed is registered
 // (SPEED_REGISTERED), so this joinFrame only feeds display labels
 // (transitionRoom / transitionJoinsForUi). Left unprojected, those labels would
 // keep reading the pre-speed boundary after a global-speed change.
 const raw=fixture();raw.clips=raw.clips.filter(c=>c.id==='video');raw.clips[0]!.durationFrames=100;raw.clips[0]!.content={kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)};delete raw.clips[0]!.linkGroupId;
 if(raw.assets[0]!.kind==='media')for(const st of raw.assets[0]!.streams)st.duration=r(1000);
 raw.clips.push({...structuredClone(raw.clips[0]!),id:'second',startFrame:80});raw.sequenceEndFrame=180;
 raw.transitions=[{id:'overlap',trackId:'v',outClipId:'video',inClipId:'second',kind:'crossfade',startFrame:80,durationFrames:20,audioCurve:'none',joinKey:'join:v:video:second',joinFrame:90}];
 const d=applySequenceCommand(raw,{type:'register-native-speed',groupId:'g',mainClipIds:['video','second'],mainAudioBindings:[]});
 const fast=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(2)});
 // Old joinFrame (90) sat 10fr into the old 20fr window (before===after===10, ratio 0.5).
 // The new window is [40,50); the same ratio lands joinFrame at 45, not the stale 90.
 expect(fast.transitions).toEqual([{...d.transitions[0]!,startFrame:40,durationFrames:10,joinFrame:45}]);
});
it('retains absolute phase source/clock through a distinct child override and its reset',()=>{
 const raw=fixture();raw.clips=raw.clips.filter(c=>c.id==='video');delete raw.clips[0]!.linkGroupId;raw.clips[0]!.durationFrames=3;raw.clips[0]!.clock={offset:r(0),rate:r(1),duration:r(1000)};raw.clips[0]!.content={kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)};
 if(raw.assets[0]!.kind==='media')for(const st of raw.assets[0]!.streams)st.duration=r(1000);
 raw.clips.push({...structuredClone(raw.clips[0]!),id:'b',startFrame:3,durationFrames:601,content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(10),rate:r(1)}});raw.sequenceEndFrame=604;
 let d=applySequenceCommand(raw,{type:'register-native-speed',groupId:'g',mainClipIds:['video','b'],mainAudioBindings:[]});d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(2)});d=applySequenceCommand(d,{type:'split',clipIds:['b'],frame:3,linked:true});const right=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===3)!;const before=content(d);
 expect(right.content).toMatchObject({sourceIn:r(12)});expect(right.clock.offset).toEqual(r(2));
 const own=applySequenceCommand(d,{type:'set-native-main-speed',clipId:right.id,rate:r(3)}),changed=own.clips.find(c=>c.id===right.id)!;
 // Global mode becomes cumulative: A round(3/2)=2, B-left round(3/2)=2.
 // Right original clock coordinate round(3/3)*3=3, independent of start=4.
 expect(changed.startFrame).toBe(4);expect(changed.durationFrames).toBe(199);expect(changed.content).toMatchObject({sourceIn:r(13),rate:r(3)});expect(changed.clock).toEqual({offset:r(3),rate:r(3),duration:r(1000)});
 expect(content(applySequenceCommand(own,{type:'reset-native-main-speed',clipId:right.id}))).toBe(before);
});

it('uses native exact half-up for 17/1.36 and restores the unchanged source intent',()=>{
 const raw=fixture();raw.clips=raw.clips.filter(c=>c.id==='video');raw.clips[0]!.durationFrames=17;raw.clips[0]!.content={kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)};raw.sequenceEndFrame=17;
 const d=applySequenceCommand(applySequenceCommand(raw,{type:'register-native-speed',groupId:'g',mainClipIds:['video'],mainAudioBindings:[]}),{type:'upgrade-native-speed-operations'}),fast=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(34,25)});
 expect(fast.clips[0]!.durationFrames).toBe(13);expect(Math.round(17/1.36)).toBe(12);expect(fast.clips[0]!.speed).toEqual(d.clips[0]!.speed);expect(content(applySequenceCommand(fast,{type:'set-native-global-speed',rate:r(1)}))).toBe(content(d));
});
it('preserves independent audio and fixed inserted media while changing main speed',()=>{
 let d=applySequenceCommand(registered(),{type:'unlink',clipIds:['audio']});const fixed={...structuredClone(d.clips.find(c=>c.id==='audio')!),id:'fixed-audio',trackId:'a2',name:'fixed',speed:undefined,linkGroupId:undefined,anchor:undefined};
 d=applySequenceCommand(d,{type:'add-track',track:{id:'a2',kind:'audio',name:'挿入',enabled:true}});d=applySequenceCommand(d,{type:'insert',clips:[fixed]});d=applySequenceCommand(d,{type:'upgrade-native-speed-operations'});const audio=d.clips.filter(c=>c.content.kind==='audio');
 const slow=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});expect(slow.clips.filter(c=>c.content.kind==='audio').map(c=>({...c,speed:c.speed?{...c.speed,operationBasis:undefined}:undefined}))).toEqual(audio.map(c=>({...c,speed:c.speed?{...c.speed,operationBasis:undefined}:undefined})));
});
it('preserves ordinary color track changes and no-op input identity',()=>{
 let d=withColor();d=applySequenceCommand(d,{type:'add-track',track:{id:'target',kind:'visual',name:'移動先',enabled:true}});d=applySequenceCommand(d,{type:'move',clipIds:['color-clip'],deltaFrames:0,trackId:'target',linked:false});expect(d.clips.find(c=>c.id==='color-clip')!.trackId).toBe('target');
 const before=content(d);expect(applySequenceCommand(d,{type:'split',clipIds:['video'],frame:0,linked:true})).toBe(d);expect(content(d)).toBe(before);expect(content(applySequenceCommand(applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)}),{type:'set-native-global-speed',rate:r(2)}))).toBe(before);
});
