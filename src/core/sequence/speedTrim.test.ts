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
const registered=()=>applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});

const visible=(d:SequenceDocument)=>{const x=structuredClone(d);delete x.speed;for(const c of x.clips)delete c.speed;return sequenceContentBytes(x);};
describe('registered linked trim',()=>{
 it.each(['start','end'] as const)('matches ordinary %s trim with audio/source captions',edge=>{const command={type:'trim' as const,clipId:'video',edge,frame:2,linked:true};const next=applySequenceCommand(registered(),command);expect(visible(next)).toBe(visible(applySequenceCommand(fixture(),command)));validateSequenceDocument(next);});
});

import {type SequenceCommand} from './commands';
import {captionLedgers,captionPartWindow,materializeSpeedCaptions,refreshCaptionBaselines,speedProjectionForDocument} from './speedCaptionLedger';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {ScenePlan} from './scenePlan';
import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
import {parseSequence,serializeSequence} from './validate';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const unregistered=(d:SequenceDocument)=>{const x=structuredClone(d);delete x.speed;for(const c of x.clips)delete c.speed;return x;};
function equivalent(d:SequenceDocument,command:SequenceCommand){const expected=applySequenceCommand(unregistered(d),command),actual=applySequenceCommand(d,command);expect(visible(actual)).toBe(visible(expected));validateSequenceDocument(actual);expect(parseSequence(serializeSequence(actual))).toEqual(actual);return actual;}
const trim=(clipId:string,edge:'start'|'end',frame:number):SequenceCommand=>({type:'trim',clipId,edge,frame,linked:true});
function extended(){const d=fixture();d.sequenceEndFrame=12;for(const c of d.clips){c.startFrame+=4;if(c.content.kind==='video'||c.content.kind==='audio')c.content.sourceIn=r(10);if(c.anchor?.kind==='source'){c.anchor.sourceStart=r(12);c.anchor.sourceEnd=r(16);}c.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-7),rate:r(3),duration:r(30)}};}
return applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});}
describe('trim virtual projection and actual windows',()=>{
 it.each(['start','end'] as const)('extends %s within available source without moving other clips or restarting independent clocks',edge=>{
   const before=extended(),next=equivalent(before,trim('video',edge,edge==='start'?3:9));
   expect(next.sequenceEndFrame).toBe(12);const a=next.clips.find(c=>c.id==='audio')!;
   expect(a.clock.offset).toEqual(r(edge==='start'?-6:-3));expect(a.visual!.keyframeClock!.offset).toEqual(r(edge==='start'?-10:-7));
   expect(a.content.kind==='audio'&&a.content.sourceIn).toEqual(r(edge==='start'?8:10));
 });
 it.each([-2,3])('preserves ordinary signed-tail behavior for initial offset %s',tail=>{const d=registered();d.sequenceEndFrame=4+tail;d.speed!.sequenceEndBasis.offsetFrames=tail;validateSequenceDocument(d);const next=equivalent(d,trim('video','end',3));expect(next.sequenceEndFrame).toBe(Math.max(4+tail,3));expect(next.speed!.sequenceEndBasis.offsetFrames).toBe(next.sequenceEndFrame-3);});
 it('retains root and middle gaps and supports extending each boundary back, plus split after trim',()=>{
   const base=extended();let d=applySequenceCommand(base,{type:'split',clipIds:['video'],frame:6});d=applySequenceCommand(d,{type:'split',clipIds:[d.clips.find(c=>c.content.kind==='video'&&c.startFrame===6)!.id],frame:7});
   for(const entry of d.clips.filter(c=>c.content.kind==='video'))for(const edge of ['start','end'] as const){if(entry.durationFrames<2)continue;const cut=edge==='start'?entry.startFrame+1:entry.startFrame+entry.durationFrames-1;const once=equivalent(d,trim(entry.id,edge,cut));equivalent(once,trim(entry.id,edge,edge==='start'?entry.startFrame:entry.startFrame+entry.durationFrames));}
   // A middle fragment with two frames exposes a real gap on either edge.
   let wide=registered();wide.clips=wide.clips.filter(c=>c.content.kind!=='telop');for(const c of wide.clips)c.durationFrames=6;wide.sequenceEndFrame=6;for(const c of wide.clips){c.speed!.source.sourceEnd=r(12);if(c.speed!.kind==='main')c.speed!.span=r(12);}validateSequenceDocument(wide);
   wide=applySequenceCommand(wide,{type:'split',clipIds:['video'],frame:2});const right=wide.clips.find(c=>c.content.kind==='video'&&c.startFrame===2)!;wide=applySequenceCommand(wide,{type:'split',clipIds:[right.id],frame:4});
   for(const edge of ['start','end'] as const){const gapped=equivalent(wide,trim(right.id,edge,3));expect(gapped.clips.filter(c=>c.content.kind==='video').map(c=>[c.startFrame,c.durationFrames])).toEqual(edge==='start'?[[0,2],[3,1],[4,2]]:[[0,2],[2,1],[4,2]]);equivalent(gapped,trim(right.id,edge,edge==='start'?2:4));}
   const shortened=equivalent(extended(),trim('video','start',5));equivalent(shortened,{type:'split',clipIds:['video'],frame:6});
 });
 it('keeps original effect/key/audio fade origin after root trim and literal2 ->1 ->2',()=>{
   const source=fixture();source.clips[0]!.clock={offset:r(0),rate:r(1),duration:r(8)};source.clips[1]!.clock={offset:r(0),rate:r(1),duration:r(8)};
   for(const c of source.clips.slice(0,2))c.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-7),rate:r(3),duration:r(30)}};
   if(source.clips[1]!.content.kind==='audio')source.clips[1]!.content.settings.fadeInFrames=4;
   const d=applySequenceCommand(source,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});const cut=equivalent(d,trim('video','start',1));
   const beforeAudio=d.clips.find(c=>c.id==='audio')!,cutAudio=cut.clips.find(c=>c.id==='audio')!;expect(new ScenePlan(cut).audioGain(cutAudio,2)).toBe(new ScenePlan(d).audioGain(beforeAudio,2));
   const slow=structuredClone(cut);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=8;
   for(const c of slow.clips)if(c.speed){c.startFrame=2;c.durationFrames=6;if(c.content.kind==='video'||c.content.kind==='audio'){c.content.rate=r(1);c.content.sourceIn=r(2);}c.clock={offset:r(1),rate:r(1,2),duration:r(8)};c.visual!.keyframeClock={offset:r(-4),rate:r(3,2),duration:r(30)};}
   slow.clips=slow.clips.filter(c=>c.content.kind!=='telop').concat(materializeSpeedCaptions(slow));validateSequenceDocument(slow);
   expect(speedProjectionForDocument(slow).rootStart('video')).toBe(0);expect(slow.clips[0]!.startFrame).toBe(2);
   expect(parseSequence(serializeSequence(slow))).toEqual(slow);
   const restored=structuredClone(slow);restored.speed!.globalRate=r(2);restored.sequenceEndFrame=4;
   for(const c of restored.clips)if(c.speed){c.startFrame=1;c.durationFrames=3;if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(2);c.clock.rate=r(1);c.visual!.keyframeClock!.rate=r(3);}
   restored.clips=restored.clips.filter(c=>c.content.kind!=='telop').concat(materializeSpeedCaptions(restored));validateSequenceDocument(restored);expect(restored).toEqual(cut);
 });
 it('preserves latent intent still in the kept window, and explicitly removes cut-away intent without resurrecting it on extension',()=>{
   const d=fixture();d.clips[2]!.durationFrames=1;d.clips[2]!.anchor={kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(2),sourceEnd:r(4)};
   let reg=applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});reg=applySequenceCommand(reg,{type:'upgrade-native-speed'});
   const ledger=captionLedgers(reg)[0]!;ledger.parts[0]!.intentStart=r(1);ledger.parts[0]!.intentEnd=r(3);refreshCaptionBaselines(reg);validateSequenceDocument(reg);
   const cut=equivalent(reg,trim('video','end',1));expect(cut.clips.some(c=>c.content.kind==='telop')).toBe(false);expect(captionLedgers(cut)).toHaveLength(1);expect(captionPartWindow(cut,captionLedgers(cut)[0]!.parts[0]!)).toEqual({startFrame:1,endFrame:1});
   const removed=equivalent(registered(),trim('video','start',3));expect(captionLedgers(removed)).toHaveLength(0);expect(removed.clips.some(c=>c.speed?.captionBaselines)).toBe(false);const extended=equivalent(removed,trim('video','start',0));expect(extended.clips.some(c=>c.content.kind==='telop')).toBe(false);
 });
 it('preserves a 20-frame overlap and later positions when trimming the last displayed owner',()=>{
   const d=fixture();d.clips=d.clips.slice(0,2);d.sequenceEndFrame=180;for(const c of d.clips){c.durationFrames=100;if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);}for(const a of d.assets[0]!.streams!)a.duration=r(1000);
   const v={...structuredClone(d.clips[0]!),id:'second',startFrame:80,linkGroupId:'second-link'},a={...structuredClone(d.clips[1]!),id:'second-audio',trackId:'a2',startFrame:80,linkGroupId:'second-link'};d.tracks.push({id:'a2',kind:'audio',name:'a2',enabled:true});d.clips.push(v,a);d.transitions=[{id:'cross',kind:'crossfade',trackId:'v',outClipId:'video',inClipId:'second',startFrame:80,durationFrames:20}];
   const reg=applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video','second'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'},{audioClipId:'second-audio',providerId:'second'}]});
   const cut=equivalent(reg,trim('second','end',150));expect(cut.transitions).toEqual(reg.transitions);expect(cut.sequenceEndFrame).toBe(180);expect(cut.speed!.sequenceEndBasis.offsetFrames).toBe(30);expect(speedProjectionForDocument(cut).mainEndFrame).toBe(150);
   expect(()=>applySequenceCommand(reg,trim('second','start',90))).toThrow(/転換/);
 });
 it('keeps linked:false explicitly separate, and makes trim replay/Undo/Store and failed batch atomic',()=>{
   const before=registered();const detached=applySequenceCommand(before,{type:'trim',clipId:'video',edge:'start',frame:1,linked:false});const expected=applySequenceCommand(unregistered(before),{type:'trim',clipId:'video',edge:'start',frame:1,linked:false});for(const c of expected.clips)if(c.linkGroupId==='linked')delete c.linkGroupId;expect(visible(detached)).toBe(visible(expected));expect(detached.clips.find(c=>c.id==='audio')!.speed?.kind).toBe('independent-audio');
   const session=new SequenceSession('trim',before),request={sessionId:'trim',expectedRevision:before.revision,executionId:'trim',command:trim('video','start',1)};const first=session.execute(request);expect(session.execute(request).replayed).toBe(true);
   const directory=mkdtempSync(join(tmpdir(),'native-trim-'));try{const store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'save',document:first.document});expect(store.load()!.document).toEqual(first.document);}finally{rmSync(directory,{recursive:true,force:true});}
   const undo=session.execute({sessionId:'trim',expectedRevision:first.document.revision,executionId:'undo',command:{type:'undo'}}).document;expect(visible(undo)).toBe(visible(before));expect(undo.speed).toEqual(before.speed);
   const fail=new SequenceSession('bad',before);expect(()=>fail.execute({sessionId:'bad',expectedRevision:before.revision,executionId:'bad',command:{type:'batch',commands:[trim('video','end',2),{type:'update-clip',clipId:'missing',patch:{name:'x'}}]}})).toThrow();expect(fail.document).toEqual(before);expect(fail.canUndo).toBe(false);
 });
});

describe('trim metadata constraints and absolute phase',()=>{
 it.each(['offset-null','extent-negative','extent-missing','source-origin','child-extent','child-source','unknown','dangling-root'] as const)('rejects %s instead of treating a saved field as a free correction',kind=>{
   let d=equivalent(registered(),trim('video','start',1));d=applySequenceCommand(d,{type:'split',clipIds:['video'],frame:2});const root=d.clips.find(c=>c.id==='video')!.speed!,child=d.clips.find(c=>c.content.kind==='video'&&c.id!=='video')!.speed!;
   if(root.kind!=='main'||child.kind!=='main')throw Error('fixture');
   if(kind==='offset-null')root.projectionOffset=null as never;
   if(kind==='extent-negative')root.projectionExtent=r(-1);
   if(kind==='extent-missing')delete root.projectionExtent;
   if(kind==='source-origin')root.evaluationSourceStart=r(1);
   if(kind==='child-extent')child.projectionExtent=r(8);
   if(kind==='child-source')child.evaluationSourceStart=r(0);
   if(kind==='unknown')Object.assign(child,{projectionShift:4});
   if(kind==='dangling-root')child.evaluationOwnerId='missing';
   expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>parseSequence(JSON.stringify(d))).toThrow();
 });
 it('keeps phase source intent separate from coverage while trimming root, then restores exact metadata at2 ->1 ->2',()=>{
   const doc=fixture();doc.clips=[3,601].map((length,i)=>({...structuredClone(doc.clips[0]!),id:`main${i}`,linkGroupId:undefined,startFrame:i===0?0:3,durationFrames:length,clock:{offset:r(0),rate:r(1),duration:r(1000)},content:{kind:'video' as const,assetId:'asset',streamIndex:0,sourceIn:r(i===0?0:10),rate:r(1)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-7),rate:r(3),duration:r(1000)}}}));doc.sequenceEndFrame=604;for(const stream of doc.assets[0]!.streams!)stream.duration=r(2000);
   let d=applySequenceCommand(doc,{type:'register-native-speed',groupId:'phase',mainClipIds:['main0','main1'],mainAudioBindings:[]});d.speed!.globalRate=r(2);d.sequenceEndFrame=302;
   d.clips[0]!.durationFrames=2;d.clips[1]!.startFrame=2;d.clips[1]!.durationFrames=300;for(const c of d.clips){if(c.content.kind!=='video')throw Error('fixture');c.content.rate=r(2);c.clock.rate=r(2);c.visual!.keyframeClock!.rate=r(6);}validateSequenceDocument(d);
   d=applySequenceCommand(d,{type:'split',clipIds:['main1'],frame:10});const cut=equivalent(d,trim('main1','start',3));
   expect(cut.clips.map(c=>[c.startFrame,c.durationFrames,c.content.kind==='video'?c.content.sourceIn:null,c.clock.offset])).toEqual([[0,2,r(0),r(0)],[3,7,r(12),r(2)],[10,292,r(26),r(16)]]);
   expect(cut.clips[1]!.speed!.source.sourceStart).toEqual(r(13));expect(cut.clips[1]!.speed!.evaluationSourceStart).toEqual(r(10));
   const slow=structuredClone(cut);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=604;const windows=[[0,3,0,0],[6,14,13,3],[20,584,27,17]];
   for(const [i,c] of slow.clips.entries()){const [start,duration,source,elapsed]=windows[i]!;c.startFrame=start!;c.durationFrames=duration!;if(c.content.kind!=='video')throw Error('fixture');c.content.rate=r(1);c.content.sourceIn=r(source!);c.clock.offset=r(elapsed!);c.clock.rate=r(1);c.visual!.keyframeClock!.offset=r(-7+3*elapsed!);c.visual!.keyframeClock!.rate=r(3);}
   validateSequenceDocument(slow);expect(slow.clips.map(c=>c.speed)).toEqual(cut.clips.map(c=>c.speed));
   const restored=structuredClone(slow);restored.speed!.globalRate=r(2);restored.sequenceEndFrame=302;const back=[[0,2,0,0],[3,7,12,2],[10,292,26,16]];
   for(const [i,c] of restored.clips.entries()){const [start,duration,source,elapsed]=back[i]!;c.startFrame=start!;c.durationFrames=duration!;if(c.content.kind!=='video')throw Error('fixture');c.content.rate=r(2);c.content.sourceIn=r(source!);c.clock.offset=r(elapsed!);c.clock.rate=r(2);c.visual!.keyframeClock!.offset=r(-7+3*elapsed!);c.visual!.keyframeClock!.rate=r(6);}
   validateSequenceDocument(restored);expect(restored).toEqual(cut);
 });
});
