import {describe,it,expect} from 'vitest';
import {migrateLegacySequence,type LegacyMigrationInput} from './migrateLegacy';
import {migrateLegacyWithCutHistory} from './migrateLegacyWithCutHistory';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {buildLegacyCutHistoryCommand} from './legacyCutBackfill';
import {resolveCutBoundary} from './cutArchive';
import {validateSequenceDocument} from './validate';
import {SequenceSession} from './session';
import {rational as r} from './time';
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

const adoption=(source:LegacyMigrationInput)=>({type:'adopt-legacy-cut-history',sourceFingerprint:source.sourceFingerprint,entries:migrateLegacyWithCutHistory(source).document.cutArchive!.entries} as unknown as SequenceCommand);
describe('legacy history adoption',()=>{
 it('marks first migration independently from consumable bands',()=>{const source=input();let d=migrateLegacyWithCutHistory(source).document;expect(d.legacy).toHaveProperty('cutHistoryImport',{version:1,sourceFingerprint:source.sourceFingerprint});d=applySequenceCommand(d,{type:'restore-cut',entryId:d.cutArchive!.entries[0]!.id});expect(d.cutArchive).toBeUndefined();expect(d.legacy).toHaveProperty('cutHistoryImport');});
 it('adds bands without changing a current caption edit and makes one undo',()=>{const source=input();const d=migrateLegacySequence(source).document;d.clips.find(c=>c.content.kind==='telop')!.name='人の編集';const session=new SequenceSession('session',d);const result=session.execute({sessionId:'session',expectedRevision:0,executionId:'adopt',command:adoption(source)});expect(result.document.clips).toEqual(d.clips);expect(result.document.cutArchive?.entries).toHaveLength(1);const undone=session.execute({sessionId:'session',expectedRevision:1,executionId:'undo',command:{type:'undo'}});expect({...undone.document,revision:0}).toEqual(d);});
 it('cannot import the same history again after every band has been restored',()=>{const source=input();let d=applySequenceCommand(migrateLegacySequence(source).document,adoption(source));d=applySequenceCommand(d,{type:'restore-cut',entryId:d.cutArchive!.entries[0]!.id});const snapshot=JSON.stringify(d);expect(()=>applySequenceCommand(d,adoption(source))).toThrow(/引き継ぎ済み/);expect(JSON.stringify(d)).toBe(snapshot);});
});

const plan=(current:ReturnType<typeof migrateLegacySequence>['document'],source=input())=>buildLegacyCutHistoryCommand(current,migrateLegacySequence(source).document,migrateLegacyWithCutHistory(source).document);
it('keeps an unrelated native archive while adding the old source bands',()=>{const source=input();let d=migrateLegacySequence(source).document;d=applySequenceCommand(d,{type:'ripple-delete',startFrame:200,endFrame:210});const prior=structuredClone(d.cutArchive),live=structuredClone(d.clips);const next=applySequenceCommand(d,plan(d,source));expect(next.cutArchive!.entries.slice(0,prior!.entries.length)).toEqual(prior!.entries);expect(next.clips).toEqual(live);expect(new Set(next.cutArchive!.entries.flatMap(e=>e.clips.map(c=>c.id))).size).toBe(next.cutArchive!.entries.flatMap(e=>e.clips).length);});
it('maps an explicit split descendant and follows moved agreeing AV boundaries',()=>{const source=input();let d=migrateLegacySequence(source).document;d=applySequenceCommand(d,{type:'split',clipIds:['legacy-video-1'],frame:30});let e=plan(d,source).entries[0]!;expect(resolveCutBoundary(d,e).frame).toBe(60);d=applySequenceCommand(d,{type:'move',clipIds:d.clips.filter(c=>c.content.kind==='video').map(c=>c.id),deltaFrames:10});e=plan(d,source).entries[0]!;expect(resolveCutBoundary(d,e).frame).toBe(70);});
it.each(['unlink','trim','missing','duplicate'] as const)('does not infer a boundary from %s source owners',mode=>{const source=input();let d=migrateLegacySequence(source).document;
 if(mode==='unlink'){d=applySequenceCommand(d,{type:'unlink',clipIds:['legacy-video-1']});d=applySequenceCommand(d,{type:'add-track',track:{id:'moved',kind:'visual',name:'移動先',enabled:true}});d=applySequenceCommand(d,{type:'move',clipIds:['legacy-video-1'],deltaFrames:5,trackId:'moved',linked:false});}
 if(mode==='trim')d=applySequenceCommand(d,{type:'trim',clipId:'legacy-video-1',edge:'end',frame:50});
 if(mode==='missing')d=applySequenceCommand(d,{type:'delete',clipIds:['legacy-video-1']});
 if(mode==='duplicate'){const c=structuredClone(d.clips.find(c=>c.id==='legacy-video-1')!);c.id='duplicate';c.continuationGroupId='legacy-video-1';c.trackId='duplicate-track';delete c.linkGroupId;d.tracks.push({id:'duplicate-track',kind:'visual',name:'複製',enabled:true});d.clips.push(c);}
 const e=plan(d,source).entries[0]!;expect(resolveCutBoundary(d,e).frame).toBeNull();const next=applySequenceCommand(d,plan(d,source));expect(next.clips).toEqual(d.clips);});
it('requires explicit position after all historic owners disappeared',()=>{const source=input();let d=migrateLegacySequence(source).document;d=applySequenceCommand(d,{type:'delete',clipIds:d.clips.map(c=>c.id),linked:false});const next=applySequenceCommand(d,plan(d,source)),entry=next.cutArchive!.entries[0]!;expect(resolveCutBoundary(next,entry).frame).toBeNull();expect(()=>applySequenceCommand(next,{type:'restore-cut',entryId:entry.id,atFrame:0})).not.toThrow();});
it('rejects source/marker tampering and native-imported projects atomically',()=>{const source=input(),d=migrateLegacySequence(source).document,cmd=adoption(source);delete d.legacy;expect(()=>applySequenceCommand(d,cmd)).toThrow(/移行元/);const withLegacy=migrateLegacySequence(source).document;withLegacy.legacy!.cutHistoryImport={version:1,sourceFingerprint:'b'.repeat(64)};expect(()=>validateSequenceDocument(withLegacy)).toThrow(/引き継ぎ記録/);});

it.each([{rate:1,split:false},{rate:2,split:false},{rate:2,split:true}])('imports old bands after explicit main registration, speed $rate and split $split without rewriting live edits',({rate,split})=>{
 const source=input();let d=migrateLegacySequence(source).document;
 if(split)d=applySequenceCommand(d,{type:'split',clipIds:['legacy-video-1'],frame:30});
 d=applySequenceCommand(d,{type:'register-native-speed',groupId:'main',mainClipIds:d.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame).map(c=>c.id),mainAudioBindings:d.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:d.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))});
 if(rate!==1)d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(rate)});
 const before=structuredClone(d),command=plan(d,source);d=applySequenceCommand(d,command);
 expect(d.clips).toEqual(before.clips);expect(d.speed).toEqual(before.speed);
 const entry=d.cutArchive!.entries[0]!;expect(resolveCutBoundary(d,entry).frame).toBe(60/rate);
 d=applySequenceCommand(d,{type:'restore-cut',entryId:entry.id});
 expect(d.sequenceEndFrame).toBe(300/rate);
 expect(d.clips.filter(c=>c.content.kind==='video').every(c=>c.speed?.kind==='main')).toBe(true);
 if(rate!==1)d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(1)});
 expect(d.sequenceEndFrame).toBe(300);validateSequenceDocument(d);
});
it('leaves a wholly removed source as ambiguous without inventing a current seam',()=>{const source=input();source.project.cutRegions=[{start:0,end:300}];const d=migrateLegacySequence(source).document;const command=plan(d,source);expect(command.entries[0]!.boundary.ambiguous).toBe(true);expect(()=>applySequenceCommand(d,command)).not.toThrow();});
it('imports healthy bands when one registered boundary has been unlinked, without inventing its missing role proof',()=>{
 const source=input();source.project.cutRegions=[{start:60,end:90},{start:210,end:240}];
 let d=migrateLegacySequence(source).document;
 const videos=d.clips.filter(c=>c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
 d=applySequenceCommand(d,{type:'register-native-speed',groupId:'main',mainClipIds:videos.map(c=>c.id),mainAudioBindings:videos.flatMap(v=>d.clips.filter(c=>c.content.kind==='audio'&&c.linkGroupId===v.linkGroupId).map(c=>({audioClipId:c.id,providerId:v.id})))});
 d=applySequenceCommand(d,{type:'unlink',clipIds:[videos[0]!.id]});
 const before=structuredClone(d),command=plan(d,source),session=new SequenceSession('private',d);
 const imported=session.execute({sessionId:'private',expectedRevision:d.revision,executionId:'adopt',command}).document;
 expect(imported.clips).toEqual(before.clips);expect(imported.speed).toEqual(before.speed);
 expect(imported.cutArchive!.entries).toHaveLength(2);
 const unproven=imported.cutArchive!.entries.find(e=>e.legacyRecovery!.originalStart===60)!;
 const healthy=imported.cutArchive!.entries.find(e=>e.legacyRecovery!.originalStart===210)!;
 expect(unproven.speed).toBeUndefined();expect(healthy.speed).toBeDefined();
 expect(imported.legacy!.cutHistoryImport).toBeDefined();validateSequenceDocument(imported);
 const snapshot=JSON.stringify(imported);
 expect(()=>applySequenceCommand(imported,{type:'restore-cut',entryId:unproven.id})).toThrow(/速度登録/);
 expect(JSON.stringify(imported)).toBe(snapshot);
 const restored=applySequenceCommand(imported,{type:'restore-cut',entryId:healthy.id});
 expect(restored.sequenceEndFrame).toBe(before.sequenceEndFrame+30);
 expect(restored.cutArchive!.entries.map(e=>e.id)).toEqual([unproven.id]);
 const undone=session.execute({sessionId:'private',expectedRevision:imported.revision,executionId:'undo',command:{type:'undo'}}).document;
 expect({...undone,revision:before.revision}).toEqual(before);
});
it('rejects a reused legacy ID with different source intent',()=>{const source=input();const d=migrateLegacySequence(source).document;const c=d.clips.find(c=>c.id==='legacy-video-1')!;if(c.content.kind!=='video')throw new Error('video');c.content.sourceIn=r(1);expect(plan(d,source).entries[0]!.boundary.ambiguous).toBe(true);});
