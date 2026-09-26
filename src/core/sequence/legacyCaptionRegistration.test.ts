import {captionLedgers,captionPartWindow} from './speedCaptionLedger';
import {expect,it} from 'vitest';
import {migrateLegacySequence,type LegacyMigrationInput} from './migrateLegacy';
import {applySequenceCommand} from './commands';
import {rational as r} from './time';
import {effectFrameAt,type SequenceDocument} from './model';
import {validateSequenceDocument} from './validate';
import {migrateLegacyWithCutHistory} from './migrateLegacyWithCutHistory';
import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isLegacyCaptionPolicy,normalizeLegacyCaptionContinuations} from './legacyCaptionContinuations';
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

function register(doc:SequenceDocument){const videos=doc.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);return applySequenceCommand(doc,{type:'register-native-speed',groupId:'selected-main',mainClipIds:videos.map(c=>c.id),mainAudioBindings:videos.flatMap(v=>doc.clips.filter(c=>c.content.kind==='audio'&&c.linkGroupId===v.linkGroupId).map(c=>({audioClipId:c.id,providerId:v.id})))});}
it('registers the real legacy split caption and changes global speed without changing caption ownership or clock',()=>{
 const before=migrateLegacySequence(input()).document,registered=register(before),after=applySequenceCommand(registered,{type:'set-native-global-speed',rate:r(2)});
 validateSequenceDocument(after);
 const captions=after.clips.filter(c=>c.content.kind==='telop').sort((a,b)=>a.startFrame-b.startFrame);
 expect(captions.map(c=>[c.id,c.startFrame,c.durationFrames,c.clock.offset,c.clock.rate,c.clock.duration])).toEqual([
 ['legacy-telop-7',15,15,r(0),r(2),r(120)],['legacy-telop-7-part-1',30,45,r(30),r(2),r(120)]]);
 const restored=applySequenceCommand(after,{type:'set-native-global-speed',rate:r(1)});
 expect(restored.clips.filter(c=>c.content.kind==='telop').map(c=>({...c,continuationGroupId:undefined}))).toEqual(before.clips.filter(c=>c.content.kind==='telop').map(c=>({...c,continuationGroupId:undefined})));
});

const captions=(doc:SequenceDocument)=>doc.clips.filter(c=>c.content.kind==='telop');
const withoutGroup=(doc:SequenceDocument)=>captions(doc).map(c=>({...c,continuationGroupId:undefined}));
it.each([r(1,2),r(3,2),r(2),r(3)])('retains every renderer ID, body, source owner and original effect clock after a %j round trip',rate=>{
 const before=migrateLegacySequence(input()).document,bytes=JSON.stringify(before);
 const fast=applySequenceCommand(register(before),{type:'set-native-global-speed',rate});
 expect(captions(fast).map(c=>c.id)).toEqual(captions(before).map(c=>c.id));
 const again=applySequenceCommand(fast,{type:'set-native-global-speed',rate:r(1)});
 expect(withoutGroup(again)).toEqual(withoutGroup(before));expect(JSON.stringify(before)).toBe(bytes);
 expect(new Set(captions(again).map(c=>c.continuationGroupId)).size).toBe(1);
 expect(captions(again)[0]!.continuationGroupId).not.toBe(captions(again)[0]!.id);
});
it('keeps separate text and style ownership on the two explicit legacy continuation pieces',()=>{
 const before=migrateLegacySequence(input()).document;const right=captions(before)[1]!;
 if(right.content.kind!=='telop')throw Error('fixture');right.content.data.text='後半だけの編集';right.name='独立の後半';
 const after=applySequenceCommand(register(before),{type:'set-native-global-speed',rate:r(2)});
 expect(captions(after).map(c=>c.content.kind==='telop'?c.content.data.text:'')).toEqual(['元の字幕本文','後半だけの編集']);
});
it.each(['no-legacy','different-legacy-id','clock','foreign-group-use','link-alias'] as const)('does not exempt a %s collision from the existing validator',change=>{
 const doc=migrateLegacySequence(input()).document,parts=captions(doc);
 if(change==='no-legacy')delete doc.legacy;
 if(change==='different-legacy-id'&&parts[1]!.content.kind==='telop')parts[1]!.content.legacyId=999;
 if(change==='clock')parts[1]!.clock.offset=r(31);
 if(change==='foreign-group-use')doc.clips.push({id:'foreign',trackId:'v-main',name:'foreign',startFrame:280,durationFrames:1,clock:{offset:r(0),duration:r(1),rate:r(1)},continuationGroupId:parts[0]!.id,content:{kind:'scene-fade',color:'#000000',phase:'head'}});
 if(change==='link-alias')parts[1]!.linkGroupId=parts[0]!.id;
 const copy=structuredClone(doc);normalizeLegacyCaptionContinuations(copy,new Set(captions(doc).map(c=>c.id)));expect(copy).toEqual(doc);
 const before=JSON.stringify(doc);expect(()=>applySequenceCommand(register(doc),{type:'set-native-global-speed',rate:r(2)})).toThrow();expect(JSON.stringify(doc)).toBe(before);
});
it('reserves real object and archived IDs when choosing a fresh continuation identity',()=>{
 const doc=migrateLegacySequence(input()).document;
 doc.tracks.push({id:'legacy-caption-continuation-1',kind:'visual',name:'reserved',enabled:true});
 const copy=structuredClone(doc);normalizeLegacyCaptionContinuations(copy,new Set(captions(doc).map(c=>c.id)));
 expect(captions(copy).every(c=>c.continuationGroupId==='legacy-caption-continuation-2')).toBe(true);
 expect(withoutGroup(copy)).toEqual(withoutGroup(doc));
});
it('allows existing old bands and their source captions to remain restorable after registration',()=>{
 let doc=register(migrateLegacyWithCutHistory(input()).document);
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(2)});
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
 validateSequenceDocument(doc);expect(captions(doc).every(c=>c.content.kind==='telop'&&c.content.data.text==='元の字幕本文')).toBe(true);
 expect(doc.cutArchive).toBeUndefined();
});
it('can register speed after restoring an old band across a split caption',()=>{
 const initial=migrateLegacyWithCutHistory(input()).document;
 const restored=applySequenceCommand(initial,{type:'restore-cut',entryId:initial.cutArchive!.entries[0]!.id});
 const fast=applySequenceCommand(register(restored),{type:'set-native-global-speed',rate:r(2)});
 validateSequenceDocument(fast);
 expect(fast.sequenceEndFrame).toBe(150);
 expect(captions(fast).every(c=>c.content.kind==='telop'&&c.content.data.text==='元の字幕本文')).toBe(true);
});
it('preserves normalization through real save/reload and undoes the whole speed operation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-caption-register-'));
 try{
  const before=register(migrateLegacySequence(input()).document),session=new SequenceSession('private',before),store=new SequenceStore(dir);
  store.save({expectedSavedRevision:null,executionId:'start',document:before});
  const after=session.execute({sessionId:'private',expectedRevision:before.revision,executionId:'speed',command:{type:'set-native-global-speed',rate:r(2)}}).document;
  store.save({expectedSavedRevision:before.revision,executionId:'save',document:after});expect(store.load()!.document).toEqual(after);
  const undo=session.execute({sessionId:'private',expectedRevision:after.revision,executionId:'undo',command:{type:'undo'}}).document;
  expect({...undo,revision:before.revision}).toEqual(before);
  const redo=session.execute({sessionId:'private',expectedRevision:undo.revision,executionId:'redo',command:{type:'redo'}}).document;
  expect({...redo,revision:after.revision}).toEqual(after);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

it.each(['full','left-first','right-first','middle-first'] as const)('restores the old continuous subtitle effect clock in %s order',order=>{
 let doc=migrateLegacyWithCutHistory(input()).document;
 if(order!=='full'){
  const range=order==='left-first'?{startFrame:0,endFrame:10}:order==='right-first'?{startFrame:20,endFrame:30}:{startFrame:10,endFrame:20};
  doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range});
 }
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++){
  expect(effectFrameAt(c,f)).toEqual(r(f-30));expect(c.clock.duration).toEqual(r(150));
 }
 expect(doc.sequenceEndFrame).toBe(300);
});
it.each(['register-first','restore-first'] as const)('preserves continuous effect clocks through %s, global2 and return',order=>{
 let doc=migrateLegacyWithCutHistory(input()).document;
 if(order==='register-first')doc=applySequenceCommand(register(doc),{type:'set-native-global-speed',rate:r(2)});
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
 if(order==='restore-first')doc=applySequenceCommand(register(doc),{type:'set-native-global-speed',rate:r(2)});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++)expect(effectFrameAt(c,f)).toEqual(r(f*2-30));
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++)expect(effectFrameAt(c,f)).toEqual(r(f-30));
});
it('keeps a manual effect clock unchanged while restoring an old subtitle band',()=>{
 let doc=migrateLegacyWithCutHistory(input()).document;const right=captions(doc)[1]!;right.clock.offset=r(77);
 const before=structuredClone(right.clock);doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
 expect(doc.clips.find(c=>c.id===right.id)!.clock).toEqual(before);
});

it.each([40,100])('preserves native cut clock intent at %i when an old band is restored first',start=>{
 let doc=migrateLegacyWithCutHistory(input()).document;
 doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:start,endFrame:start+10});
 const old=doc.cutArchive!.entries.find(e=>e.legacyRecovery)!;
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:old.id});
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++){
  expect(effectFrameAt(c,f)).toEqual(r(f-30));expect(c.clock.duration).toEqual(r(150));
 }
});

it.each([40,100])('retains the old subtitle usage when native cut %i is restored before its old band',start=>{
 let doc=migrateLegacyWithCutHistory(input()).document;
 doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:start,endFrame:start+10});
 const native=doc.cutArchive!.entries.find(e=>!e.legacyRecovery)!;
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:native.id});
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++){
  expect(effectFrameAt(c,f)).toEqual(r(f-30));expect(c.clock.duration).toEqual(r(150));
 }
});

it('can register after restoration without equalizing a witnessed manual clock',()=>{
 let doc=migrateLegacyWithCutHistory(input()).document;const id=captions(doc)[1]!.id;captions(doc)[1]!.clock.offset=r(77);
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
 const manual=structuredClone(doc.clips.find(c=>c.id===id)!.clock);
 doc=applySequenceCommand(register(doc),{type:'set-native-global-speed',rate:r(2)});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});
 expect(doc.clips.find(c=>c.id===id)!.clock).toEqual(manual);
});
it.each(['left','middle','right'] as const)('keeps registered partial restoration %s and save/reload clock intent',part=>{
 let doc=applySequenceCommand(register(migrateLegacyWithCutHistory(input()).document),{type:'set-native-global-speed',rate:r(2)});
 const range=part==='left'?{startFrame:0,endFrame:10}:part==='right'?{startFrame:20,endFrame:30}:{startFrame:10,endFrame:20};
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range});
 doc=JSON.parse(JSON.stringify(doc));validateSequenceDocument(doc);
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++)expect(effectFrameAt(c,f)).toEqual(r(f-30));
});

it('does not retime a separate same-asset subtitle usage or overwrite live body/style',()=>{
 let doc=migrateLegacyWithCutHistory(input()).document;const right=captions(doc)[1]!;
 if(right.content.kind!=='telop')throw Error('fixture');right.content.data.text='後半の手直し';right.content.data.template=8;
 const separate=structuredClone(right);separate.id='different-usage';delete separate.continuationGroupId;separate.trackId='extra-text';
 separate.clock.offset=r(88);doc.tracks.push({id:'extra-text',kind:'visual',name:'別の使用',enabled:true});doc.clips.push(separate);
 const clock=structuredClone(separate.clock),data=structuredClone(right.content.data);
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
 expect(doc.clips.find(c=>c.id===separate.id)!.clock).toEqual(clock);
 expect(doc.clips.find(c=>c.id===right.id)!.content).toMatchObject({data});
 expect(doc.clips.find(c=>c.id===right.id)!.clock.offset).toEqual(r(60));
});
it('saves restored effect intent and returns all document bytes through undo/redo',()=>{
 const directory=mkdtempSync(join(tmpdir(),'legacy-restored-clock-'));
 try{
  const initial=migrateLegacyWithCutHistory(input()).document,session=new SequenceSession('private-clock',initial),store=new SequenceStore(directory);
  store.save({expectedSavedRevision:null,executionId:'initial',document:initial});
  const restored=session.execute({sessionId:'private-clock',expectedRevision:initial.revision,executionId:'restore',command:{type:'restore-cut',entryId:initial.cutArchive!.entries[0]!.id}}).document;
  store.save({expectedSavedRevision:initial.revision,executionId:'saved',document:restored});expect(store.load()!.document).toEqual(restored);
  const undo=session.execute({sessionId:'private-clock',expectedRevision:restored.revision,executionId:'undo',command:{type:'undo'}}).document;
  expect({...undo,revision:initial.revision}).toEqual(initial);
  const redo=session.execute({sessionId:'private-clock',expectedRevision:undo.revision,executionId:'redo',command:{type:'redo'}}).document;
  expect({...redo,revision:restored.revision}).toEqual(restored);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it.each(['extra','clock','stream','source-window','role'] as const)('rejects malformed saved subtitle policy: %s',change=>{
 const doc=migrateLegacyWithCutHistory(input()).document;
 const policy=structuredClone(doc.cutArchive!.entries[0]!.clips.find(c=>c.content.kind==='telop')!.legacyCaptionContinuity)!;
 if(change==='extra')Object.assign(policy,{unowned:'path'});
 if(change==='clock')Object.assign(policy.witnesses[0]!.clock,{extra:1});
 if(change==='stream')policy.witnesses[0]!.streamIndex=-1;
 if(change==='source-window')policy.witnesses[0]!.sourceEnd=policy.witnesses[0]!.sourceStart;
 if(change==='role')Object.assign(policy.witnesses[0]!,{role:'music'});
 expect(isLegacyCaptionPolicy(policy)).toBe(false);
});

it.each([0,10,20])('extends subsequent old restoration after registered native recut, first local %i',first=>{
 let doc=applySequenceCommand(register(migrateLegacyWithCutHistory(input()).document),{type:'set-native-global-speed',rate:r(2)});
 doc=applySequenceCommand(doc,{type:'ripple-delete',startFrame:50,endFrame:55});
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries.find(e=>e.legacyRecovery)!.id,range:{startFrame:first,endFrame:first+10}});
 doc=JSON.parse(JSON.stringify(doc));validateSequenceDocument(doc);
 while(doc.cutArchive?.entries.some(e=>e.legacyRecovery))doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries.find(e=>e.legacyRecovery)!.id});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});
 // The independent native cut removes original130..140. Until that cut is
 // restored its source/effect jump is intentional, not a legacy clock reset.
 const uncutInput=input();uncutInput.project.cutRegions=[];
 const uncut=migrateLegacySequence(uncutInput).document;
 const expected=applySequenceCommand(uncut,{type:'ripple-delete',startFrame:130,endFrame:140});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++){
  const oracle=captions(expected).find(x=>f>=x.startFrame&&f<x.startFrame+x.durationFrames)!;
  expect(effectFrameAt(c,f),`frame${f}`).toEqual(effectFrameAt(oracle,f));expect(c.clock.duration).toEqual(r(150));
 }
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++)expect(effectFrameAt(c,f)).toEqual(r(f-30));
});

it.each([1,2])('restores old speed %i caption clocks to the real uncut migration oracle',speed=>{
 const cutInput=input();cutInput.project.mainSpeed=speed;
 let doc=migrateLegacyWithCutHistory(cutInput).document;
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range:{startFrame:0,endFrame:5}});
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 cutInput.project.cutRegions=[];const oracle=migrateLegacySequence(cutInput).document;
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++){
  const expected=captions(oracle).find(x=>f>=x.startFrame&&f<x.startFrame+x.durationFrames)!;
  expect(effectFrameAt(c,f)).toEqual(effectFrameAt(expected,f));expect(c.clock.duration).toEqual(expected.clock.duration);
 }
});
it('restores immediately after registration before the first global-speed change',()=>{
 let doc=register(migrateLegacyWithCutHistory(input()).document);expect(doc.speed!.version).toBe(2);
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(2)});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++)expect(effectFrameAt(c,f)).toEqual(r(f-30));
});
it('registers an explicitly witnessed manual clock before restoration without changing it',()=>{
 const doc=migrateLegacyWithCutHistory(input()).document,right=captions(doc)[1]!;right.clock.offset=r(77);
 const before=structuredClone(right.clock),registered=register(doc);
 expect(registered.clips.find(c=>c.id===right.id)!.clock).toEqual(before);
});

it.each([
 {start:30,split:0,rate:4,width:8},
 {start:30,split:0,rate:2,width:9},
 {start:30,split:32,rate:2,width:10},
 {start:30,split:32,rate:4,width:8},
 {start:31,split:32,rate:2,width:8},
])('uses exact intent through split/latent/odd restoration: %j',({start,split,rate,width})=>{
 const source=input();source.project.telops[0]!.originalStart=start;
 let doc=register(migrateLegacyWithCutHistory(source).document);
 if(split)doc=applySequenceCommand(doc,{type:'split',clipIds:[doc.clips.find(c=>c.content.kind==='video'&&c.startFrame===0)!.id],frame:split,linked:true});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(rate)});
 const hasLatent=captionLedgers(doc).some(l=>l.parts.some(p=>{const w=captionPartWindow(doc,p);return w.startFrame===w.endFrame;}));
 expect(hasLatent).toBe(split===32&&(rate===4||start===31));
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range:{startFrame:0,endFrame:width}});
 doc=JSON.parse(JSON.stringify(doc));validateSequenceDocument(doc);
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++){
  expect(effectFrameAt(c,f),`frame${f}`).toEqual(r(f-start));expect(c.clock.duration).toEqual(r(180-start));
 }
});

it('keeps the review one-frame right ledger visible at2 and restores its exact clock',()=>{
 const source=input();source.project.cutRegions=[{start:60,end:179}];
 let doc=applySequenceCommand(register(migrateLegacyWithCutHistory(source).document),{type:'set-native-global-speed',rate:r(2)});
 const right=captionLedgers(doc).find(l=>l.captionId==='legacy-telop-7-part-1')!;
 expect(right.parts.map(p=>captionPartWindow(doc,p))).toEqual([{startFrame:30,endFrame:31}]);
 expect(captionLedgers(doc).some(l=>l.parts.every(p=>{const w=captionPartWindow(doc,p);return w.startFrame===w.endFrame;}))).toBe(false);
 doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive!.entries[0]!.id,range:{startFrame:0,endFrame:8}});
 doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(1)});
 while(doc.cutArchive?.entries.length)doc=applySequenceCommand(doc,{type:'restore-cut',entryId:doc.cutArchive.entries[0]!.id});
 for(const c of captions(doc))for(let f=c.startFrame;f<c.startFrame+c.durationFrames;f++){
  expect(effectFrameAt(c,f)).toEqual(r(f-30));expect(c.clock.duration).toEqual(r(150));
 }
});
it.each([[59,2],[59,3],[59,4],[60,3],[60,4]])('rejects an all-hidden ledger before restoration, cut %i rate%i', (start,rate)=>{
 const source=input();source.project.cutRegions=[{start:start!,end:179}];
 const doc=register(migrateLegacyWithCutHistory(source).document),before=JSON.stringify(doc);
 expect(()=>applySequenceCommand(doc,{type:'set-native-global-speed',rate:r(rate!)})).toThrow('速度変更で字幕全体が表示できなくなります');
 expect(JSON.stringify(doc)).toBe(before);
});
