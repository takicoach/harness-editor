import {describe,it,expect} from 'vitest';
import {migrateLegacySequence,type LegacyMigrationInput} from './migrateLegacy';
import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ScenePlan} from './scenePlan';
import {mixAudioBlock,pcmKey} from '../../preview/native/audioMixer';
import {migrateLegacyWithCutHistory} from './migrateLegacyWithCutHistory';
import {applySequenceCommand} from './commands';
import {rational as r} from './time';
import {clipEnd,sourceTimeAt,effectFrameAt,type SequenceDocument} from './model';
import {validateSequenceDocument} from './validate';
import {legacyAudioPolicyForRestore} from './legacyAudioContinuity';
function input():LegacyMigrationInput {
  return {id:'old-project',name:'旧カットを保持',sourceFingerprint:'a'.repeat(64),bindings:{main:'main',telopComponent:'caption-renderer',images:{},videoInserts:{},bgm:{},se:{}},
    assets:[{id:'main',kind:'media',name:'元動画',file:'public/main.mp4',fingerprint:'main',streams:[
      {index:0,kind:'video',duration:r(10),codec:'h264',width:1920,height:1080,frameRate:r(30)},
      {index:1,kind:'audio',duration:r(10),codec:'aac',sampleRate:48000,channels:2}]},
      {id:'caption-renderer',kind:'component',name:'既存字幕',file:'.harness/assets/caption.js',fingerprint:'caption',streams:[]}],
    project:{videoConfig:{fps:30,durationFrames:300,videoFile:'main.mp4',format:'youtube',orientation:'landscape',resolution:{width:1920,height:1080},titleStyle:{top:60,left:30,fontSize:36}},
      projectConfig:null,transcript:{durationMs:10000,words:[],segments:[]},
      telops:[{id:7,originalStart:30,originalEnd:180,text:'元の字幕本文',template:3,animation:'none'}],
      cutRegions:[{start:60,end:90}],titles:[],images:[],se:[],bgm:[],videoInserts:[],shapes:[],
      mainSpeed:1,segmentSpeeds:{},telopDataSource:'caption-source',cutDataSource:'cut-source',seDataSource:null,insertImageDataSource:null,titleDataSource:null}};
}

function music(kind:'bgm'|'se'='bgm') { const i=input();i.project.telops=[];i.bindings[kind][1]='main';i.project[kind]=[{id:1,file:'main.mp4',originalStart:0,originalEnd:300,volume:.4,fadeInFrames:5,fadeOutFrames:10}];return i; }
function assertContinuous(doc:SequenceDocument,role='music',length=300,offset=0,rate=1){
 const clips=doc.clips.filter(c=>c.content.kind==='audio'&&c.content.role===role).sort((a,b)=>a.startFrame-b.startFrame);
 expect(clips[0]!.startFrame).toBe(0);expect(clipEnd(clips.at(-1)!)).toBe(length);
 for(let f=0;f<length;f++){const active=clips.filter(c=>c.startFrame<=f&&f<clipEnd(c));expect(active).toHaveLength(1);const c=active[0]!;expect(sourceTimeAt(c,f,doc.fps)).toEqual(r(offset*30+f*rate,30));expect(effectFrameAt(c,f)).toEqual(r(f));expect(c.clock.duration).toEqual(r(length));}
 validateSequenceDocument(doc);
}
describe('legacy music continuity when restoring old cuts',()=>{
 it.each(['bgm','se'] as const)('extends %s without restarting either the restored portion or suffix',kind=>{
  const doc=migrateLegacyWithCutHistory(music(kind)).document;
  const next=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
  assertContinuous(next,kind==='bgm'?'music':'effect');
 });
 it.each([false,true])('keeps a continuous clock after central-first then remaining bands (reverse=%s)',reverse=>{
  let doc=migrateLegacyWithCutHistory(music()).document;
  doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}});
  assertContinuous(doc,'music',280);
  const ids=doc.cutArchive!.entries.map(e=>e.id);if(reverse)ids.reverse();
  for(const id of ids){doc=applySequenceCommand(JSON.parse(JSON.stringify(doc)),{type:'restore-cut',entryId:id});}
  assertContinuous(doc);
 });
});

function roleClips(doc:SequenceDocument){return doc.clips.filter(c=>c.content.kind==='audio'&&c.content.role==='music').sort((a,b)=>a.startFrame-b.startFrame);}
function restoreAll(doc:SequenceDocument,reverse=false){while(doc.cutArchive?.entries.length){const entries=doc.cutArchive.entries;doc=applySequenceCommand(doc,{type:'restore-cut',entryId:entries[reverse?entries.length-1:0]!.id});}return doc;}
it.each([false,true])('restores multiple old bands without restarting the same usage (reverse=%s)',reverse=>{
 const i=music();i.project.cutRegions=[{start:60,end:90},{start:150,end:180}];
 assertContinuous(restoreAll(migrateLegacyWithCutHistory(i).document,reverse));
});
it('uses current gain and a manually adjusted uniform rate/source base',()=>{
 const i=music();i.assets[0]!.streams.forEach(s=>s.duration=r(30));
 let doc=migrateLegacyWithCutHistory(i).document;const clip=roleClips(doc)[0]!;
 if(clip.content.kind!=='audio')throw Error('fixture');clip.content.rate=r(2);clip.content.sourceIn=r(1);clip.content.settings.gainDb=-7;
 doc=restoreAll(doc);assertContinuous(doc,'music',300,1,2);
 expect(roleClips(doc).every(c=>c.content.kind==='audio'&&c.content.settings.gainDb===-7)).toBe(true);
});
it.each([[65,300],[0,75],[65,80]])('recreates the exact original audio edges %i..%i', (start,end)=>{
 const i=music();i.project.bgm![0]!.originalStart=start;i.project.bgm![0]!.originalEnd=end;
 const doc=restoreAll(migrateLegacyWithCutHistory(i).document);const clips=roleClips(doc);
 expect(clips[0]!.startFrame).toBe(start);expect(clipEnd(clips.at(-1)!)).toBe(end);
 for(let f=start;f<end;f++){const c=clips.find(c=>c.startFrame<=f&&f<clipEnd(c))!;expect(c).toBeDefined();expect(sourceTimeAt(c,f,doc.fps)).toEqual(r(f-start,30));}
});
it('keeps the native recut source gap while extending only the old band',()=>{
 let doc=migrateLegacyWithCutHistory(music()).document;
 doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:20,endFrame:30});
 const legacy=doc.cutArchive!.entries.find(e=>e.legacyRecovery)!;
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:legacy.id});
 const clips=roleClips(doc);expect(clips.map(c=>[c.startFrame,clipEnd(c)])).toEqual([[0,20],[20,50],[50,80],[80,290]]);
 for(let f=0;f<290;f++){const c=clips.find(c=>c.startFrame<=f&&f<clipEnd(c))!;expect(sourceTimeAt(c,f,doc.fps)).toEqual(r(f<20?f:f+10,30));}
 doc=restoreAll(doc);assertContinuous(doc);
});
it('does not bind another occurrence or subsequently added soundtrack using the same asset',()=>{
 const i=music();i.bindings.bgm[2]='main';i.project.bgm!.push({...i.project.bgm![0]!,id:2,originalStart:100,originalEnd:150});
 const doc=migrateLegacyWithCutHistory(i).document;
 const extra=structuredClone(roleClips(doc)[0]!);extra.id='new-music';extra.trackId='new-track';extra.startFrame=200;extra.durationFrames=10;extra.clock.duration=r(10);
 doc.tracks.push({id:'new-track',name:'後追加',kind:'audio',enabled:true});doc.clips.push(extra);
 const next=restoreAll(doc);const added=next.clips.find(c=>c.id==='new-music')!;
 expect(added.content).toEqual(extra.content);expect(added.clock).toEqual(extra.clock);expect(added.startFrame).toBe(230);
 const other=next.clips.find(c=>c.id==='legacy-music-2')!;expect(sourceTimeAt(other,other.startFrame,next.fps)).toEqual(r(0));expect(other.durationFrames).toBe(50);
});

it.each([false,true])('handles a wholly removed soundtrack with middle/edge restoration order (reverse=%s)',reverse=>{
 const i=music();i.project.bgm![0]!.originalStart=65;i.project.bgm![0]!.originalEnd=85;
 let doc=migrateLegacyWithCutHistory(i).document;doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}});doc=restoreAll(doc,reverse);
 const clips=roleClips(doc);expect(clips[0]!.startFrame).toBe(65);expect(clipEnd(clips.at(-1)!)).toBe(85);
 for(let f=65;f<85;f++){const c=clips.find(c=>c.startFrame<=f&&f<clipEnd(c))!;expect(c).toBeDefined();expect(sourceTimeAt(c,f,doc.fps)).toEqual(r(f-65,30));}
});
it('preserves manual discontinuous source edits instead of automatically rephasing them',()=>{
 const i=music();i.assets[0]!.streams.forEach(s=>s.duration=r(30));let doc=migrateLegacyWithCutHistory(i).document;
 doc=applySequenceCommand(doc,{type:'split',clipIds:['legacy-music-1'],frame:100,linked:false});
 const right=roleClips(doc)[1]!;if(right.content.kind!=='audio')throw Error('fixture');right.content.sourceIn=r(10);right.content.settings.gainDb=-11;
 const content=structuredClone(right.content),clock=structuredClone(right.clock);
 const next=restoreAll(doc),after=next.clips.find(c=>c.id===right.id)!;
 expect(after.content).toEqual(content);expect(after.clock).toEqual(clock);expect(after.startFrame).toBe(130);
});
it('does not absorb a user-created timeline gap into legacy music',()=>{
 let doc=migrateLegacyWithCutHistory(music()).document;
 doc=applySequenceCommand(doc,{type:'split',clipIds:['legacy-music-1'],frame:100,linked:false});
 const right=roleClips(doc)[1]!;right.startFrame+=10;const previous=structuredClone(right);
 const next=restoreAll(doc),after=next.clips.find(c=>c.id===right.id)!;
 expect(after.startFrame).toBe(previous.startFrame+30);expect(after.durationFrames).toBe(previous.durationFrames);
 expect(sourceTimeAt(after,after.startFrame,next.fps)).toEqual(r(130,30));
});
it('never duplicates independently placed BGM in a deleted band',()=>{
 const i=music();i.project.bgm![0]!.timelinePlacement={startFrame:0,endFrame:100};
 const doc=migrateLegacyWithCutHistory(i).document;expect(doc.cutArchive!.entries[0]!.clips.filter(c=>c.content.kind==='audio'&&c.content.role==='music')).toHaveLength(0);
 const before=roleClips(doc)[0]!;const after=roleClips(restoreAll(doc));
 expect(after.every(c=>c.content.kind==='audio'&&c.content.settings.gainDb===(before.content.kind==='audio'?before.content.settings.gainDb:NaN))).toBe(true);
 expect(after.reduce((n,c)=>n+c.durationFrames,0)).toBe(before.durationFrames);
});
it('keeps malformed provenance out of saved documents and preserves old JSON compatibility',()=>{
 const doc=migrateLegacyWithCutHistory(music()).document;
 const saved=doc.cutArchive!.entries[0]!.clips.find(c=>c.legacyAudioContinuity)!;
 saved.legacyAudioContinuity={...saved.legacyAudioContinuity!,sourceFingerprint:'not-sha'};expect(()=>validateSequenceDocument(doc)).toThrow('旧音楽');
 delete saved.legacyAudioContinuity;expect(()=>validateSequenceDocument(doc)).not.toThrow();
});

it('saves partial policy and subsequent native archives, then restores with one undo per operation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'harness-legacy-audio-'));
 try{
  const before=migrateLegacyWithCutHistory(music()).document,store=new SequenceStore(dir),session=new SequenceSession('private',before);
  store.save({expectedSavedRevision:null,executionId:'initial',document:before});
  const request={sessionId:'private',expectedRevision:0,executionId:'partial',command:{type:'restore-cut' as const,entryId:before.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}}};
  const partial=session.execute(request).document;store.save({expectedSavedRevision:0,executionId:'partial-save',document:partial});
  expect(store.load()!.document).toEqual(partial);assertContinuous(restoreAll(store.load()!.document));
  const undo=session.execute({sessionId:'private',expectedRevision:1,executionId:'undo',command:{type:'undo'}}).document;
  expect({...undo,revision:before.revision}).toEqual(before);store.save({expectedSavedRevision:1,executionId:'undo-save',document:undo});
  const redo=session.execute({sessionId:'private',expectedRevision:2,executionId:'redo',command:{type:'redo'}}).document;
  expect({...redo,revision:partial.revision}).toEqual(partial);
  expect(()=>store.save({expectedSavedRevision:1,executionId:'stale',document:redo})).toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it.each((['bgm','se'] as const).flatMap(kind=>[false,true].map(nativeFirst=>({kind,nativeFirst}))))('matches uncut legacy $kind through the real mixer including every PCM sample (native first=$nativeFirst)',({kind,nativeFirst})=>{
 const i=music(kind),uncut=structuredClone(i);uncut.project.cutRegions=[];
 let before=migrateLegacyWithCutHistory(i).document;
 if(nativeFirst){before=applySequenceCommand(before,{type:'ripple-delete',startFrame:50,endFrame:70});before=registerLive(before);before=applySequenceCommand(before,{type:'set-native-global-speed',rate:r(2)});}
 const after=restoreAll(before,nativeFirst),expected=migrateLegacySequence(uncut).document;
 // Global speed changes main AV, not fixed music. Restoring the three fixed
 // music windows adds 10+10+30 frames to the 250/2-frame sequence floor.
 // Compare every exported music sample to the original uncut soundtrack.
 const frames=nativeFirst?250/2+10+10+30:300;
 expect(after.sequenceEndFrame).toBe(frames);
 expect(Math.max(...after.clips.filter(c=>c.content.kind==='video').map(clipEnd))).toBe(nativeFirst?150:300);
 const sampleRate=48000,sourceCount=sampleRate*10,count=frames*1600;
 const channel=Float32Array.from({length:sourceCount},(_,n)=>Math.sin(n*.037)*(.2+.2*n/sourceCount));
 const sources=new Map([[pcmKey('main',1,r(1)),{assetId:'main',streamIndex:1,rate:r(1),sampleRate,channels:[channel,channel]}]]);
 const render=(doc:SequenceDocument)=>{doc=structuredClone(doc);for(const c of doc.clips)if(c.content.kind==='audio'&&c.content.role!==(kind==='bgm'?'music':'effect'))c.content.settings.muted=true;return mixAudioBlock(new ScenePlan(doc),sources,0,count,sampleRate)[0];};
 const actual=render(after),reference=render(expected);let max=0;for(let n=0;n<count;n++)max=Math.max(max,Math.abs(actual[n]!-reference[n]!));expect(max).toBeLessThan(1e-6);
});

it.each([[100,110],[50,70]])('preserves a later native cut %i..%i while restoring legacy audio then the native snapshot',(start,end)=>{
 let doc=migrateLegacyWithCutHistory(music()).document;
 doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:start,endFrame:end});
 const legacy=doc.cutArchive!.entries.find(e=>e.legacyRecovery)!;
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:legacy.id});doc=restoreAll(doc);assertContinuous(doc);
});
it.each([false,true])('fills only the witnessed legacy endpoint clamp through central-first partial restore (reverse=%s)',reverse=>{
 const i=music();i.project.bgm![0]!.originalEnd=75;
 let doc=migrateLegacyWithCutHistory(i).document;
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}});
 doc=restoreAll(doc,reverse);const clips=roleClips(doc);
 for(let f=0;f<75;f++){const c=clips.find(c=>c.startFrame<=f&&f<clipEnd(c))!;expect(c).toBeDefined();expect(sourceTimeAt(c,f,doc.fps)).toEqual(r(f,30));}
 expect(clipEnd(clips.at(-1)!)).toBe(75);
});


it('preserves soundtrack continuity after explicit main speed registration and a rate change',()=>{
 let doc=migrateLegacyWithCutHistory(music()).document;
 const videos=doc.clips.filter(c=>c.content.kind==='video');
 doc=applySequenceCommand(doc,{type:'register-native-speed',groupId:'main-speed',mainClipIds:videos.map(c=>c.id),mainAudioBindings:videos.flatMap(v=>doc.clips.filter(c=>c.content.kind==='audio'&&c.content.role==='speech'&&c.linkGroupId===v.linkGroupId).map(c=>({audioClipId:c.id,providerId:v.id})))});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(2)});
 doc=restoreAll(doc);assertContinuous(doc);
 const again=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});assertContinuous(again);
});

function registerLive(doc:SequenceDocument){const videos=doc.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);return applySequenceCommand(doc,{type:'register-native-speed',groupId:'explicit-main',mainClipIds:videos.map(c=>c.id),mainAudioBindings:videos.flatMap(v=>doc.clips.filter(c=>c.content.kind==='audio'&&c.content.role==='speech'&&v.linkGroupId&&c.linkGroupId===v.linkGroupId).map(c=>({audioClipId:c.id,providerId:v.id})))});}
it.each((['left','right'] as const).flatMap(side=>[1,2].flatMap(rate=>[false,true].map(reverse=>({side,rate,reverse})))) )('registers old cuts after partially restoring the adjacent native $side endpoint (rate=$rate, reverse=$reverse)',({side,rate,reverse})=>{
 let doc=applySequenceCommand(migrateLegacyWithCutHistory(music()).document,{type:'ripple-delete',startFrame:50,endFrame:70});
 const native=doc.cutArchive!.entries.filter(e=>!e.legacyRecovery);
 const entry=native[side==='left'?0:native.length-1]!;
 // Four source frames remain integral at both tested rates. The original
 // five-frame reproduction is retained separately in the audit's RED probe.
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:entry.id,range:side==='left'?{startFrame:6,endFrame:10}:{startFrame:0,endFrame:4}});
 const restoredVideo=doc.clips.find(c=>c.content.kind==='video'&&c.startFrame===50&&c.durationFrames===4)!;
 for(const c of doc.cutArchive!.entries.find(e=>e.legacyRecovery)!.clips.filter(c=>c.legacyMainRole)){
  const witness=c.legacyMainRole!.witnesses.find(w=>w.kind==='main'&&w.edge===(side==='left'?'end':'start'))!;
  expect(witness.clipId).toBe(restoredVideo.id);
 }
 doc=registerLive(JSON.parse(JSON.stringify(doc)));
 expect(doc.cutArchive!.entries.every(e=>e.speed)).toBe(true);
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(rate)});
 doc=restoreAll(doc,reverse);assertContinuous(doc);
 const mains=doc.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
 expect(mains.reduce((n,c)=>n+c.durationFrames,0)).toBe(300/rate);
 for(const [i,c] of mains.entries()){expect(sourceTimeAt(c,c.startFrame,doc.fps)).toEqual(i?sourceTimeAt(mains[i-1]!,clipEnd(mains[i-1]!),doc.fps):r(0));}
 expect(sourceTimeAt(mains.at(-1)!,clipEnd(mains.at(-1)!),doc.fps)).toEqual(r(10));
});
it('saves the five-frame restored witness and restores its original identity with Undo/Redo',()=>{
 const dir=mkdtempSync(join(tmpdir(),'harness-restored-witness-'));
 try{
  const before=applySequenceCommand(migrateLegacyWithCutHistory(music()).document,{type:'ripple-delete',startFrame:50,endFrame:70});
  const entry=before.cutArchive!.entries.find(e=>!e.legacyRecovery)!;
  const store=new SequenceStore(dir),session=new SequenceSession('private',before);
  store.save({expectedSavedRevision:null,executionId:'initial',document:before});
  const partial=session.execute({sessionId:'private',expectedRevision:before.revision,executionId:'partial',command:{type:'restore-cut',entryId:entry.id,range:{startFrame:5,endFrame:10}}}).document;
  store.save({expectedSavedRevision:before.revision,executionId:'partial-save',document:partial});
  expect(store.load()!.document).toEqual(partial);
  expect(registerLive(store.load()!.document).cutArchive!.entries.every(e=>e.speed)).toBe(true);
  const undo=session.execute({sessionId:'private',expectedRevision:partial.revision,executionId:'undo',command:{type:'undo'}}).document;
  expect({...undo,revision:before.revision}).toEqual(before);
  const redo=session.execute({sessionId:'private',expectedRevision:undo.revision,executionId:'redo',command:{type:'redo'}}).document;
  expect({...redo,revision:partial.revision}).toEqual(partial);
  assertContinuous(restoreAll(registerLive(redo)));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it.each(['foreign-origin','changed-source','moved-insertion','unlinked'] as const)('does not reassign an old seam from a restored native fragment with %s',change=>{
 let doc=applySequenceCommand(migrateLegacyWithCutHistory(music()).document,{type:'ripple-delete',startFrame:50,endFrame:70});
 const entry=doc.cutArchive!.entries.find(e=>!e.legacyRecovery)!;
 const video=entry.clips.find(c=>c.content.kind==='video')!;
 if(change==='foreign-origin'){video.id='unrelated-video';video.continuationGroupId='unrelated-video';}
 if(change==='changed-source')for(const c of entry.clips.filter(c=>c.linkGroupId===video.linkGroupId))if(c.content.kind==='video'||c.content.kind==='audio')c.content.sourceIn=r(51,30);
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:entry.id,range:{startFrame:5,endFrame:10},...(change==='moved-insertion'?{atFrame:0}:{})});
 if(change==='unlinked'){const restored=doc.clips.find(c=>c.content.kind==='video'&&c.startFrame===50)!;doc=applySequenceCommand(doc,{type:'unlink',clipIds:[restored.id]});}
 for(const c of doc.cutArchive!.entries.find(e=>e.legacyRecovery)!.clips.filter(c=>c.legacyMainRole)){
  const witness=c.legacyMainRole!.witnesses.find(w=>w.kind==='main'&&w.edge==='end')!;
  if(change==='unlinked')expect(witness.clipId).toBe(doc.clips.find(c=>c.content.kind==='video'&&c.startFrame===50)!.id);
  else expect(witness.clipId).toBe('legacy-video-1');
 }
 const before=JSON.stringify(doc);
 const registered=registerLive(doc);
 expect(registered.cutArchive!.entries.find(e=>e.legacyRecovery)!.speed).toBeUndefined();
 expect(JSON.stringify(doc)).toBe(before);
});
it.each([{reverse:false,registered:true},{reverse:true,registered:true},{reverse:true,registered:false}])('preserves adjacent native and old bands through restoration (reverse=$reverse, registered=$registered)',({reverse,registered})=>{
 let doc=migrateLegacyWithCutHistory(music()).document;
 doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:50,endFrame:70});
 expect(doc.cutArchive!.entries).toHaveLength(3);
 if(registered){
  doc=registerLive(doc);
  expect(doc.cutArchive!.entries.every(e=>e.speed)).toBe(true);
  doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(2)});
 }
 doc=restoreAll(JSON.parse(JSON.stringify(doc)),reverse);
 assertContinuous(doc);
});
it.each(['no-order','changed-clock','foreign-usage'] as const)('does not borrow an archived endpoint with %s evidence',change=>{
 let doc=applySequenceCommand(migrateLegacyWithCutHistory(music()).document,{type:'ripple-delete',startFrame:50,endFrame:70});
 const neighbor=doc.cutArchive!.entries.find(e=>!e.legacyRecovery)!;
 if(change==='no-order')delete doc.cutArchive!.groups;
 if(change==='changed-clock')neighbor.clips.find(c=>c.content.kind==='video')!.clock.offset=r(999);
 if(change==='foreign-usage')neighbor.clips.find(c=>c.content.kind==='video')!.continuationGroupId='unrelated-usage';
 const snapshot=JSON.stringify(doc),registered=registerLive(doc);
 expect(registered.cutArchive!.entries.find(e=>e.legacyRecovery)!.speed).toBeUndefined();
 expect(JSON.stringify(doc)).toBe(snapshot);
});
it.each(['owner','asset','stream','role','fingerprint'] as const)('does not attach legacy soundtrack lineage to a different %s',change=>{
 const doc=applySequenceCommand(migrateLegacyWithCutHistory(music()).document,{type:'ripple-delete',startFrame:50,endFrame:70});
 const clip=structuredClone(doc.cutArchive!.entries.find(e=>!e.legacyRecovery)!.clips.find(c=>c.content.kind==='audio'&&c.content.role==='music')!);
 expect(legacyAudioPolicyForRestore(doc,clip)?.ownerClipId).toBe('legacy-music-1');
 if(clip.content.kind!=='audio')throw Error('fixture');
 if(change==='owner'){clip.id='unrelated';clip.continuationGroupId='unrelated';}
 if(change==='asset')clip.content.assetId='unrelated';
 if(change==='stream')clip.content.streamIndex=99;
 if(change==='role')clip.content.role='effect';
 if(change==='fingerprint')doc.legacy!.sourceFingerprint='b'.repeat(64);
 expect(legacyAudioPolicyForRestore(doc,clip)).toBeUndefined();
});
it.each([false,true])('retains legacy main roles through partial recovery before registration (reverse=%s)',reverse=>{
 let doc=migrateLegacyWithCutHistory(music()).document;
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range:{startFrame:10,endFrame:20}});
 doc=registerLive(doc);expect(doc.cutArchive!.entries.every(e=>e.speed)).toBe(true);
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(2)});doc=restoreAll(JSON.parse(JSON.stringify(doc)),reverse);assertContinuous(doc);
});
it.each(['unlink','source','missing-witness','ambiguous'] as const)('keeps legacy bands unregistered when concrete %s evidence no longer agrees',change=>{
 let doc=migrateLegacyWithCutHistory(music()).document;
 if(change==='unlink')doc=applySequenceCommand(doc,{type:'unlink',clipIds:[doc.clips.find(c=>c.content.kind==='video')!.id]});
 if(change==='source'){const v=doc.clips.find(c=>c.content.kind==='video')!;for(const c of doc.clips.filter(c=>c.id===v.id||c.linkGroupId===v.linkGroupId))if(c.content.kind==='audio'||c.content.kind==='video')c.content.sourceIn=r(1,30);}
 if(change==='missing-witness')doc=applySequenceCommand(doc,{type:'delete',clipIds:[doc.clips.find(c=>c.content.kind==='video')!.id],linked:true});
 if(change==='ambiguous')doc.cutArchive!.entries[0]!.boundary.ambiguous=true;
 const next=registerLive(doc);expect(next.cutArchive!.entries[0]!.speed).toBeUndefined();
 expect(next.clips.filter(c=>c.content.kind==='video').every(c=>c.speed?.kind==='main')).toBe(true);
});
it('does not lend a neighboring legacy segment override to the saved global-default window',()=>{
 const i=music();i.project.segmentSpeeds={1:3};let doc=migrateLegacyWithCutHistory(i).document;
 doc=registerLive(doc);const entry=doc.cutArchive!.entries[0]!;expect(entry.speed).toBeDefined();
 const video=entry.clips.find(c=>c.content.kind==='video')!;expect(video.content).toMatchObject({rate:r(1)});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(2)});doc=restoreAll(doc);validateSequenceDocument(doc);
});
