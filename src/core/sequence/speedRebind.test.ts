import {describe,it,expect} from 'vitest';
import {applySequenceCommand} from './commands';
import {rational as r} from './time';
import {type SequenceDocument,DEFAULT_TEXT_APPEARANCE} from './model';
import {validateSequenceDocument} from './validate';
export function fixture():SequenceDocument {
  return {schemaVersion:2,id:'split-test',name:'split',revision:0,fps:r(1),resolution:{width:640,height:360},sequenceEndFrame:4,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],
    assets:[{id:'asset',kind:'media',file:'media/test.mp4',name:'test',fingerprint:'private',streams:[{index:0,kind:'video',codec:'h264',duration:r(100),width:640,height:360,frameRate:r(1)},{index:1,kind:'audio',codec:'aac',duration:r(100),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],
    clips:[{id:'video',trackId:'v',name:'video',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-1),rate:r(1),duration:r(20)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(2)}},
      {id:'audio',trackId:'a',name:'audio',startFrame:0,durationFrames:4,linkGroupId:'linked',clock:{offset:r(-3),rate:r(3),duration:r(40)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
      {id:'caption',trackId:'t',name:'caption',startFrame:1,durationFrames:2,clock:{offset:r(0),rate:r(1),duration:r(2)},content:{kind:'telop',data:{text:'保持'},appearance:{...DEFAULT_TEXT_APPEARANCE}},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(2),sourceEnd:r(6)}}],transitions:[]};
}
export const registered=()=>applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
describe('registered linked split',()=>{
  it('splits a registered main with audio and source caption while preserving displayed time',()=>{
    const next=applySequenceCommand(registered(),{type:'split',clipIds:['video'],frame:2});
    validateSequenceDocument(next);
    expect(next.clips.filter(c=>c.content.kind==='video').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,2],[2,2]]);
    expect(next.clips.filter(c=>c.content.kind==='telop').map(c=>[c.startFrame,c.durationFrames])).toEqual([[1,1],[2,1]]);
  });
});

import {parseSequence,serializeSequence,sequenceContentBytes} from './validate';
import {refreshCaptionBaselines,captionInputDigest,captionLedgers,captionPartWindow,captionProjectionKey,materializeSpeedCaptions,upgradeNativeSpeedMetadata} from './speedCaptionLedger';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
const visible=(doc:SequenceDocument)=>{const c=structuredClone(doc);delete c.speed;for(const clip of c.clips)delete clip.speed;return JSON.parse(sequenceContentBytes(c));};
const split=(doc:SequenceDocument,frame:number,id='video')=>applySequenceCommand(doc,{type:'split',clipIds:[id],frame});

describe('versioned upgrade and split intent',()=>{
  it('upgrades explicitly without resampling any saved main/audio basis or visible property',()=>{
    const before=registered(),next=applySequenceCommand(before,{type:'upgrade-native-speed'});
    expect(next.speed).toEqual({...before.speed,version:2});expect(visible(next)).toEqual(visible(before));
    for(const old of before.clips.filter(c=>c.speed)){const {captions:_,captionBaselines:__,...basis}=next.clips.find(c=>c.id===old.id)!.speed!;expect(basis).toEqual(old.speed);}
    expect(applySequenceCommand(next,{type:'upgrade-native-speed'})).toBe(next);
    expect(parseSequence(serializeSequence(before))).toEqual(before);
    expect(()=>parseSequence(JSON.stringify({...next,speed:{...next.speed,version:3}}))).toThrow();
    const wrong=structuredClone(before);wrong.clips[0]!.speed!.clock.offset=r(0);expect(()=>applySequenceCommand(wrong,{type:'upgrade-native-speed'})).toThrow();
  });
  it('keeps a no-op boundary split in v1 with no revision or history change',()=>{const before=registered();expect(split(before,0)).toBe(before);expect(split(before,4)).toBe(before);});
  it.each([1,2,3])('matches the old unregistered split exactly at %s, with independent audio and key clocks',frame=>{
    const doc=fixture();for(const [i,c] of doc.clips.entries())c.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-7-i,3),rate:r(i+2,3),duration:r(50)}};
    const registered=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
    const actual=split(registered,frame),expected=split(doc,frame);
    // Newly reserved ledger IDs may advance allocator counters; compare using
    // occurrence order, and separately assert every actual anchor/provider edge.
    const normalize=(d:SequenceDocument)=>{const v=visible(d);const ids=new Map(v.clips.map((c:SequenceDocument['clips'][number],i:number)=>[c.id,`clip${i}`]));const links=new Map<string,string>();for(const c of v.clips){c.id=ids.get(c.id);if(c.linkGroupId){if(!links.has(c.linkGroupId))links.set(c.linkGroupId,`link${links.size}`);c.linkGroupId=links.get(c.linkGroupId);}if(c.anchor?.kind==='source')c.anchor.clipOccurrenceId=ids.get(c.anchor.clipOccurrenceId);}return v;};
    expect(normalize(actual)).toEqual(normalize(expected));validateSequenceDocument(actual);
    const rightAudio=actual.clips.find(c=>c.content.kind==='audio'&&c.startFrame===frame)!;
    expect(rightAudio.clock.offset).toEqual(r(-3+3*frame));expect(rightAudio.speed!.clock.slope).toEqual(r(3,2));
    expect(rightAudio.visual!.keyframeClock!.offset).toEqual(r(-8+3*frame,3));
  });
  it('preserves a latent left source intent, re-materializes at a literal slower rate, and restores the same IDs',()=>{
    const doc=fixture();doc.clips[2]!.durationFrames=1;doc.clips[2]!.anchor={kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(2),sourceEnd:r(4)};
    const initial=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
    const adopted=upgradeNativeSpeedMetadata(initial),ledger=captionLedgers(adopted)[0]!;
    // Independent literal saved intent [1,3] rounds to existing [1,2] at rate2.
    ledger.parts[0]!.intentStart=r(1);ledger.parts[0]!.intentEnd=r(3);refreshCaptionBaselines(adopted);
    validateSequenceDocument(adopted);
    const cut=split(adopted,1),parts=captionLedgers(cut)[0]!.parts;
    expect(parts.map(p=>[p.intentStart.num,p.intentEnd.num,captionPartWindow(cut,p)])).toEqual([[1,2,{startFrame:1,endFrame:1}],[2,3,{startFrame:1,endFrame:2}]]);
    expect(parts[1]!.reservedRenderId).toBe('caption');expect(parts[0]!.reservedRenderId).not.toBe('caption');
    const slow=structuredClone(cut);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=8;
    for(const c of slow.clips)if(c.speed){c.startFrame*=2;c.durationFrames*=2;c.clock.rate=r(c.clock.rate.num,c.clock.rate.den*2);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);}
    slow.clips=slow.clips.filter(c=>c.content.kind!=='telop').concat(materializeSpeedCaptions(slow));
    validateSequenceDocument(slow);expect(slow.clips.filter(c=>c.content.kind==='telop').map(c=>[c.id,c.startFrame,c.durationFrames])).toEqual([[parts[0]!.reservedRenderId,1,1],['caption',2,1]]);
    const restored=structuredClone(slow);restored.speed!.globalRate=r(2);restored.sequenceEndFrame=4;
    for(const c of restored.clips)if(c.speed){c.startFrame/=2;c.durationFrames/=2;c.clock.rate=r(c.clock.rate.num*2,c.clock.rate.den);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(2);}
    restored.clips=restored.clips.filter(c=>c.content.kind!=='telop').concat(materializeSpeedCaptions(restored));
    validateSequenceDocument(restored);expect(restored).toEqual(cut);
    const corrupted=structuredClone(cut);captionLedgers(corrupted)[0]!.template.content={kind:'telop',data:null as never};expect(()=>validateSequenceDocument(corrupted)).toThrow();
  });
});

describe('owner-local inverse and rounded coverage lineage',()=>{
  function chain(spans:number[]){
    const doc=fixture();for(const stream of doc.assets[0]!.streams!)stream.duration=r(2000);doc.clips=spans.map((span,i)=>({...structuredClone(doc.clips[0]!),id:`main${i}`,linkGroupId:undefined,startFrame:spans.slice(0,i).reduce((a,b)=>a+b,0),durationFrames:span,
      clock:{offset:r(-7+i),rate:r(1),duration:r(1000)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-9+i),rate:r(3),duration:r(1200)}},content:{kind:'video' as const,assetId:'asset',streamIndex:0,sourceIn:r(i*10),rate:r(1)}}));
    doc.sequenceEndFrame=spans.reduce((a,b)=>a+b,0);
    return applySequenceCommand(doc,{type:'register-native-speed',groupId:'chain',mainClipIds:doc.clips.map(c=>c.id),mainAudioBindings:[]});
  }
  it('uses the actual cumulative prefix at frame3, keeping source and unmodified span endpoints',()=>{
    const doc=chain([3,3,3]);doc.sequenceEndFrame=6;
    for(const [i,c] of doc.clips.entries()){
      if(c.speed?.kind!=='main'||c.content.kind!=='video')throw Error('fixture');
      c.speed.override=r(2);c.startFrame=i*2;c.durationFrames=2;c.content.rate=r(2);c.clock.rate=r(2);c.visual!.keyframeClock!.rate=r(6);
    }
    validateSequenceDocument(doc);const next=split(doc,3,'main1');
    const b=next.clips.filter(c=>c.speed?.evaluationOwnerId==='main1');
    expect(b.map(c=>[c.startFrame,c.durationFrames,c.speed!.kind==='main'?c.speed!.span:null,c.speed!.source])).toEqual([
      [2,1,r(2),{assetId:'asset',streamIndex:0,sourceStart:r(10),sourceEnd:r(12)}],
      [3,1,r(1),{assetId:'asset',streamIndex:0,sourceStart:r(12),sourceEnd:r(13)}]]);
    expect(b[1]!.clock.offset).toEqual(r(-4));expect(b[1]!.visual!.keyframeClock!.offset).toEqual(r(-2));
  });
  it('keeps absolute phase intent13 distinct from coverage12, then literal1 -> 2 restores source/clock/IDs',()=>{
    const original=chain([3,601]),doc=structuredClone(original);doc.speed!.globalRate=r(2);doc.sequenceEndFrame=302;
    doc.clips[0]!.durationFrames=2;doc.clips[1]!.startFrame=2;doc.clips[1]!.durationFrames=300;
    for(const c of doc.clips){if(c.content.kind!=='video')throw Error('fixture');c.content.rate=r(2);c.clock.rate=r(2);c.visual!.keyframeClock!.rate=r(6);}
    validateSequenceDocument(doc);const cut=split(doc,3,'main1'),right=cut.clips.find(c=>c.startFrame===3)!;
    expect(right.speed!.source).toMatchObject({sourceStart:r(13),sourceEnd:r(611)});expect(right.speed).toMatchObject({span:r(598),evaluationOwnerId:'main1'});
    expect(right.content).toHaveProperty('sourceIn',r(12));expect(right.clock.offset).toEqual(r(-4));expect(right.visual!.keyframeClock!.offset).toEqual(r(-2));
    const slow=structuredClone(cut);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=604;
    const windows=[[0,3],[3,3],[6,598]];
    for(const [i,c] of slow.clips.entries()){
      c.startFrame=windows[i]![0]!;c.durationFrames=windows[i]![1]!;
      if(c.content.kind!=='video')throw Error('fixture');c.content.rate=r(1);c.clock.rate=r(1);c.visual!.keyframeClock!.rate=r(3);
      if(i===2){c.content.sourceIn=r(13);c.clock.offset=r(-3);c.visual!.keyframeClock!.offset=r(1);}
    }
    validateSequenceDocument(slow);expect(slow.clips.map(c=>c.speed)).toEqual(cut.clips.map(c=>c.speed));
    const restored=structuredClone(slow);restored.speed!.globalRate=r(2);restored.sequenceEndFrame=302;
    const back=[[0,2],[2,1],[3,299]];
    for(const [i,c] of restored.clips.entries()){
      c.startFrame=back[i]![0]!;c.durationFrames=back[i]![1]!;if(c.content.kind!=='video')throw Error('fixture');c.content.rate=r(2);c.clock.rate=r(2);c.visual!.keyframeClock!.rate=r(6);
      if(i===2){c.content.sourceIn=r(12);c.clock.offset=r(-4);c.visual!.keyframeClock!.offset=r(-2);}
    }
    validateSequenceDocument(restored);expect(restored).toEqual(cut);
    // Another cut retains the first surviving owner, never an intermediate link.
    const again=split(cut,4,right.id);expect(again.clips.filter(c=>c.speed?.evaluationOwnerId==='main1')).toHaveLength(3);validateSequenceDocument(again);
    const mixed=structuredClone(cut);mixed.sequenceEndFrame=203;
    mixed.clips[1]!.durationFrames=2;
    const changed=mixed.clips[2]!;if(changed.speed?.kind!=='main'||changed.content.kind!=='video')throw Error('fixture');
    changed.speed.override=r(3);changed.startFrame=4;changed.durationFrames=199;changed.content.rate=r(3);changed.content.sourceIn=r(16);changed.clock={...changed.clock,offset:r(0),rate:r(3)};changed.visual!.keyframeClock={...changed.visual!.keyframeClock!,offset:r(10),rate:r(9)};
    expect(()=>validateSequenceDocument(mixed)).toThrow(/異なる速度/);
    for(const mutate of [
      (x:SequenceDocument)=>{x.clips[2]!.speed!.evaluationOwnerId=x.clips[2]!.id;},
      (x:SequenceDocument)=>{x.clips[2]!.speed!.clock.offset=r(400);},
      (x:SequenceDocument)=>{x.clips[2]!.speed!.source.sourceStart=r(12);},
      (x:SequenceDocument)=>{x.clips[2]!.speed!.keyframeClock!.slope=r(8);},
    ]){const bad=structuredClone(cut);mutate(bad);expect(()=>validateSequenceDocument(bad)).toThrow();}
  });
});

import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
describe('split identity, rollback and persistence',()=>{
  it('keeps identical-asset occurrences and their captions bound to their own provider',()=>{
    const doc=fixture(),other=structuredClone(doc.clips).map(c=>({...c,id:`other-${c.id}`,linkGroupId:c.linkGroupId?'other-link':undefined,startFrame:c.startFrame+5}));
    other[2]!.anchor={...(other[2]!.anchor as Extract<NonNullable<SequenceDocument['clips'][number]['anchor']>,{kind:'source'}>),clipOccurrenceId:'other-audio'};
    doc.clips.push(...other);doc.sequenceEndFrame=9;
    const reg=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video','other-video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'},{audioClipId:'other-audio',providerId:'other-video'}]});
    const next=split(reg,2);expect(next.clips.find(c=>c.id==='other-caption')!.anchor).toHaveProperty('clipOccurrenceId','other-audio');
    expect(next.clips.find(c=>c.id==='other-audio')!.speed).toMatchObject({providerId:'other-video'});
    expect(next.clips.find(c=>c.id==='other-video')!.startFrame).toBe(5);
    const ledger=captionLedgers(next).find(l=>l.captionId==='other-caption')!;expect(ledger.parts.map(p=>p.providerId)).toEqual(['other-audio']);
    validateSequenceDocument(next);
  });
  it('reserves caption part IDs before allocating new fragments, and rejects cross-kind collisions',()=>{
    const doc=fixture();doc.clips[2]!.id='caption-part-1';
    const next=split(applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]}),2);
    const ledger=captionLedgers(next)[0]!,ids=next.clips.map(c=>c.id);
    expect(new Set(ids).size).toBe(ids.length);for(const p of ledger.parts)expect(ids).not.toContain(p.partId);
    expect(ledger.parts[0]!.reservedRenderId).toBe('caption-part-1');
    for(const field of ['partId','reservedRenderId'] as const){const bad=structuredClone(next);captionLedgers(bad)[0]!.parts[0]![field]='v';expect(()=>validateSequenceDocument(bad)).toThrow();}
  });
  it('does not accept a baseline belonging to a different override/phase projection',()=>{
    const next=split(registered(),2),ledger=captionLedgers(next)[0]!,key=ledger.baselineProjection.inputKey;
    for(const mutate of [
      (x:SequenceDocument)=>{if(x.clips[0]!.speed?.kind==='main')x.clips[0]!.speed.override=r(2);},
      (x:SequenceDocument)=>{if(x.clips[0]!.speed?.kind==='main')x.clips[0]!.speed.runHead={phase:r(2),gapFrames:0};},
      (x:SequenceDocument)=>{x.speed!.sequenceEndBasis.offsetFrames=1;},
    ]){const different=structuredClone(next);mutate(different);expect(captionProjectionKey(different,captionLedgers(different)[0]!)).not.toBe(key);}
    const forged=structuredClone(next);captionLedgers(forged)[0]!.baselineProjection.inputKey='{}';expect(()=>validateSequenceDocument(forged)).toThrow();
  });
  it('keeps v1 upgrade plus split atomic for rollback, replay and a single Undo/Redo',()=>{
    const before=registered(),session=new SequenceSession('s',before),request={sessionId:'s',expectedRevision:before.revision,executionId:'split',command:{type:'split' as const,clipIds:['video'],frame:2}};
    const next=session.execute(request).document;expect(next.speed!.version).toBe(2);expect(next.revision).toBe(before.revision+1);
    expect(session.execute(request)).toHaveProperty('replayed',true);
    expect(()=>session.execute({...request,executionId:'stale'})).toThrow();
    session.execute({sessionId:'s',expectedRevision:next.revision,executionId:'undo',command:{type:'undo'}});
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(before));expect(session.canUndo).toBe(false);
    session.execute({sessionId:'s',expectedRevision:session.document.revision,executionId:'redo',command:{type:'redo'}});
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(next));
    const failed=new SequenceSession('f',before);
    expect(()=>failed.execute({sessionId:'f',expectedRevision:before.revision,executionId:'batch',command:{type:'batch',commands:[request.command,{type:'update-clip',clipId:'missing',patch:{name:'fail'}}]}})).toThrow();
    expect(failed.document).toEqual(before);expect(failed.canUndo).toBe(false);
  });
  it('roundtrips v2 ledger and original v1 Undo through the real atomic Store',()=>{
    const directory=mkdtempSync(join(tmpdir(),'native-speed-split-'));
    try{
      const before=registered(),store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'initial',document:before});
      const session=new SequenceSession('s',before),next=session.execute({sessionId:'s',expectedRevision:before.revision,executionId:'split',command:{type:'split',clipIds:['video'],frame:2}}).document;
      const request={expectedSavedRevision:before.revision,executionId:'save',document:next};store.save(request);
      const reopened=new SequenceStore(directory);expect(reopened.load()!.document).toEqual(next);expect(reopened.save(request).replayed).toBe(true);
      const bytes=readFileSync(store.file,'utf8'),bad=structuredClone(next);captionLedgers(bad)[0]!.parts[0]!.providerId='video';
      expect(()=>reopened.save({expectedSavedRevision:next.revision,executionId:'bad',document:bad})).toThrow();expect(readFileSync(store.file,'utf8')).toBe(bytes);
      const undo=session.execute({sessionId:'s',expectedRevision:next.revision,executionId:'undo',command:{type:'undo'}}).document;
      reopened.save({expectedSavedRevision:next.revision,executionId:'undo-save',document:undo});expect(sequenceContentBytes(reopened.load()!.document)).toBe(sequenceContentBytes(before));
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});

describe('latent validation and audio phase roots',()=>{
  it('validates every latent template and rejects foreign IDs even when there are no visible captions',()=>{
    const doc=fixture();doc.clips[2]!.durationFrames=1;doc.clips[2]!.anchor={kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(2),sourceEnd:r(4)};
    const reg=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
    const hidden=upgradeNativeSpeedMetadata(reg),l=captionLedgers(hidden)[0]!;
    l.parts[0]!.intentStart=r(1);l.parts[0]!.intentEnd=r(2);l.baselineProjection.parts[0]!.endFrame=1;refreshCaptionBaselines(hidden);hidden.clips=hidden.clips.filter(c=>c.id!=='caption');
    validateSequenceDocument(hidden);expect(materializeSpeedCaptions(hidden)).toEqual([]);
    const faster=structuredClone(hidden);faster.speed!.globalRate=r(5);faster.sequenceEndFrame=2;
    for(const c of faster.clips){c.durationFrames=2;if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(5);c.clock.rate=c.content.kind==='audio'?r(15,2):r(5,2);}
    expect(()=>validateSequenceDocument(faster)).toThrow(/字幕全体/);
    for(const mutate of [
      (x:typeof l)=>{x.template.name='';},(x:typeof l)=>{x.template.trackId='missing';},
      (x:typeof l)=>{x.template.content={kind:'telop',data:null as never};},
      (x:typeof l)=>{x.template.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:2,keyframes:[]};},
      (x:typeof l)=>{x.captionId='video';},(x:typeof l)=>{x.parts[0]!.reservedRenderId='linked';},
      (x:typeof l)=>{x.parts[0]!.partId='linked';},
    ]){const bad=structuredClone(hidden);mutate(captionLedgers(bad)[0]!);expect(()=>validateSequenceDocument(bad)).toThrow();}
  });
  it('re-evaluates audio coverage and its own effect/key phase at literal rate1 without changing saved intent',()=>{
    const doc=fixture();for(const stream of doc.assets[0]!.streams!)stream.duration=r(2000);
    doc.clips=doc.clips.slice(0,2);const first=structuredClone(doc.clips[0]!);first.id='first';first.linkGroupId=undefined;first.durationFrames=3;first.content={kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)};
    doc.clips.unshift(first);
    doc.clips[1]!.startFrame=3;doc.clips[1]!.durationFrames=601;doc.clips[1]!.content={kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(10),rate:r(1)};
    doc.clips[2]!.startFrame=3;doc.clips[2]!.durationFrames=601;
    const audio=doc.clips[2]!;if(audio.content.kind!=='audio')throw Error('fixture');audio.content.sourceIn=r(10);audio.content.rate=r(1);audio.clock={offset:r(-5),rate:r(3),duration:r(2000)};audio.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(-7),rate:r(5),duration:r(3000)}};
    doc.sequenceEndFrame=604;
    const current=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['first','video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
    current.speed!.globalRate=r(2);current.sequenceEndFrame=302;
    for(const [i,c] of current.clips.entries()){c.startFrame=i===0?0:2;c.durationFrames=i===0?2:300;c.clock.rate=r(c.clock.rate.num*2,c.clock.rate.den);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(2);if(c.visual?.keyframeClock)c.visual.keyframeClock.rate=r(10);}
    validateSequenceDocument(current);const cut=split(current,3),ar=cut.clips.find(c=>c.content.kind==='audio'&&c.startFrame===3)!;
    expect(ar.speed).toMatchObject({evaluationOwnerId:'audio',source:{sourceStart:r(13),sourceEnd:r(611)},clock:{offset:r(-5),slope:r(3)}});
    expect(ar.content).toHaveProperty('sourceIn',r(12));expect(ar.clock.offset).toEqual(r(1));expect(ar.visual!.keyframeClock!.offset).toEqual(r(3));
    const slow=structuredClone(cut);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=604;
    for(const c of slow.clips){const right=c.startFrame===3;c.startFrame=c.id==='first'?0:right?6:3;c.durationFrames=c.id==='first'||!right?3:598;
      if(c.content.kind==='video'||c.content.kind==='audio'){c.content.rate=r(1);if(right)c.content.sourceIn=r(13);}
      c.clock.rate=r(c.clock.rate.num,c.clock.rate.den*2);
      if(right)c.clock.offset=c.content.kind==='audio'?r(4):r(2);
      if(c.visual?.keyframeClock){c.visual.keyframeClock.rate=r(5);if(right)c.visual.keyframeClock.offset=r(8);}
    }
    validateSequenceDocument(slow);expect(slow.clips.map(c=>c.speed)).toEqual(cut.clips.map(c=>c.speed));
    const back=structuredClone(slow);back.speed!.globalRate=r(2);back.sequenceEndFrame=302;
    for(const c of back.clips){const right=c.startFrame===6;c.startFrame=c.id==='first'?0:right?3:2;c.durationFrames=c.id==='first'?2:right?299:1;
      if(c.content.kind==='video'||c.content.kind==='audio'){c.content.rate=r(2);if(right)c.content.sourceIn=r(12);}
      c.clock.rate=r(c.clock.rate.num*2,c.clock.rate.den);if(right)c.clock.offset=r(1);
      if(c.visual?.keyframeClock){c.visual.keyframeClock.rate=r(10);if(right)c.visual.keyframeClock.offset=r(3);}
    }
    validateSequenceDocument(back);expect(back).toEqual(cut);
    const wrong=structuredClone(cut);wrong.clips.find(c=>c.id===ar.id)!.speed!.evaluationOwnerId='video';expect(()=>validateSequenceDocument(wrong)).toThrow();
  });
});


describe('upgrade allocation shares the full existing ID space',()=>{
  it.each(['link','continuation'])('does not reuse an existing %s ID for a caption part',kind=>{
    const doc=fixture();
    if(kind==='link'){doc.clips[0]!.linkGroupId='caption-part-1';doc.clips[1]!.linkGroupId='caption-part-1';}
    else doc.clips[0]!.continuationGroupId='caption-part-1';
    const before=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
    const next=applySequenceCommand(before,{type:'upgrade-native-speed'});
    expect(captionLedgers(next)[0]!.parts[0]!.partId).not.toBe('caption-part-1');expect(visible(next)).toEqual(visible(before));validateSequenceDocument(next);
  });
});

describe('split retains the uncut transition cap owner',()=>{
  it('preserves a 20-frame transition when splitting a 100-frame owner before the transition at70',()=>{
    const doc=fixture();for(const stream of doc.assets[0]!.streams!)stream.duration=r(2000);
    doc.clips=[0,80].map((start,i)=>({...structuredClone(doc.clips[0]!),id:`main${i}`,linkGroupId:undefined,startFrame:start,durationFrames:100,content:{kind:'video' as const,assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}}));
    doc.sequenceEndFrame=180;doc.transitions=[{id:'join',trackId:'v',outClipId:'main0',inClipId:'main1',kind:'crossfade',startFrame:80,durationFrames:20,audioCurve:'none'}];
    const audio=structuredClone(fixture().clips[1]!);audio.durationFrames=100;if(audio.content.kind!=='audio')throw Error('fixture');audio.content.rate=r(1);audio.linkGroupId='overlap-a';doc.clips[0]!.linkGroupId='overlap-a';doc.clips.push(audio);
    const reg=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['main0','main1'],mainAudioBindings:[{audioClipId:'audio',providerId:'main0'}]});
    const next=split(reg,70,'main0');validateSequenceDocument(next);
    expect(next.clips.filter(c=>c.content.kind==='video').map(c=>[c.startFrame,c.durationFrames])).toEqual([[0,70],[70,30],[80,100]]);
    expect(next.transitions).toEqual([{...doc.transitions[0],outClipId:next.clips[1]!.id}]);
    expect(next.clips[2]!.speed).toMatchObject({overlapBefore:r(20)});
    const rightAudio=next.clips.find(c=>c.content.kind==='audio'&&c.startFrame===70)!;expect(rightAudio.clock.offset).toEqual(r(207));expect(rightAudio.speed).toMatchObject({providerId:next.clips[1]!.id,evaluationOwnerId:'audio'});
    const faster=structuredClone(next);faster.speed!.globalRate=r(2);faster.sequenceEndFrame=90;
    for(const c of faster.clips){c.startFrame/=2;c.durationFrames/=2;c.clock.rate=r(c.clock.rate.num*2,c.clock.rate.den);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(2);}
    faster.transitions[0]!.startFrame=40;faster.transitions[0]!.durationFrames=10;validateSequenceDocument(faster);
    expect(faster.clips.map(c=>c.speed)).toEqual(next.clips.map(c=>c.speed));
    const restored=structuredClone(faster);restored.speed!.globalRate=r(1);restored.sequenceEndFrame=180;
    for(const c of restored.clips){c.startFrame*=2;c.durationFrames*=2;c.clock.rate=r(c.clock.rate.num,c.clock.rate.den*2);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);}
    restored.transitions[0]!.startFrame=80;restored.transitions[0]!.durationFrames=20;validateSequenceDocument(restored);expect(restored).toEqual(next);
  });
});

import {speedProjectionForDocument} from './speedCaptionLedger';
describe('fragment endpoint ownership',()=>{
  it('returns saved fragment0/span at an ambiguous shared rounded frame, and root inverse only inside',()=>{
    const doc=fixture();doc.clips=doc.clips.slice(0,2);doc.sequenceEndFrame=3;
    for(const c of doc.clips){c.durationFrames=3;if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);}
    const reg=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
    const cut=split(reg,1),literal=structuredClone(cut);literal.speed!.globalRate=r(2);literal.sequenceEndFrame=2;
    for(const c of literal.clips){const right=c.startFrame===1;c.durationFrames=1;if(c.content.kind==='video'||c.content.kind==='audio'){c.content.rate=r(2);if(right)c.content.sourceIn=r(2);}
      c.clock.rate=r(c.clock.rate.num*2,c.clock.rate.den);if(right)c.clock.offset=c.content.kind==='audio'?r(3):r(1);
    }
    validateSequenceDocument(literal);const p=speedProjectionForDocument(literal),right=literal.clips.find(c=>c.content.kind==='video'&&c.startFrame===1)!;
    expect(p.point({ownerId:'video',kind:'clip',offset:r(1)})).toBe(1);
    expect(p.inverse('video',1)).toEqual(r(1)); // unsliced root inverse would return2
    expect(p.inverse(right.id,1)).toEqual(r(0));expect(p.inverse(right.id,2)).toEqual(r(2));
    expect(p.point({ownerId:right.id,kind:'clip',offset:r(2)})).toBe(2);
    expect(()=>p.inverse(right.id,0)).toThrow();
  });
});

import {createHash} from 'node:crypto';
describe('compact canonical baseline digest',()=>{
  it('matches independent native SHA-256 and normalizes non-reduced Rational values through Store serialization',()=>{
    const before=registered();before.clips[0]!.speed!.source.sourceStart={num:0,den:2};before.clips[1]!.speed!.source.sourceStart={num:0,den:3};before.clips[0]!.speed!.clock.slope={num:2,den:4};
    const next=upgradeNativeSpeedMetadata(before),ledger=captionLedgers(next)[0]!;
    function canonical(v:unknown):unknown {
      if(Array.isArray(v))return v.map(canonical);
      if(v&&typeof v==='object'){
        const x=v as Record<string,unknown>;
        if(Object.keys(x).length===2&&typeof x.num==='number'&&typeof x.den==='number'){
          let a=Math.abs(x.num),b=x.den;while(b){const n=a%b;a=b;b=n;}return {den:x.den/a,num:x.num/a};
        }
        return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));
      }
      return v;
    }
    const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
    const providers=next.clips.filter(c=>c.speed).map(c=>{const basis={...c.speed!};delete basis.captions;delete basis.captionBaselines;return {id:c.id,basis};}).sort((a,b)=>a.id<b.id?-1:1);
    const input={documentDigest:hash({document:next.speed,providers}),parts:ledger.parts.map(p=>({partId:p.partId,providerId:p.providerId,intentStart:p.intentStart,intentEnd:p.intentEnd,reservedRenderId:p.reservedRenderId}))};
    expect(ledger.baselineProjection.snapshotKey).toBe(hash({document:next.speed,providers}));expect(ledger.baselineProjection.inputKey).toBe(hash(input));expect(ledger.baselineProjection.inputKey).toMatch(/^[a-f0-9]{64}$/);
    const reopened=parseSequence(serializeSequence(next));expect(captionProjectionKey(reopened,captionLedgers(reopened)[0]!)).toBe(ledger.baselineProjection.inputKey);validateSequenceDocument(reopened);
  });
  it('upgrades and saves 300 main/audio pairs with400 captions below the actual Store size limit',()=>{
    const doc=fixture(),original=structuredClone(doc.clips);doc.fps=r(30);doc.sequenceEndFrame=18000;doc.clips=[];
    const mainClipIds:string[]=[],mainAudioBindings:Array<{audioClipId:string;providerId:string}>=[];
    for(let i=0;i<300;i++){
      const video={...structuredClone(original[0]!),id:`video-${i}`,linkGroupId:`link-${i}`,startFrame:i*60,durationFrames:60};
      const audio={...structuredClone(original[1]!),id:`audio-${i}`,linkGroupId:`link-${i}`,startFrame:i*60,durationFrames:60};doc.clips.push(video,audio);mainClipIds.push(video.id);mainAudioBindings.push({audioClipId:audio.id,providerId:video.id});
      for(let j=0;j<(i<100?2:1);j++)doc.clips.push({...structuredClone(original[2]!),id:`caption-${i}-${j}`,startFrame:i*60+10+j*20,durationFrames:10,anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:audio.id,sourceStart:r((10+j*20)*2,30),sourceEnd:r((20+j*20)*2,30)}});
    }
    const registered=applySequenceCommand(doc,{type:'register-native-speed',groupId:'large',mainClipIds,mainAudioBindings});
    const upgraded=applySequenceCommand(registered,{type:'upgrade-native-speed'}),bytes=Buffer.byteLength(serializeSequence(upgraded));
    expect(captionLedgers(upgraded)).toHaveLength(400);expect(captionLedgers(upgraded).reduce((n,l)=>n+l.baselineProjection.inputKey.length,0)).toBe(25600);expect(bytes).toBeLessThan(2*1024*1024);
    const directory=mkdtempSync(join(tmpdir(),'native-speed-split-size-'));
    try{const store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'large',document:upgraded});expect(store.load()!.document).toEqual(parseSequence(serializeSequence(upgraded)));}
    finally{rmSync(directory,{recursive:true,force:true});}
    console.info(JSON.stringify({case:'300 main +300 audio +400 captions',serializedBytes:bytes,baselineDigestBytes:25600,storeLimit:64*1024*1024}));
  },20000);
});

describe('baseline integrity at another current speed',()=>{
  function slow(){const d=split(registered(),2);d.speed!.globalRate=r(1);d.sequenceEndFrame*=2;
    for(const c of d.clips)if(c.speed){c.startFrame*=2;c.durationFrames*=2;c.clock.rate=r(c.clock.rate.num,c.clock.rate.den*2);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);}
    d.clips=d.clips.filter(c=>c.content.kind!=='telop').concat(materializeSpeedCaptions(d));validateSequenceDocument(d);return d;
  }
  it('rejects damaged saved windows even while the current projection differs',()=>{
    const d=slow(),l=captionLedgers(d)[0]!;l.baselineProjection.parts[0]!.startFrame+=100;l.baselineProjection.parts[0]!.endFrame+=100;
    expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>parseSequence(JSON.stringify(d))).toThrow();
  });
  it('rejects a well-formed but nonexistent baseline digest even with visible captions',()=>{
    const d=slow();captionLedgers(d)[0]!.baselineProjection.inputKey='0'.repeat(64);
    expect(()=>validateSequenceDocument(d)).toThrow();
  });
});

describe('shared historical projection input',()=>{
  const table=(d:SequenceDocument)=>d.clips.find(c=>c.speed?.captionBaselines)!.speed!.captionBaselines!;
  const resign=(d:SequenceDocument)=>{const s=table(d)[0]!;s.key=captionInputDigest(s.input);for(const l of captionLedgers(d)){l.baselineProjection.snapshotKey=s.key;l.baselineProjection.inputKey=captionProjectionKey(d,l,s.key);}};
  it('replaces shared history after repeated split, without recursively copying ledgers or earlier tables',()=>{
    let d=split(registered(),2);const old=table(d)[0]!.key;
    d=split(d,1);d=split(d,3,d.clips.find(c=>c.content.kind==='video'&&c.startFrame===2)!.id);
    expect(table(d)).toHaveLength(1);expect(table(d)[0]!.key).not.toBe(old);
    expect(d.clips.filter(c=>c.speed?.captionBaselines)).toHaveLength(1);
    expect(table(d)[0]!.input.providers).toHaveLength(8);
    for(const p of table(d)[0]!.input.providers){expect(Object.hasOwn(p.basis,'captions')).toBe(false);expect(Object.hasOwn(p.basis,'captionBaselines')).toBe(false);}
    for(const l of captionLedgers(d))expect(l.baselineProjection.snapshotKey).toBe(table(d)[0]!.key);
    const bytes=JSON.stringify(d);validateSequenceDocument(d);expect(JSON.stringify(d)).toBe(bytes);expect(parseSequence(serializeSequence(d))).toEqual(d);
  });
  it.each(['duplicate','dangling','unreferenced','wrong-carrier','nested-ledger','nested-history'] as const)('rejects %s snapshot ownership',kind=>{
    const d=split(registered(),2),s=table(d)[0]!;
    if(kind==='duplicate')table(d).push(structuredClone(s));
    if(kind==='dangling')captionLedgers(d)[0]!.baselineProjection.snapshotKey='0'.repeat(64);
    if(kind==='unreferenced'){const extra=structuredClone(s);extra.input.document.globalRate=r(1);extra.key=captionInputDigest(extra.input);table(d).push(extra);}
    if(kind==='wrong-carrier'){const carrier=d.clips.find(c=>c.speed?.captionBaselines)!;d.clips.find(c=>c.speed?.kind==='main-audio')!.speed!.captionBaselines=carrier.speed!.captionBaselines;delete carrier.speed!.captionBaselines;}
    if(kind==='nested-ledger'||kind==='nested-history'){Object.assign(s.input.providers[0]!.basis,{[kind==='nested-ledger'?'captions':'captionBaselines']:[]});resign(d);}
    expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>parseSequence(JSON.stringify(d))).toThrow();
  });
  it.each(['unknown-input','unknown-document','unknown-basis','unknown-clock','unknown-source','bad-rational','negative-slope','missing-asset','wrong-stream','order','group','cycle','child-clock','unknown-run','duplicate-provider','unsorted-provider','version'] as const)('checks historical %s even after the attacker recomputes both SHA values',kind=>{
    const d=split(registered(),2),s=table(d)[0]!,providers=s.input.providers;
    const main=providers.find(p=>p.basis.kind==='main'&&p.basis.order===0)!,child=providers.find(p=>p.basis.kind==='main'&&p.basis.order===1)!;
    if(kind==='unknown-input')Object.assign(s.input,{extra:true});
    if(kind==='unknown-document')Object.assign(s.input.document,{extra:true});
    if(kind==='unknown-basis')Object.assign(main.basis,{extra:true});
    if(kind==='unknown-clock')Object.assign(main.basis.clock,{extra:true});
    if(kind==='unknown-source')Object.assign(main.basis.source,{extra:true});
    if(kind==='bad-rational')main.basis.clock.duration={num:1,den:0};
    if(kind==='negative-slope')main.basis.clock.slope=r(-1);
    if(kind==='missing-asset')main.basis.source.assetId='missing';
    if(kind==='wrong-stream')main.basis.source.streamIndex=1;
    if(kind==='order'&&main.basis.kind==='main')main.basis.order=2;
    if(kind==='group'&&main.basis.kind==='main')main.basis.groupId='other';
    if(kind==='cycle')main.basis.evaluationOwnerId=child.id;
    if(kind==='child-clock')child.basis.clock.offset=r(100);
    if(kind==='unknown-run'&&main.basis.kind==='main')main.basis.runHead={phase:r(0),gapFrames:0,extra:true} as never;
    if(kind==='duplicate-provider')providers.push(structuredClone(main));
    if(kind==='unsorted-provider')providers.reverse();
    if(kind==='version')s.input.document.version=1;
    resign(d);expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>parseSequence(JSON.stringify(d))).toThrow();
  });
  it('rejects old-window corruption and nonexistent keys on actual Store load while a different current speed is visible',()=>{
    const d=split(registered(),2);d.speed!.globalRate=r(1);d.sequenceEndFrame=8;
    for(const c of d.clips)if(c.speed){c.startFrame*=2;c.durationFrames*=2;c.clock.rate=r(c.clock.rate.num,c.clock.rate.den*2);if(c.content.kind==='audio'||c.content.kind==='video')c.content.rate=r(1);}
    d.clips=d.clips.filter(c=>c.content.kind!=='telop').concat(materializeSpeedCaptions(d));validateSequenceDocument(d);
    const directory=mkdtempSync(join(tmpdir(),'native-speed-baseline-load-'));
    try{const store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'good',document:d});const raw=readFileSync(store.file,'utf8');
      for(const kind of ['window','key']){const envelope=JSON.parse(raw),l=captionLedgers(envelope.document)[0]!;
        if(kind==='window'){l.baselineProjection.parts[0]!.startFrame+=100;l.baselineProjection.parts[0]!.endFrame+=100;}else l.baselineProjection.inputKey='0'.repeat(64);
        writeFileSync(store.file,JSON.stringify(envelope));expect(()=>new SequenceStore(directory).load()).toThrow();
      }
      writeFileSync(store.file,raw);expect(store.load()!.document).toEqual(d);
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
