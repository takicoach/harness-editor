import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planAudioSourceRegions } from './audioSourceRegions';
import { applySequenceCommand } from './commands';
import { type SequenceDocument, type SequenceClip } from './model';
import { rational as r } from './time';
import { parseSequence, serializeSequence, validateSequenceDocument } from './validate';
import { SequenceSession } from './session';
import { SequenceStore } from '../../server/sequence/store';

function fixture(): SequenceDocument {
  return { schemaVersion:2,id:'regions',name:'regions',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:60,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],
    assets:[{id:'asset',kind:'media',file:'media/test.mp4',name:'source',fingerprint:'source-sha',streams:[
      {index:0,kind:'video',codec:'h264',duration:r(1000),frameRate:r(30),width:640,height:360},
      {index:1,kind:'audio',codec:'aac',duration:r(1000),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true}],
    clips:[{id:'video',name:'video',trackId:'v',startFrame:0,durationFrames:60,linkGroupId:'link',clock:{offset:r(-3),rate:r(1),duration:r(1000)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(1),rate:r(34,25)}},
      {id:'audio',name:'audio',trackId:'a',startFrame:0,durationFrames:60,linkGroupId:'link',clock:{offset:r(-7),rate:r(3),duration:r(1000)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(1),rate:r(34,25),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:4,fadeOutFrames:7}}}],transitions:[] };
}
function registered(doc=fixture()) {
  return applySequenceCommand(doc,{type:'register-native-speed',groupId:'g',mainClipIds:doc.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:doc.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:c.id==='audio'?'video':'b'}))});
}
const audio = (d:SequenceDocument) => d.clips.filter(c=>c.content.kind==='audio');
const keys = (d:SequenceDocument) => planAudioSourceRegions(d).regions.map(g=>g.pcmKey);
const split = (d:SequenceDocument,frame:number) => applySequenceCommand(d,{type:'split',clipIds:['video'],frame,linked:true});
function phaseDocument(duration=r(1000)) {
  const d=fixture();d.fps=r(1);d.sequenceEndFrame=604;
  for(const c of d.clips){c.durationFrames=3;if(c.content.kind==='video'||c.content.kind==='audio'){c.content.sourceIn=r(0);c.content.rate=r(1);c.content.endBehavior=c.content.kind==='video'?'hold':'silence';}}
  for(const c of [...d.clips]) {const b=structuredClone(c);b.id=c.id==='video'?'b':'b-audio';b.linkGroupId='b-link';b.startFrame=3;b.durationFrames=601;if(b.content.kind==='video'||b.content.kind==='audio')b.content.sourceIn=r(10);d.clips.push(b);}
  for(const stream of d.assets[0]!.streams)stream.duration=duration;
  return applySequenceCommand(registered(d),{type:'set-native-global-speed',rate:r(2)});
}

describe('audio source regions',()=>{
  it.each([false,true])('neutral split retains a single exact region and PCM key; registered=%s',reg=>{
    const input=fixture();input.fps=r(30000,1001);const d=reg?registered(input):input;validateSequenceDocument(d);const before=planAudioSourceRegions(d),after=planAudioSourceRegions(split(d,17));
    expect(before.regions[0]).toMatchObject({start:r(1),end:r(23267,6250),lineageId:'audio',physical:{start:r(1),end:r(23267,6250)}});
    expect(after.regions).toHaveLength(1);expect(after.regions[0]!.pcmKey).toBe(before.regions[0]!.pcmKey);expect(after.regions[0]!.regionKey).toBe(before.regions[0]!.regionKey);expect(after.regions[0]!.clipIds).toHaveLength(2);
    expect(after.clips[0]!.support.end).toEqual(after.clips[1]!.support.start);expect(after.clips[0]!.support.start).toEqual(r(1));expect(after.clips[1]!.support.end).toEqual(r(23267,6250));
  });
  it.each([false,true])('actual trim/delete source holes split the region; registered=%s',reg=>{
    let d=reg?registered():fixture();d=split(d,20);const next=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===20)!;d=applySequenceCommand(d,{type:'split',clipIds:[next.id],frame:40,linked:true});
    const original=keys(d);expect(original).toHaveLength(1);
    const removed=applySequenceCommand(d,{type:'delete',clipIds:[next.id],linked:true});const regions=planAudioSourceRegions(removed).regions;
    expect(regions.map(q=>[q.start,q.end])).toEqual([[r(1),r(143,75)],[r(211,75),r(93,25)]]);expect(regions.every(q=>!original.includes(q.pcmKey))).toBe(true);
    const trimmed=applySequenceCommand(d,{type:'trim',clipId:next.id,edge:'start',frame:25,linked:true});expect(planAudioSourceRegions(trimmed).regions.map(q=>[q.start,q.end])).toEqual([[r(1),r(143,75)],[r(32,15),r(93,25)]]);
  });
  it('phase split uses saved requested source boundaries, never the rounded evaluation sourceIn',()=>{
    const d=phaseDocument(),before=planAudioSourceRegions(d);const cut=applySequenceCommand(d,{type:'split',clipIds:['b'],frame:3,linked:true});const right=audio(cut).find(c=>c.startFrame===3)!;expect(right.content).toMatchObject({sourceIn:r(12)});expect(right.speed!.source.sourceStart).toEqual(r(13));
    const plan=planAudioSourceRegions(cut);expect(plan.clips.find(c=>c.clipId===right.id)).toMatchObject({sourceIn:r(12),support:{start:r(13),end:r(611)}});expect(plan.regions.map(c=>c.pcmKey)).toEqual(before.regions.map(c=>c.pcmKey));
    const slow=applySequenceCommand(cut,{type:'set-native-global-speed',rate:r(1)});expect(planAudioSourceRegions(slow).clips.find(c=>c.clipId===right.id)).toMatchObject({sourceIn:r(13),support:{start:r(13),end:r(611)}});
    expect(keys(applySequenceCommand(slow,{type:'set-native-global-speed',rate:r(2)}))).toEqual(keys(cut));
  });
  it('requested EOF overrun and wholly outside support remain distinct from physical audio',()=>{
    const d=phaseDocument(r(25,2)),cut=applySequenceCommand(d,{type:'split',clipIds:['b'],frame:3,linked:true});const plan=planAudioSourceRegions(cut),group=plan.regions.find(g=>g.lineageId==='b-audio')!;
    expect(group).toMatchObject({start:r(10),end:r(611),physical:{start:r(10),end:r(25,2)}});
    const left=audio(cut).find(c=>c.id==='b-audio')!;const deleted=applySequenceCommand(cut,{type:'delete',clipIds:[left.id],linked:true});validateSequenceDocument(deleted);const remaining=planAudioSourceRegions(deleted).regions.find(g=>g.lineageId==='b-audio')!;
    expect(remaining).toMatchObject({start:r(13),end:r(611),physical:null});
  });
  it('ordinary finite EOF is clipped but registered requested EOF is preserved',()=>{
    const d=fixture();for(const st of d.assets[0]!.streams)st.duration=r(3);for(const c of d.clips)if(c.content.kind==='video'||c.content.kind==='audio')c.content.endBehavior=c.content.kind==='video'?'hold':'silence';validateSequenceDocument(d);
    expect(planAudioSourceRegions(d).regions[0]).toMatchObject({start:r(1),end:r(3),physical:{start:r(1),end:r(3)}});
    expect(planAudioSourceRegions(registered(d)).regions[0]).toMatchObject({start:r(1),end:r(93,25),physical:{start:r(1),end:r(3)}});
  });
  it('move, presentation and consumer gain/fade/mute edits preserve PCM keys',()=>{
    let d=split(registered(),30);const before=keys(d);const right=audio(d).find(c=>c.startFrame===30)!;
    d=applySequenceCommand(d,{type:'move',clipIds:[right.id],deltaFrames:70,linked:true});
    const current=audio(d).find(c=>c.id===right.id)!;if(current.content.kind!=='audio')throw Error('fixture');
    d=applySequenceCommand(d,{type:'update-clip',clipId:current.id,patch:{name:'renamed',content:{...current.content,settings:{gainDb:-12,muted:true,fadeInFrames:20,fadeOutFrames:25}}}});
    d=applySequenceCommand(d,{type:'set-track-enabled',trackId:'a',enabled:false});expect(keys(d)).toEqual(before);
  });
  it('explicit unlink preserves lineage but separates main-audio from independent-audio',()=>{
    const d=split(registered(),30),right=audio(d).find(c=>c.startFrame===30)!;
    const unlinked=applySequenceCommand(d,{type:'unlink',clipIds:[right.id]});const p=planAudioSourceRegions(unlinked);
    expect(p.regions).toHaveLength(2);expect(new Set(p.regions.map(g=>g.binding))).toEqual(new Set(['main-audio','independent-audio']));expect(new Set(p.regions.map(g=>g.lineageId))).toEqual(new Set(['audio']));
    const fast=applySequenceCommand(unlinked,{type:'set-native-global-speed',rate:r(2)});expect(planAudioSourceRegions(fast).regions.find(g=>g.binding==='independent-audio')!.pcmKey).toBe(p.regions.find(g=>g.binding==='independent-audio')!.pcmKey);
  });
  it('independent audio neutral split retains its requested union and its PCM identity',()=>{
    const d=applySequenceCommand(registered(),{type:'unlink',clipIds:['audio']}),before=planAudioSourceRegions(d);
    const cut=applySequenceCommand(d,{type:'split',clipIds:['audio'],frame:17,linked:false});
    expect(before.regions[0]!.binding).toBe('independent-audio');expect(keys(cut)).toEqual(keys(d));expect(planAudioSourceRegions(cut).regions[0]!.clipIds).toHaveLength(2);
  });
  it('explicit child rate override splits processing and reset restores the union',()=>{
    const d=split(registered(),30),right=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===30)!;
    const changed=applySequenceCommand(d,{type:'set-native-main-speed',clipId:right.id,rate:r(2)});
    expect(planAudioSourceRegions(changed).regions).toHaveLength(2);expect(new Set(planAudioSourceRegions(changed).regions.map(g=>JSON.stringify(g.rate)))).toEqual(new Set([JSON.stringify(r(34,25)),JSON.stringify(r(2))]));
    expect(keys(applySequenceCommand(changed,{type:'reset-native-main-speed',clipId:right.id}))).toEqual(keys(d));
  });
  it.each(['lineage','rate','stream','asset'] as const)('does not merge a different %s',difference=>{
    const d=split(fixture(),30),right=audio(d).find(c=>c.startFrame===30)!;if(right.content.kind!=='audio')throw Error('fixture');
    if(difference==='lineage')delete right.continuationGroupId;
    if(difference==='rate')right.content.rate=r(1);
    if(difference==='stream'){d.assets[0]!.streams.push({...d.assets[0]!.streams[1]!,index:2});right.content.streamIndex=2;}
    if(difference==='asset'){d.assets.push({...structuredClone(d.assets[0]!),id:'another'});right.content.assetId='another';}
    validateSequenceDocument(d);expect(planAudioSourceRegions(d).regions).toHaveLength(2);
  });
  it('content cache identity excludes insertion lineage, IDs/count/order and Rational representation',()=>{
    const d=fixture(),before=planAudioSourceRegions(d);const copy=structuredClone(d);copy.clips[1]!.id='another-id';expect(keys(copy)).toEqual(keys(d));expect(planAudioSourceRegions(copy).regions[0]!.regionKey).not.toBe(before.regions[0]!.regionKey);
    const cut=split(d,30);for(const c of audio(cut)){c.id+='-new';if(c.content.kind==='audio')c.content.rate={num:68,den:50};}cut.clips.reverse();expect(keys(cut)).toEqual(keys(d));expect(keys(parseSequence(serializeSequence(cut)))).toEqual(keys(d));
    const duplicated=fixture(),other:SequenceClip=structuredClone(duplicated.clips[1]!);other.id='independent-insertion';other.startFrame=80;delete other.linkGroupId;duplicated.clips.push(other);duplicated.sequenceEndFrame=140;validateSequenceDocument(duplicated);
    const p=planAudioSourceRegions(duplicated);expect(p.regions).toHaveLength(2);expect(new Set(p.regions.map(g=>g.pcmKey)).size).toBe(1);expect(new Set(p.regions.map(g=>g.regionKey)).size).toBe(2);
  });
  it('loop describes the complete physical period while keeping evaluation phase',()=>{
    const d=fixture();d.clips=d.clips.filter(c=>c.content.kind==='audio');delete d.clips[0]!.linkGroupId;d.fps=r(1);d.clips[0]!.durationFrames=12;d.sequenceEndFrame=12;
    const c=d.clips[0]!.content;if(c.kind!=='audio')throw Error('fixture');c.loop=true;c.role='music';c.sourceIn=r(29,3);for(const s of d.assets[0]!.streams)s.duration=r(8);validateSequenceDocument(d);
    const before=planAudioSourceRegions(d);expect(before.regions[0]).toMatchObject({kind:'loop',start:r(0),end:r(8),physical:{start:r(0),end:r(8)}});expect(before.clips[0]!.sourceIn).toEqual(r(29,3));
    const cut=applySequenceCommand(d,{type:'split',clipIds:['audio'],frame:3,linked:false});expect(keys(cut)).toEqual(keys(d));expect(planAudioSourceRegions(cut).clips[1]!.sourceIn).toEqual(r(1031,75));
  });
  it('replay, real Store roundtrip and one Undo restore region identities without mutating the input',()=>{
    const d=registered(),bytes=serializeSequence(d),session=new SequenceSession('audio-regions',d),request={sessionId:'audio-regions',executionId:'split',expectedRevision:d.revision,command:{type:'split' as const,clipIds:['video'],frame:20,linked:true}};
    const first=session.execute(request);expect(session.execute(request).replayed).toBe(true);expect(keys(first.document)).toEqual(keys(d));const directory=mkdtempSync(join(tmpdir(),'audio-region-'));
    try{const store=new SequenceStore(directory);store.save({document:first.document,expectedSavedRevision:null,executionId:'save'});expect(planAudioSourceRegions(store.load()!.document)).toEqual(planAudioSourceRegions(first.document));}finally{rmSync(directory,{recursive:true,force:true});}
    const restored=session.execute({sessionId:'audio-regions',executionId:'undo',expectedRevision:first.document.revision,command:{type:'undo'}}).document;expect(planAudioSourceRegions(restored)).toEqual(planAudioSourceRegions(d));expect(serializeSequence(d)).toBe(bytes);
  });
});
