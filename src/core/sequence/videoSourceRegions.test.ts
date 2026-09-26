import {expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {ScenePlan} from './scenePlan';
import {planVideoSourceRegions} from './videoSourceRegions';
import type {SequenceDocument} from './model';
import {rational as r} from './time';
import {sampleInVideoSourceWindow} from '../../preview/native/videoSourceWindow';

function document(rate=r(2),fps=r(1),options:{secondSourceIn?:number;commonLineage?:boolean;secondStream?:boolean}={}):SequenceDocument{
  const lead=rate.num/rate.den===16?33:3;
  let doc:SequenceDocument={schemaVersion:2,id:'video-window',name:'Video window',revision:0,fps,resolution:{width:2,height:2},sequenceEndFrame:lead+601,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
    assets:[{id:'media',kind:'media',name:'Original',file:'source.mp4',fingerprint:'fixture',streams:[{index:0,kind:'video',duration:r(1000),codec:'h264',frameRate:fps,width:2,height:2}]}],
    tracks:[{id:'v',kind:'visual',name:'Video',enabled:true}],clips:[]};
  if(options.secondStream)doc.assets[0]!.streams.push({...doc.assets[0]!.streams[0]!,index:1});
  for(const [id,startFrame,durationFrames,sourceIn] of [['a',0,lead,0],['b',lead,601,options.secondSourceIn??10]] as const){
    doc.clips.push({id,name:id,trackId:'v',startFrame,durationFrames,...(options.commonLineage?{continuationGroupId:'origin'}:{}),clock:{offset:r(0),rate:r(1),duration:r(durationFrames)},content:{kind:'video',assetId:'media',streamIndex:id==='b'&&options.secondStream?1:0,sourceIn:r(sourceIn),rate:r(1)}});
  }
  doc=applySequenceCommand(doc,{type:'register-native-speed',groupId:'main',mainClipIds:['a','b'],mainAudioBindings:[]});
  return applySequenceCommand(doc,{type:'set-native-global-speed',rate});
}
function picked(plan:ScenePlan,frame:number,sourceSeconds=40){
  const visual=plan.frame(frame).visuals.find(v=>v.clip.content.kind==='video')!;
  const fps=plan.document.fps,samples=Array.from({length:Math.ceil(sourceSeconds*fps.num/fps.den)},(_,sample)=>({identity:{sample,pts:r(sample*fps.den,fps.num),duration:r(fps.den,fps.num)}}));
  return sampleInVideoSourceWindow(samples,visual.sourceTime!,plan.videoSourceWindow(visual.clip.id)!);
}
it.each([r(1),r(30),r(30000,1001)].flatMap(fps=>[r(2),r(34,25),r(1,10),r(16)].map(rate=>({fps,rate}))))('keeps exact touching intent and shared window identity at fps/rate %j',({fps,rate})=>{
  const doc=document(rate,fps),boundary=doc.clips.find(c=>c.id==='b')!.startFrame+1;
  const split=applySequenceCommand(doc,{type:'split',clipIds:['b'],frame:boundary});
  const left=split.clips.find(c=>c.id==='b')!,right=split.clips.find(c=>c.startFrame===boundary)!;
  expect(left.speed!.source.sourceEnd).toEqual(right.speed!.source.sourceStart);
  const original=new ScenePlan(doc),parts=new ScenePlan(split);
  expect(parts.videoSourceWindow(left.id)).toBe(parts.videoSourceWindow(right.id));
  const last=right.startFrame+right.durationFrames-1;
  for(const frame of [last-1,last])expect(picked(parts,frame,620)).toBe(picked(original,frame,620));
});
it.each([r(1),r(30),r(30000,1001)])('keeps the exact source frame across a neutral 2x split at fps %j',fps=>{
  const doc=document(r(2),fps),split=applySequenceCommand(doc,{type:'split',clipIds:['b'],frame:3});
  const original=new ScenePlan(doc),parts=new ScenePlan(split);
  for(const frame of [2,3,4,5])expect(picked(parts,frame)).toBe(picked(original,frame));
  expect(parts.videoSourceWindow(parts.frame(3).visuals[0]!.clip.id)).toEqual(original.videoSourceWindow('b'));
  const oldPerClip=split.clips.find(c=>c.startFrame===3)!.speed!.source;
  expect(oldPerClip.sourceStart).not.toEqual(parts.videoSourceWindow(parts.frame(3).visuals[0]!.clip.id)!.start);
});
it.each([r(1,10),r(34,25),r(16)])('preserves shared windows at %j rate',rate=>{
  const doc=document(rate,r(30)),owner=doc.clips.find(c=>c.id==='b')!,cut=owner.startFrame+1;
  const split=applySequenceCommand(doc,{type:'split',clipIds:['b'],frame:cut});
  const original=new ScenePlan(doc),parts=new ScenePlan(split);
  for(const frame of [cut-1,cut,cut+1])expect(picked(parts,frame)).toBe(picked(original,frame));
});
it('removes deleted sibling context and keeps the actual first permitted frame',()=>{
  const split=applySequenceCommand(document(),{type:'split',clipIds:['b'],frame:3});
  const removed=applySequenceCommand(split,{type:'delete',clipIds:['b']});
  expect(picked(new ScenePlan(split),3)).toBe(12);
  const plan=new ScenePlan(removed);
  expect(plan.frame(3).visuals[0]!.sourceTime).toEqual(r(12));
  expect(plan.videoSourceWindow(plan.frame(3).visuals[0]!.clip.id)).toEqual({start:r(13),end:r(611)});
  expect(picked(plan,3)).toBe(13);
});
it('splits actual source holes and rejoins after a trim fills the hole',()=>{
  let doc=applySequenceCommand(document(),{type:'split',clipIds:['b'],frame:3});
  let right=doc.clips.find(c=>c.startFrame===3)!;
  doc=applySequenceCommand(doc,{type:'split',clipIds:[right.id],frame:4});
  const middle=doc.clips.find(c=>c.startFrame===3)!;
  const removed=applySequenceCommand(doc,{type:'delete',clipIds:[middle.id]});
  const windows=planVideoSourceRegions(removed),last=removed.clips.find(c=>c.startFrame===4)!;
  expect(windows.get('b')).toEqual({start:r(10),end:r(13)});
  expect(windows.get(last.id)).toEqual({start:r(15),end:r(611)});
  const trimmed=applySequenceCommand(removed,{type:'trim',clipId:last.id,edge:'start',frame:3});
  expect(planVideoSourceRegions(trimmed).get('b')).toEqual({start:r(10),end:r(611)});
});
it('separates effective rates and restores sharing after reset; retains immutable plan windows',()=>{
  const original=document(),split=applySequenceCommand(original,{type:'split',clipIds:['b'],frame:3});
  const right=split.clips.find(c=>c.startFrame===3)!;
  const differentRate=applySequenceCommand(split,{type:'set-native-main-speed',clipId:right.id,rate:r(3)});
  const separated=planVideoSourceRegions(differentRate);
  expect(separated.get('b')).toEqual({start:r(10),end:r(13)});
  expect(separated.get(right.id)).toEqual({start:r(13),end:r(611)});
  const restored=planVideoSourceRegions(applySequenceCommand(differentRate,{type:'reset-native-main-speed',clipId:right.id}));
  expect(restored.get('b')).toEqual({start:r(10),end:r(611)});expect(restored.get('b')).toBe(restored.get(right.id));
  const plan=new ScenePlan(split),window=plan.videoSourceWindow(plan.frame(3).visuals[0]!.clip.id)!;
  expect(Object.isFrozen(window)).toBe(true);expect(Object.isFrozen(window.start)).toBe(true);
  expect(planVideoSourceRegions(original).get('a')).toEqual({start:r(0),end:r(3)});
});
it('keeps adjacent independent insertions separate even for the same source and rate',()=>{
  const windows=planVideoSourceRegions(document(r(2),r(1),{secondSourceIn:3}));
  expect(windows.get('a')).toEqual({start:r(0),end:r(3)});expect(windows.get('b')).toEqual({start:r(3),end:r(604)});
});
it('separates different streams despite shared lineage and touching source ranges',()=>{
  const windows=planVideoSourceRegions(document(r(2),r(1),{secondSourceIn:3,commonLineage:true,secondStream:true}));
  expect(windows.get('a')).toEqual({start:r(0),end:r(3)});expect(windows.get('b')).toEqual({start:r(3),end:r(604)});
});
it('merges overlapping source requests with explicit shared lineage',()=>{
  const windows=planVideoSourceRegions(document(r(2),r(1),{secondSourceIn:2,commonLineage:true}));
  expect(windows.get('a')).toEqual({start:r(0),end:r(603)});expect(windows.get('a')).toBe(windows.get('b'));
});
it('leaves ordinary video unbounded and does not mutate input or shared windows',()=>{
  const ordinary=document();delete ordinary.speed;for(const clip of ordinary.clips)delete clip.speed;
  const before=JSON.stringify(ordinary),plan=new ScenePlan(ordinary);
  expect(plan.videoSourceWindow(plan.frame(3).visuals[0]!.clip.id)).toBeUndefined();expect(JSON.stringify(ordinary)).toBe(before);
});
