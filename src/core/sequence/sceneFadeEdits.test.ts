import {expect,it} from 'vitest';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {DEFAULT_TEXT_APPEARANCE,type SequenceDocument} from './model';
import {ScenePlan} from './scenePlan';
import {rational as r} from './time';
import {SequenceSession} from './session';
import {sceneFadeJoins,sceneFadeIssue,resolveSceneFade,MAX_SCENE_FADE_TARGETS,sceneFadeInsertionIndex} from './sceneFadeEdits';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {mixAudioBlock,pcmKey} from '../../preview/native/audioMixer';

function fixture(end=90):SequenceDocument {
  return {schemaVersion:2,id:'fade-test',name:'fade',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:end,background:'#000000',assets:[{id:'source',name:'source',file:'source.mp4',fingerprint:'source',kind:'media',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),width:320,height:180,frameRate:r(30)}]}],tracks:[{id:'video',name:'映像1',kind:'visual',enabled:true}],clips:[0,1,2].map(i=>({id:`v${i}`,name:`映像${i}`,trackId:'video',startFrame:i*30,durationFrames:30,clock:{offset:r(0),rate:r(1),duration:r(30)},content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:r(i),rate:r(1)}})),transitions:[],transcripts:[],ducking:{enabled:false,strength:'mid'}};
}
const edit=(doc:SequenceDocument,targets:unknown[],change:unknown)=>applySequenceCommand(doc,{type:'set-scene-fades',targets,change} as unknown as SequenceCommand);
it.each(['head','tail','join'] as const)('matches an independent %s opacity curve including odd and overlong durations without altering media or output length',kind=>{
  for(const duration of [2,15,31,120]){
    const doc=fixture(),target=kind==='join'?{kind,trackId:'video',outClipId:'v0',inClipId:'v1'}:{kind};
    const next=edit(doc,[target],{enabled:true,color:'#FF3B30',durationFrames:duration});
    expect(next.sequenceEndFrame).toBe(90);expect(next.clips.filter(c=>c.content.kind!=='scene-fade')).toEqual(doc.clips);expect(next.transitions).toEqual(doc.transitions);
    const plan=new ScenePlan(next);
    for(let frame=0;frame<90;frame++){
      const raw=kind==='head'?1-frame/duration:kind==='tail'?(frame-(90-duration))/duration:1-2*Math.abs(frame-30)/duration;
      const expected=Math.max(0,Math.min(1,raw));
      expect(plan.frame(frame).visuals.find(v=>v.clip.content.kind==='scene-fade')?.transform.opacity??0).toBeCloseTo(expected,12);
    }
  }
});
it('keeps the uncut clock for a one-frame sequence and does not grow its output',()=>{
  const next=edit(fixture(1),[{kind:'tail'}],{enabled:true,durationFrames:15,color:'#FFFFFF'});
  expect(next.sequenceEndFrame).toBe(1);expect(new ScenePlan(next).frame(0).visuals.at(-1)?.transform.opacity).toBeCloseTo(14/15,12);
});
it('re-edits by identity and removes the chosen fade only; unchanged updates have no revision',()=>{
  const before=fixture(),first=edit(before,[{kind:'head'}],{enabled:true,color:'#000000',durationFrames:15});
  const id=first.clips.find(c=>c.content.kind==='scene-fade')!.id;
  const same=edit(first,[{kind:'head'}],{color:'#000000'});expect(same).toBe(first);
  const changed=edit(first,[{kind:'clip',clipId:id}],{durationFrames:31});
  expect(changed.clips.find(c=>c.id===id)?.clock.duration).toEqual(r(31));
  const removed=edit(changed,[{kind:'clip',clipId:id}],{enabled:false});expect(removed.clips).toEqual(before.clips);
});
it('allocates separate upper lanes for overlapping fades without inserting fake transitions',()=>{
  const next=edit(fixture(),[{kind:'head'},{kind:'join',trackId:'video',outClipId:'v0',inClipId:'v1'},{kind:'tail'}],{enabled:true,durationFrames:90,color:'#FF3B30'});
  const fades=next.clips.filter(c=>c.content.kind==='scene-fade');expect(new Set(fades.map(c=>c.trackId)).size).toBe(3);expect(next.transitions).toEqual([]);
  expect(next.tracks.filter(t=>t.kind==='visual').slice(1).map(t=>t.id)).toEqual(fades.map(c=>c.trackId));
});
it('rejects a broken connection atomically instead of applying the other valid target',()=>{
  const doc=fixture(),before=structuredClone(doc);
  expect(()=>edit(doc,[{kind:'head'},{kind:'join',trackId:'video',outClipId:'v0',inClipId:'v2'}],{enabled:true,color:'#000000'})).toThrow();expect(doc).toEqual(before);
});
it('keeps nonstandard effects on color edits and refuses to reset their clock through a duration edit',()=>{
  const first=edit(fixture(),[{kind:'head'}],{enabled:true,color:'#000000'}),fade=first.clips.find(c=>c.content.kind==='scene-fade')!;
  fade.clock.rate=r(2);const before=structuredClone(fade);
  const next=edit(first,[{kind:'clip',clipId:fade.id}],{color:'#FFFFFF'}),updated=next.clips.find(c=>c.id===fade.id)!;
  expect(updated.clock).toEqual(before.clock);expect(()=>edit(next,[{kind:'clip',clipId:fade.id}],{durationFrames:20})).toThrow(/時計|標準/);
});
it('applies many boundaries in one undo, replays exactly, and rejects external revisions',()=>{
  const doc=fixture();doc.clips=[];doc.sequenceEndFrame=210;
  for(let i=0;i<70;i++)doc.clips.push({id:`v${i}`,name:`v${i}`,trackId:'video',startFrame:i*3,durationFrames:3,clock:{offset:r(0),rate:r(1),duration:r(3)},content:{kind:'video',assetId:'source',streamIndex:0,sourceIn:r(0),rate:r(1)}});
  const session=new SequenceSession('s',doc),command:SequenceCommand={type:'set-scene-fades',targets:sceneFadeJoins(doc).map(j=>j.target),change:{enabled:true,color:'#FFFFFF',durationFrames:2}};
  const request={sessionId:'s',expectedRevision:0,executionId:'bulk',command};
  expect(session.execute(request).document.clips.filter(c=>c.content.kind==='scene-fade')).toHaveLength(69);
  expect(session.execute(request).replayed).toBe(true);expect(session.document.revision).toBe(1);
  expect(()=>session.execute({...request,executionId:'stale'})).toThrow();
  const undone=session.execute({sessionId:'s',expectedRevision:1,executionId:'undo',command:{type:'undo'}});
  expect(undone.document.clips).toEqual(doc.clips);expect(undone.document.tracks).toEqual(doc.tracks);expect(session.canUndo).toBe(false);
});
it('preserves standard layout independent of JSON property ordering',()=>{
  const doc=edit(fixture(),[{kind:'head'}],{enabled:true});const fade=doc.clips.find(c=>c.content.kind==='scene-fade')!;
  fade.visual={layout:{...DEFAULT_MAIN_LAYOUT,position:{y:0,x:0}},opacity:1,keyframes:[]};
  expect(sceneFadeIssue(fade)).toBeNull();
});
it('shares one global color plane for simultaneous joins on different tracks and deduplicates bulk targets',()=>{
  const doc=fixture();doc.tracks.push({id:'second',name:'映像2',kind:'visual',enabled:true});doc.clips.push(...doc.clips.map(c=>({...c,id:`second-${c.id}`,trackId:'second'})));
  const joins=sceneFadeJoins(doc),next=edit(doc,joins.map(j=>j.target),{enabled:true,color:'#000000',durationFrames:15});
  expect(next.clips.filter(c=>c.content.kind==='scene-fade')).toHaveLength(2);
  const revised=edit(next,[joins.find(j=>j.target.trackId==='second')!.target],{color:'#FFFFFF'});
  expect(revised.clips.filter(c=>c.content.kind==='scene-fade')).toHaveLength(2);
});
it('requires an explicit choice for displaced head/tail and disconnected join planes, preserving their ID when relocated',()=>{
  for(const kind of ['head','tail','join'] as const){
    const target=kind==='join'?sceneFadeJoins(fixture())[0]!.target:{kind};
    const doc=edit(fixture(),[target],{enabled:true}),fade=doc.clips.find(c=>c.content.kind==='scene-fade')!;
    fade.startFrame+=3;const before=structuredClone(doc);
    expect(resolveSceneFade(doc,target).displaced).toHaveLength(1);
    expect(()=>edit(doc,[target],{enabled:true,color:'#FFFFFF'})).toThrow(/位置/);expect(doc).toEqual(before);
    const moved=edit(doc,[target],{enabled:true,moveFromClipId:fade.id});
    expect(moved.clips.filter(c=>c.content.kind==='scene-fade')).toHaveLength(1);expect(resolveSceneFade(moved,target).clip?.id).toBe(fade.id);
    const added=edit(doc,[target],{enabled:true,newAtTarget:true});expect(added.clips.filter(c=>c.content.kind==='scene-fade')).toHaveLength(2);
  }
});
it('places re-edited planes above later text without moving a mixed track or changing its other clips',()=>{
  let doc=edit(fixture(),[{kind:'head'}],{enabled:true});const fade=doc.clips.find(c=>c.content.kind==='scene-fade')!;
  // A regular video occupies the old fade lane outside the fade window.
  doc.clips.push({...doc.clips[1]!,id:'on-mixed',trackId:fade.trackId});
  doc=applySequenceCommand(doc,{type:'add-track',track:{id:'text',name:'テキスト',kind:'visual',enabled:true}});
  doc=applySequenceCommand(doc,{type:'insert',clips:[{id:'text',name:'text',trackId:'text',startFrame:0,durationFrames:90,clock:{offset:r(0),rate:r(1),duration:r(90)},content:{kind:'telop',textMode:'free',data:{text:'later'},appearance:DEFAULT_TEXT_APPEARANCE}}]});
  const before=structuredClone(doc),next=edit(doc,[{kind:'head'}],{color:'#FFFFFF'});
  expect(next.tracks.findIndex(t=>t.id===fade.trackId)).toBe(before.tracks.findIndex(t=>t.id===fade.trackId));
  expect(next.clips.filter(c=>c.content.kind!=='scene-fade')).toEqual(before.clips.filter(c=>c.content.kind!=='scene-fade'));
  expect(new ScenePlan(next).frame(0).visuals.at(-1)?.clip.id).toBe(fade.id);
});
it('does not change mixed samples, including gain, loop and non-unity source clocks',()=>{
  const doc=fixture();doc.assets[0]!.streams.push({index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2});doc.tracks.push({id:'audio',name:'音声',kind:'audio',enabled:true});
  doc.clips.push({id:'audio',name:'音声',trackId:'audio',startFrame:0,durationFrames:90,clock:{offset:r(7),rate:r(1,2),duration:r(100)},content:{kind:'audio',assetId:'source',streamIndex:1,sourceIn:r(1,10),rate:r(3,2),role:'music',loop:true,settings:{gainDb:-3,muted:false,fadeInFrames:10,fadeOutFrames:12}}});
  const left=Float32Array.from({length:1000},(_,i)=>Math.sin(i*.2)*.1),right=Float32Array.from(left,v=>-v),rate=r(3,2),sources=new Map([[pcmKey('source',1,rate),{assetId:'source',streamIndex:1,rate,sampleRate:48000,channels:[left,right]}]]);
  const next=edit(doc,[{kind:'head'},{kind:'tail'}],{enabled:true,color:'#FF3B30'});
  expect(mixAudioBlock(new ScenePlan(next),sources,0,144000)).toEqual(mixAudioBlock(new ScenePlan(doc),sources,0,144000));
});
it('rejects over-limit target lists and nonstandard bulk operations before any change',()=>{
  const doc=fixture();expect(()=>edit(doc,Array.from({length:MAX_SCENE_FADE_TARGETS+1},()=>({kind:'head'})),{enabled:true})).toThrow(/対象/);
  const next=edit(doc,[{kind:'head'}],{enabled:true});next.clips.find(c=>c.content.kind==='scene-fade')!.clock.rate=r(2);
  expect(()=>edit(next,[{kind:'clip',clipId:next.clips.at(-1)!.id},{kind:'tail'}],{enabled:false})).toThrow(/標準外/);
});
it('keeps later normal text additions underneath an existing color plane without re-editing the fade',()=>{
  let doc=edit(fixture(),[{kind:'head'}],{enabled:true}),fade=doc.clips.find(c=>c.content.kind==='scene-fade')!;
  doc=applySequenceCommand(doc,{type:'add-track',track:{id:'new-text',name:'text',kind:'visual',enabled:true},index:sceneFadeInsertionIndex(doc)});
  doc=applySequenceCommand(doc,{type:'insert',clips:[{id:'new-text',name:'text',trackId:'new-text',startFrame:0,durationFrames:90,clock:{offset:r(0),rate:r(1),duration:r(90)},content:{kind:'telop',data:{text:'later'},appearance:DEFAULT_TEXT_APPEARANCE}}]});
  expect(new ScenePlan(doc).frame(0).visuals.at(-1)?.clip.id).toBe(fade.id);expect(doc.clips.find(c=>c.id===fade.id)).toEqual(fade);
});
it('inserts new visuals above general tracks while preserving manually lowered and mixed fade tracks',()=>{
  const original=edit(fixture(),[{kind:'head'}],{enabled:true});
  const fadeTrack=original.tracks.at(-1)!;
  const doc={...original,tracks:[fadeTrack,original.tracks[0]!]};
  const before=structuredClone(doc);
  expect(sceneFadeInsertionIndex(doc)).toBe(2);
  const added=applySequenceCommand(doc,{type:'add-track',track:{id:'new',name:'new',kind:'visual',enabled:true},index:sceneFadeInsertionIndex(doc)});
  expect(added.tracks.map(t=>t.id)).toEqual([fadeTrack.id,'video','new']);expect(doc).toEqual(before);
  const upper={id:'upper',name:'upper',kind:'visual' as const,enabled:true};
  doc.tracks.push(upper,{id:'audio',name:'audio',kind:'audio',enabled:true});
  doc.clips.push({...doc.clips.at(-1)!,id:'upper-fade',trackId:upper.id});
  expect(sceneFadeInsertionIndex(doc)).toBe(2);
  doc.clips.push({...doc.clips[0]!,id:'mixed-video',trackId:upper.id});
  expect(sceneFadeInsertionIndex(doc)).toBe(4);
});
