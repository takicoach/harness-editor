import {describe,it,expect} from 'vitest';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {DEFAULT_TEXT_APPEARANCE,type SequenceDocument} from './model';
import {rational as r} from './time';
import {sequenceContentBytes,serializeSequence,parseSequence,validateSequenceDocument} from './validate';
import {SequenceSession} from './session';
import {planVideoSourceRegions} from './videoSourceRegions';
import {planAudioSourceRegions} from './audioSourceRegions';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {visualKeyframeTime,sampleVisualTransform} from './visualTransform';

describe('insert own explicit motion clock rebase',()=>{
 const registered=()=>{
  const d=ownFixture();d.clips[0]!.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.7,keyframes:[{frame:r(0),value:{opacity:0}},{frame:r(10),value:{opacity:1}}]};
  return applySequenceCommand(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
 };
 const rebase=(clock:unknown)=>({type:'rebase-native-insert-own-keyframe-clock',clipId:'iv',clock} as SequenceCommand);
 it('changes motion only at the current rate and restores that intent through speed changes',()=>{
  const source=registered(),snapshot=structuredClone(source),value={offset:r(-7,3),rate:r(9,2),duration:r(45)};
  const edited=applySequenceCommand(source,rebase(value)),clip=edited.clips[0]!;
  expect(source).toEqual(snapshot);expect(edited.clips[1]).toEqual(source.clips[1]);
  expect(clip.insertOwnSpeed).toEqual({...source.clips[0]!.insertOwnSpeed,keyframeClock:{offset:r(-7,3),slope:r(9,10),duration:r(45)}});
  expect(edited.sequenceEndFrame).toBe(source.sequenceEndFrame);expect(clip.linkGroupId).toBe('pair');
  expect(visualKeyframeTime(clip,7)).toEqual(r(20,3));
  expect(sampleVisualTransform(source.clips[0]!,7).opacity).toBeCloseTo(.2,12);
  expect(sampleVisualTransform(clip,7).opacity).toBeCloseTo(2/3,12);
  const slow=applySequenceCommand(edited,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true});
  expect(slow.clips[0]!.visual!.keyframeClock!.rate).toEqual(r(9,5));
  const back=applySequenceCommand(slow,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true});
  expect(bytes(back)).toBe(bytes(edited));expect(bytes(parseSequence(serializeSequence(back)))).toBe(bytes(edited));
  value.offset.num=999;expect(clip.visual!.keyframeClock!.offset).toEqual(r(-7,3));
 });
 it('removes the separate motion clock and uses the unchanged effect clock',()=>{
  const source=registered(),edited=applySequenceCommand(source,rebase({offset:r(1),rate:r(4),duration:r(8)}));
  const reset=applySequenceCommand(edited,rebase(null));expect(bytes(reset)).toBe(bytes(source));
  expect(visualKeyframeTime(reset.clips[0]!,7)).toEqual(r(2));
  expect(applySequenceCommand(reset,rebase(null))).toBe(reset);
 });
 it('retains sourceLimit and non-integral exposure after a rounded split',()=>{
  let d=registered();d=applySequenceCommand(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(16),linked:true});
  d=applySequenceCommand(d,{type:'split',clipIds:['iv'],frame:6,linked:true});
  const c=d.clips.find(c=>c.id==='iv')!,before=structuredClone(c.insertOwnSpeed!);
  const next=applySequenceCommand(d,rebase({offset:r(-3),rate:r(7),duration:r(100)}));
  expect(next.clips.find(c=>c.id==='iv')!.insertOwnSpeed).toEqual({...before,keyframeClock:{offset:r(-3),slope:r(7,16),duration:r(100)}});
 });
 it('treats equivalent fractions as no-op and keeps one Undo record',()=>{
  const session=new SequenceSession('clock',registered());let id=0;
  const run=(command:SequenceCommand|{type:'undo'}|{type:'redo'})=>session.execute({sessionId:'clock',expectedRevision:session.document.revision,executionId:String(++id),command});
  const before=session.document;run(rebase({offset:r(-3),rate:r(2),duration:r(8)}));const edited=session.document;
  expect(run(rebase({offset:r(-6,2),rate:r(4,2),duration:r(16,2)})).changed).toBe(false);
  run({type:'undo'});expect(bytes(session.document)).toBe(bytes(before));run({type:'redo'});expect(bytes(session.document)).toBe(bytes(edited));
 });
 it.each([undefined,false,[],{}, {offset:r(0),rate:r(0),duration:r(1)}, {offset:r(0),rate:r(-1),duration:r(1)}, {offset:r(0),rate:r(1),duration:r(0)}, {offset:{num:0,den:0},rate:r(1),duration:r(1)}, {offset:r(0),rate:r(1),duration:r(1),extra:1}, {offset:{num:0,den:1,extra:1},rate:r(1),duration:r(1)}])('rejects malformed clock atomically: %j',value=>{
  const d=registered(),snapshot=structuredClone(d);
  expect(()=>applySequenceCommand(d,{type:'batch',commands:[rebase({offset:r(1),rate:r(3),duration:r(10)}),rebase(value)]})).toThrow();expect(d).toEqual(snapshot);
 });
 it('rejects unregistered, nonvisual and missing targets, preserving AV links',()=>{
  expect(()=>applySequenceCommand(ownFixture(),rebase(null))).toThrow();const d=registered();
  for(const clipId of ['ia','missing'])expect(()=>applySequenceCommand(d,{...rebase(null),clipId} as SequenceCommand)).toThrow();
  expect(d.clips.map(c=>c.linkGroupId)).toEqual(['pair','pair']);
 });
 it('rejects an unregistered visual before treating a clock reset as no-op',()=>{
  const d=ownFixture();d.clips[0]!.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]};
  const before=structuredClone(d);
  expect(()=>applySequenceCommand(d,rebase(null))).toThrowError('動きの設定がある登録済みの挿入素材を選んでください');
  expect(d).toEqual(before);
 });
 it('keeps the generic property guard after explicitly rebasing the clock',()=>{
  const d=applySequenceCommand(registered(),rebase({offset:r(0),rate:r(2),duration:r(10)})),before=structuredClone(d);
  expect(()=>applySequenceCommand(d,{type:'update-clip',clipId:'iv',patch:{visual:{...d.clips[0]!.visual!,keyframeClock:{offset:r(0),rate:r(9),duration:r(10)}}}})).toThrowError('挿入の独立キー時計は専用の再基準化が必要です');
  expect(d).toEqual(before);
 });
});

export function ownFixture():SequenceDocument {
 return {schemaVersion:2,id:'own-test',name:'挿入',revision:0,fps:r(1),resolution:{width:320,height:180},sequenceEndFrame:10,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
 assets:[{id:'asset',kind:'media',name:'素材',file:'media/test.mp4',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),frameRate:r(30),width:320,height:180},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
 tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true}],
 clips:[{id:'iv',trackId:'v',name:'挿入映像',startFrame:5,durationFrames:5,linkGroupId:'pair',clock:{offset:r(-2),rate:r(2),duration:r(40)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(10),rate:r(5)}},
 {id:'ia',trackId:'a',name:'挿入原音',startFrame:5,durationFrames:5,linkGroupId:'pair',clock:{offset:r(-3),rate:r(3),duration:r(50)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(10),rate:r(5),role:'speech',loop:false,settings:{gainDb:-2,muted:false,fadeInFrames:3,fadeOutFrames:4}}}]};
}
const apply=(d:SequenceDocument,c:unknown)=>applySequenceCommand(d,c as SequenceCommand);
const bytes=(d:SequenceDocument)=>sequenceContentBytes({...d,revision:0});
describe('fixed native insert-own',()=>{
 it('restores D5/r1→r3/D2→r1/D5 rather than the legacy D6',()=>{
  const source=ownFixture();for(const c of source.clips)if(c.content.kind==='audio'||c.content.kind==='video')c.content.rate=r(1);
  const input=apply(source,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  const quick=apply(input,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(3),linked:true});expect(quick.clips.map(c=>c.durationFrames)).toEqual([2,2]);
  const back=apply(quick,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(1),linked:true});expect(bytes(back)).toBe(bytes(input));expect(back.clips[0]!.durationFrames).toBe(5);
 });
 it('retains the finite source end across a rounded split, through public video/audio planners',()=>{
  const source=ownFixture();source.fps=r(30);source.sequenceEndFrame=155;for(const c of source.clips){c.startFrame=150;if(c.content.kind==='audio'||c.content.kind==='video')c.content.rate=r(1);}
  const input=apply(source,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  const quick=apply(input,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(3),linked:true});
  const cut=apply(quick,{type:'split',clipIds:['iv'],frame:151,linked:true}),windows=planVideoSourceRegions(cut);
  for(const c of cut.clips.filter(c=>c.content.kind==='video'))expect(windows.get(c.id)).toEqual({start:r(10),end:r(61,6)});
  expect(planAudioSourceRegions(cut).regions).toHaveLength(1);expect(planAudioSourceRegions(cut).regions[0]).toMatchObject({start:r(10),end:r(61,6)});
  expect(bytes(parseSequence(serializeSequence(cut)))).toBe(bytes(cut));
 });
 it.each(['move','trim','split','delete'])('separates an actual one-sided %s and retains unrelated audio',kind=>{
  const d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});const audio=structuredClone(d.clips[1]!);delete audio.linkGroupId;
  const command=kind==='move'?{type:kind,clipIds:['iv'],deltaFrames:1,linked:false}:kind==='trim'?{type:kind,clipId:'iv',edge:'start',frame:6,linked:false}:kind==='split'?{type:kind,clipIds:['iv'],frame:6,linked:false}:{type:kind,clipIds:['iv'],linked:false};
  const next=apply(d,command);expect(next.clips.find(c=>c.id==='ia')).toEqual(audio);expect(next.clips.every(c=>!c.linkGroupId)).toBe(true);
 });
 it('explicitly registers and restores linked 5→2→5 without rounded drift',()=>{
  const input=ownFixture(),registered=apply(input,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  const slow=apply(registered,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true});
  expect(slow.clips.map(c=>[c.startFrame,c.durationFrames])).toEqual([[5,13],[5,13]]);
  expect(slow.sequenceEndFrame).toBe(18);
  expect(bytes(apply(slow,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true}))).toBe(bytes(registered));
  expect(input).toEqual(ownFixture());
 });
 it('keeps later ordinary additions after the own extension shrinks',()=>{
  let d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true});
  d=apply(d,{type:'add-track',track:{id:'extra-track',kind:'visual',name:'別素材',enabled:true}});
  const extra=structuredClone(ownFixture().clips[0]!);extra.id='extra';extra.trackId='extra-track';delete extra.linkGroupId;extra.startFrame=12;extra.durationFrames=3;
  d=apply(d,{type:'insert',clips:[extra]});d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true});
  expect(d.sequenceEndFrame).toBe(15);expect(d.clips.find(c=>c.id==='extra')).toEqual(extra);
 });
 it('keeps global/main clocks separate and restores their floor after both kinds of speed edits',()=>{
  let d=ownFixture();const main=structuredClone(d.clips[0]!);main.id='main';main.startFrame=0;main.durationFrames=4;delete main.linkGroupId;if(main.content.kind==='video'){main.content.rate=r(1);main.content.sourceIn=r(0);}d.clips.unshift(main);
  d=apply(d,{type:'register-native-speed',groupId:'g',mainClipIds:['main'],mainAudioBindings:[]});d=apply(d,{type:'upgrade-native-speed-operations'});
  d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});const original=bytes(d),own=structuredClone(d.clips.filter(c=>c.insertOwnSpeed));
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true});
  d=apply(d,{type:'set-native-global-speed',rate:r(2)});expect(d.sequenceEndFrame).toBe(18);
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true});expect(d.sequenceEndFrame).toBe(10);expect(d.clips.filter(c=>c.insertOwnSpeed)).toEqual(own);
  d=apply(d,{type:'set-native-global-speed',rate:r(1)});expect(bytes(d)).toBe(original);
 });
 it.each([90,94])('preserves signed completion floor and atomically handles last-own deletion, end=%s',initialEnd=>{
  let d=ownFixture();d.sequenceEndFrame=initialEnd;
  d.tracks.push({id:'main-track',kind:'visual',name:'main',enabled:true});
  const main=structuredClone(d.clips[0]!);main.id='main';main.trackId='main-track';main.startFrame=0;main.durationFrames=100;delete main.linkGroupId;
  if(main.content.kind==='video'){main.content.rate=r(1);main.content.sourceIn=r(0);}d.clips.unshift(main);
  d=apply(d,{type:'register-native-speed',groupId:'g',mainClipIds:['main'],mainAudioBindings:[]});d=apply(d,{type:'upgrade-native-speed-operations'});
  d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});const original=bytes(d);
  d=apply(d,{type:'set-native-global-speed',rate:r(16)});expect(d.insertOwnSpeed!.endFloor).toBe(initialEnd-94);expect(d.sequenceEndFrame).toBe(10);
  const saved=bytes(d);
  if(initialEnd===90){expect(()=>apply(d,{type:'delete',clipIds:['iv'],linked:true})).toThrow(/完成尺が負/);expect(bytes(d)).toBe(saved);}
  else {const removed=apply(d,{type:'delete',clipIds:['iv'],linked:true});expect(removed.sequenceEndFrame).toBe(0);expect(removed.insertOwnSpeed).toBeUndefined();expect(removed.clips[0]!.durationFrames).toBe(6);}
  d=parseSequence(serializeSequence(d));d=apply(d,{type:'set-native-global-speed',rate:r(1)});expect(bytes(d)).toBe(original);
 });
 it('moves only the anchor and explicitly rebases trim/source edits without restarting fades',()=>{
  let d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});const basis=structuredClone(d.clips[0]!.insertOwnSpeed!);
  d=apply(d,{type:'move',clipIds:['iv'],deltaFrames:2,linked:true});expect(d.clips[0]!.insertOwnSpeed).toEqual({...basis,placement:{...basis.placement,startFrame:7}});
  d=apply(d,{type:'trim',clipId:'iv',edge:'start',frame:8,linked:true});
  expect(d.clips[0]!.clock.offset).toEqual(r(0));expect(d.clips[1]!.clock.offset).toEqual(r(0));
  expect(d.clips.map(c=>c.insertOwnSpeed!.placement.exposure)).toEqual([r(20),r(20)]);
  d=apply(d,{type:'rebase-native-insert-own-source',clipId:'iv',sourceIn:r(20),linked:true});expect(d.clips.map(c=>c.insertOwnSpeed!.source.sourceEnd)).toEqual([r(40),r(40)]);
  const original=bytes(d);d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true});d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true});expect(bytes(d)).toBe(original);
 });
 it('unlinks without resampling a baseline then independently changes original audio',()=>{
  let d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});d=apply(d,{type:'unlink',clipIds:['iv']});const video=structuredClone(d.clips[0]);
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'ia',rate:r(2),linked:true});expect(d.clips[0]).toEqual(video);expect(d.clips[1]!.durationFrames).toBe(13);expect(d.clips.every(c=>!c.linkGroupId)).toBe(true);
 });
 it('does not unlink on an equal-rate one-sided no-op',()=>{
  const d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  expect(bytes(apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:false}))).toBe(bytes(d));
 });
 it('preserves independent negative key/effect origins and a later visual edit across speeds',()=>{
  const source=ownFixture();source.clips[0]!.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-7),rate:r(9),duration:r(45)}};
  let d=apply(source,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  const original=structuredClone(d.clips[0]!.insertOwnSpeed!);
  d=apply(d,{type:'update-clip',clipId:'iv',patch:{name:'見た目だけ変更',visual:{...d.clips[0]!.visual,opacity:.6}}});
  const before=bytes(d);d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true});
  expect(d.clips[0]!.visual!.keyframeClock).toEqual({offset:r(-7),rate:r(18,5),duration:r(45)});
  expect(d.clips[0]!.clock).toEqual({offset:r(-2),rate:r(4,5),duration:r(40)});
  expect(d.clips[1]!.clock).toEqual({offset:r(-3),rate:r(6,5),duration:r(50)});
  expect(d.clips[0]!.insertOwnSpeed!.keyframeClock).toEqual(original.keyframeClock);
  for(const keyframeClock of [false,null,0,[]]){const bad=structuredClone(d);Object.assign(bad.clips[0]!.insertOwnSpeed!,{keyframeClock});expect(()=>validateSequenceDocument(bad)).toThrow();}
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true});expect(bytes(d)).toBe(before);
 });
 it('retains an ordinary completion after deleting the longest of two independent own intervals',()=>{
  let d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  d=apply(d,{type:'add-track',track:{id:'extra-track',kind:'visual',name:'別素材',enabled:true}});
  const extra=structuredClone(ownFixture().clips[0]!);extra.id='extra';extra.trackId='extra-track';delete extra.linkGroupId;extra.startFrame=10;
  d=apply(d,{type:'insert',clips:[extra]});d=apply(d,{type:'register-native-insert-own-speed',clipId:'extra',linked:true});
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'extra',rate:r(1),linked:true});expect(d.sequenceEndFrame).toBe(35);
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true});
  d=apply(d,{type:'delete',clipIds:['extra'],linked:true});expect(d.sequenceEndFrame).toBe(18);expect(d.insertOwnSpeed!.endFloor).toBe(15);
  d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true});expect(d.sequenceEndFrame).toBe(15);
  expect(bytes(parseSequence(serializeSequence(d)))).toBe(bytes(d));
 });
 it('atomically rejects a source caption added after own registration',()=>{
  const d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true}),before=bytes(d);
  expect(()=>apply(d,{type:'batch',commands:[{type:'add-track',track:{id:'captions',kind:'visual',name:'字幕',enabled:true}},{type:'insert',clips:[{id:'caption',trackId:'captions',name:'原音字幕',startFrame:5,durationFrames:1,clock:{offset:r(0),rate:r(1),duration:r(1)},content:{kind:'telop',data:{text:'保持する原文'},appearance:DEFAULT_TEXT_APPEARANCE},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'ia',sourceStart:r(10),sourceEnd:r(15)}}]}]})).toThrow(/素材連動字幕/);
  expect(bytes(d)).toBe(before);
 });
 it.each([r(1,10),r(34,25),r(16),r(1000000000000001,1000000000000000)])('roundtrips exact rates %# and bounds source windows using saved intent',rate=>{
  let d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});const original=bytes(d);d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate,linked:true});
  expect(planVideoSourceRegions(d).get('iv')).toEqual({start:r(10),end:r(35)});expect(planAudioSourceRegions(d).regions[0]).toMatchObject({start:r(10),end:r(35),binding:'insert-own'});
  d=parseSequence(serializeSequence(d));d=apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true});expect(bytes(d)).toBe(original);
 });
 it('supports one-step Undo/Redo/replay and whole batch rollback',()=>{
  const s=new SequenceSession('session',ownFixture());const execute=(command:unknown,id:string)=>s.execute({sessionId:s.id,expectedRevision:s.document.revision,executionId:id,command:command as SequenceCommand});
  const request={sessionId:s.id,expectedRevision:0,executionId:'batch',command:{type:'batch',commands:[{type:'register-native-insert-own-speed',clipId:'iv',linked:true},{type:'set-native-insert-own-speed',clipId:'iv',rate:r(2),linked:true}]} as SequenceCommand};
  const changed=s.execute(request);expect(changed.document.revision).toBe(1);expect(s.execute(request).replayed).toBe(true);
  const slow=bytes(s.document);execute({type:'undo'},'undo');expect(bytes(s.document)).toBe(bytes(ownFixture()));execute({type:'redo'},'redo');expect(bytes(s.document)).toBe(slow);
  const before=s.document;expect(()=>execute({type:'batch',commands:[{type:'set-native-insert-own-speed',clipId:'iv',rate:r(5),linked:true},{type:'set-native-insert-own-speed',clipId:'missing',rate:r(2),linked:true}]},'bad')).toThrow();expect(s.document).toEqual(before);
 });
 it('rejects unknown metadata, rates, generic time patches and incompatible linked targets atomically',()=>{
  const d=apply(ownFixture(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});const before=bytes(d);
  for(const rate of [r(0),r(17),{num:1,den:1,extra:true},false,null,[]])expect(()=>apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate,linked:true})).toThrow();
  const c=d.clips[0]!;expect(()=>apply(d,{type:'update-clip',clipId:c.id,patch:{content:{...c.content,rate:r(1)}}})).toThrow();
  for(const change of [(x:SequenceDocument)=>{x.clips[0]!.insertOwnSpeed!.version=2 as 1;},(x:SequenceDocument)=>{x.clips[0]!.insertOwnSpeed!.source.sourceEnd=r(36);},(x:SequenceDocument)=>{x.insertOwnSpeed!.endFloor=99;}]){const bad=structuredClone(d);change(bad);expect(()=>validateSequenceDocument(bad)).toThrow();}
  for(const field of ['sourceLimit','keyframeClock'])for(const value of [null,false,0,[]]){const bad=structuredClone(d);Object.assign(bad.clips[0]!.insertOwnSpeed!,{[field]:value});expect(()=>validateSequenceDocument(bad)).toThrow();}
  const bad=ownFixture();if(bad.clips[1]!.content.kind==='audio')bad.clips[1]!.content.sourceIn=r(11);expect(()=>apply(bad,{type:'register-native-insert-own-speed',clipId:'iv',linked:true})).toThrow();expect(bytes(d)).toBe(before);
 });
});

describe('candidate66: ledger coexistence and temporary completion',()=>{
 function raw(){const d=ownFixture();for(const c of d.clips)if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);return d;}
 function registered(){return apply(raw(),{type:'register-native-insert-own-speed',clipId:'iv',linked:true});}
 const speed=(d:SequenceDocument,n:number,den=1)=>apply(d,{type:'set-native-insert-own-speed',clipId:'iv',rate:r(n,den),linked:true});
 it.each([
  [{type:'move',clipIds:['iv'],deltaFrames:-3,linked:true},10,10],
  [{type:'trim',clipId:'iv',edge:'end',frame:13,linked:true},10,10],
  [{type:'ripple-delete',startFrame:0,endFrame:3},7,7],
  [{type:'reorder-ranges',ranges:[{startFrame:5,endFrame:15}]},5,5],
 ] as const)('keeps extension out of the floor across %j', (command,floor,end)=>{
  const start=registered(),slow=speed(start,1,2);expect(slow.sequenceEndFrame).toBe(15);
  const edited=apply(slow,command);expect(edited.insertOwnSpeed!.endFloor).toBe(floor);
  const restored=speed(parseSequence(serializeSequence(edited)),1);expect(restored.sequenceEndFrame).toBe(end);
 });
 it('does not turn the last deleted own extension into an ordinary tail',()=>{
  const d=apply(speed(registered(),1,2),{type:'delete',clipIds:['iv'],linked:true});expect(d.clips).toHaveLength(0);expect(d.insertOwnSpeed).toBeUndefined();expect(d.sequenceEndFrame).toBe(10);
 });
 it('maps the original completion prefix to its destination after an own-only tail',()=>{
  const reordered=apply(speed(registered(),1,2),{type:'reorder-ranges',ranges:[{startFrame:10,endFrame:15},{startFrame:0,endFrame:10}]});
  expect(reordered.insertOwnSpeed!.endFloor).toBe(15);expect(reordered.sequenceEndFrame).toBe(15);
  expect(bytes(parseSequence(serializeSequence(reordered)))).toBe(bytes(reordered));
 });
 it.each([false,true])('does not reveal the hidden main tail during range edits, own-expanded=%s',expanded=>{
  let d=raw();d.sequenceEndFrame=90;for(const c of d.clips)c.startFrame=85;
  const main=structuredClone(d.clips[0]!);main.id='hidden-main';main.trackId='hidden-track';main.startFrame=0;main.durationFrames=100;delete main.linkGroupId;if(main.content.kind==='video')main.content.sourceIn=r(0);
  d.tracks.push({id:'hidden-track',kind:'visual',name:'main',enabled:true});d.clips.unshift(main);
  d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});if(expanded)d=speed(d,1,10);
  for(const command of [{type:'ripple-delete',startFrame:0,endFrame:1},{type:'reorder-ranges',ranges:[{startFrame:1,endFrame:d.sequenceEndFrame}]}]){
   const edited=apply(d,command);expect(edited.insertOwnSpeed!.endFloor).toBe(89);
   expect(speed(edited,1).sequenceEndFrame).toBe(89);
  }
 });
 it('keeps the unchanged finite source end when extending only the left rounded edge',()=>{
  const quick=speed(registered(),3),extended=apply(quick,{type:'trim',clipId:'iv',edge:'start',frame:4,linked:true});
  expect(planVideoSourceRegions(extended).get('iv')).toEqual({start:r(7),end:r(15)});
  expect(planAudioSourceRegions(extended).regions[0]).toMatchObject({start:r(7),end:r(15)});
  expect(bytes(parseSequence(serializeSequence(extended)))).toBe(bytes(extended));
 });
 it.each([
  ...[100,200].flatMap(mainEnd=>[false,true].flatMap(mainRegistered=>[false,true].map(expanded=>({mainEnd,mainRegistered,expanded,frame:50})))),
  ...[false,true].map(mainRegistered=>({mainEnd:200,mainRegistered,expanded:true,frame:110})),
 ])('keeps hidden non-own completion through a neutral split %j',({mainEnd,mainRegistered,expanded,frame})=>{
  let d=raw();d.sequenceEndFrame=90;
  for(const c of d.clips)c.startFrame=85;
  for(const asset of d.assets)if(asset.kind==='media')for(const stream of asset.streams)stream.duration=r(1000);
  const main=structuredClone(d.clips[0]!);main.id='hidden-main';main.trackId='hidden-track';main.startFrame=0;main.durationFrames=mainEnd;delete main.linkGroupId;
  if(main.content.kind==='video')main.content.sourceIn=r(0);
  d.tracks.push({id:'hidden-track',kind:'visual',name:'main',enabled:true});d.clips.unshift(main);
  if(mainRegistered){d=apply(d,{type:'register-native-speed',groupId:'hidden-speed',mainClipIds:['hidden-main'],mainAudioBindings:[]});d=apply(d,{type:'upgrade-native-speed-operations'});}
  d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});if(expanded)d=speed(d,1,10);
  const before=bytes(d),split=apply(d,{type:'split',clipIds:['hidden-main'],frame,linked:true});
  expect(bytes(d)).toBe(before);expect(split.sequenceEndFrame).toBe(d.sequenceEndFrame);expect(split.insertOwnSpeed!.endFloor).toBe(90);
  const saved=parseSequence(serializeSequence(split));expect(speed(saved,1).sequenceEndFrame).toBe(90);
 });
 it.each([true,false])('does not rebase or unlink an equal rational sourceIn linked=%s',linked=>{
  const quick=speed(registered(),3),next=apply(quick,{type:'rebase-native-insert-own-source',clipId:'iv',sourceIn:r(20,2),linked});
  expect(bytes(next)).toBe(bytes(quick));expect(bytes(speed(next,1))).toBe(bytes(registered()));
 });
 function withMainCaption(){
  const d=raw();const main=structuredClone(d.clips[0]!),audio=structuredClone(d.clips[1]!);
  main.id='main';audio.id='main-audio';for(const c of [main,audio]){c.startFrame=0;c.durationFrames=4;c.linkGroupId='main-link';if(c.content.kind==='video'||c.content.kind==='audio')c.content.sourceIn=r(0);}
  d.clips.unshift(main,audio);d.tracks.push({id:'caption-track',kind:'visual',name:'字幕',enabled:true});
  d.clips.push({id:'caption',trackId:'caption-track',name:'主原音の字幕',startFrame:1,durationFrames:2,clock:{offset:r(0),rate:r(1),duration:r(2)},content:{kind:'telop',data:{text:'主原音を保持'},appearance:structuredClone(DEFAULT_TEXT_APPEARANCE)},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'main-audio',sourceStart:r(1),sourceEnd:r(3)}});
  return d;
 }
 const mainRegister=(d:SequenceDocument)=>apply(apply(d,{type:'register-native-speed',groupId:'main-group',mainClipIds:['main'],mainAudioBindings:[{audioClipId:'main-audio',providerId:'main'}]}),{type:'upgrade-native-speed-operations'});
 it.each(['before','after','without'] as const)('keeps main scene-fade history atomic with own registered %s',order=>{
  let d=mainRegister(withMainCaption());
  if(order==='before')d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  const prior=JSON.stringify(d),command={type:'set-scene-fades',targets:[{kind:'head'}],change:{enabled:true,durationFrames:2,color:'#224466'}};
  let next:SequenceDocument|undefined;try{next=apply(d,command);}finally{expect(JSON.stringify(d)).toBe(prior);}
  d=next!;if(order==='after')d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  expect(d.clips.some(c=>c.content.kind==='scene-fade')).toBe(true);expect(bytes(parseSequence(serializeSequence(d)))).toBe(bytes(d));
  const session=new SequenceSession('fade-atomic',d),before=JSON.stringify(session.document);
  expect(()=>session.execute({sessionId:session.id,expectedRevision:session.document.revision,executionId:'bad',command:{type:'batch',commands:[{...command,change:{...command.change,color:'#662244'}},{type:'delete',clipIds:['missing'],linked:true}]} as SequenceCommand})).toThrow();
  expect(JSON.stringify(session.document)).toBe(before);
 });
 it.each([true,false])('coexists with main v2 source ledger, own-first=%s',ownFirst=>{
  let d=withMainCaption();if(ownFirst)d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});d=mainRegister(d);
  if(!ownFirst)d=apply(d,{type:'register-native-insert-own-speed',clipId:'iv',linked:true});
  const before=bytes(d);d=speed(d,3);d=speed(d,1);expect(bytes(d)).toBe(before);
  d=parseSequence(serializeSequence(d));validateSequenceDocument(d);
  for(const command of [{type:'set-native-global-speed',rate:r(2)},{type:'set-native-main-speed',clipId:'main',rate:r(1)},{type:'reset-native-main-speed',clipId:'main'},{type:'set-native-global-speed',rate:r(1)}])d=apply(d,command);
  expect(bytes(d)).toBe(before);
  for(const command of [{type:'split',clipIds:['iv'],frame:7,linked:true},{type:'trim',clipId:'iv',edge:'start',frame:6,linked:true}]){const edited=apply(d,command);validateSequenceDocument(edited);expect(bytes(parseSequence(serializeSequence(edited)))).toBe(bytes(edited));expect(edited.clips.find(c=>c.id==='caption')).toEqual(d.clips.find(c=>c.id==='caption'));}
 });
});
