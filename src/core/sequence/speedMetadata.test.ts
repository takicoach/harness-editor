import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {DEFAULT_TEXT_APPEARANCE,type SequenceDocument} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence,sequenceContentBytes,validateSequenceDocument} from './validate';
import {SequenceSession} from './session';
import {ScenePlan} from './scenePlan';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {SequenceStore} from '../../server/sequence/store';
import type {RegisterNativeSpeedCommand} from './speedMetadata';
import {SequenceError} from './errors';

function document():SequenceDocument {
  const clock={offset:r(7,3),rate:r(2,3),duration:r(200)};
  return {schemaVersion:2,id:'registered-test',name:'明示対象',revision:4,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:60,
    background:'#123456',ducking:{enabled:false,strength:'mid'},assets:[{id:'asset',kind:'media',file:'media/private.mp4',name:'素材',fingerprint:'private-v1',streams:[
      {index:0,kind:'video',codec:'h264',duration:r(30),width:640,height:360,frameRate:r(30)},
      {index:1,kind:'audio',codec:'aac',duration:r(30),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'任意の名前',enabled:true},{id:'text',kind:'visual',name:'主映像という紛らわしい名前',enabled:true},{id:'audio',kind:'audio',name:'原音',enabled:true}],
    clips:[
      {id:'a',trackId:'v',name:'A',startFrame:10,durationFrames:30,linkGroupId:'link-a',continuationGroupId:'continuation',clock:structuredClone(clock),
        content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(3),rate:r(2),endBehavior:'hold'},
        visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.8,keyframes:[{frame:r(11,2),value:{scale:1.2}}],keyframesOutside:'hold',keyframeClock:{offset:r(11,2),rate:r(5,7),duration:r(100)}}},
      {id:'b',trackId:'v',name:'B',startFrame:45,durationFrames:20,clock:structuredClone(clock),content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(8),rate:r(2)}},
      {id:'sound',trackId:'audio',name:'声',startFrame:10,durationFrames:30,linkGroupId:'link-a',clock:{offset:r(13,4),rate:r(3,2),duration:r(120)},
        content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(3),rate:r(2),loop:false,endBehavior:'silence',role:'speech',settings:{gainDb:-3,muted:false,fadeInFrames:3,fadeOutFrames:8}}},
      {id:'caption',trackId:'text',name:'字幕',startFrame:16,durationFrames:6,clock:{offset:r(0),rate:r(1),duration:r(6)},
        content:{kind:'telop',data:{text:'そのまま保持'},appearance:{...DEFAULT_TEXT_APPEARANCE}},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'sound',sourceStart:r(17,5),sourceEnd:r(19,5)}}],
    transitions:[],transcripts:[{assetId:'asset',streamIndex:1,words:[{id:'w',text:'そのまま保持',start:r(17,5),end:r(19,5)}]}]};
}
const command=():RegisterNativeSpeedCommand=>({type:'register-native-speed',groupId:'main-group',mainClipIds:['a','b'],mainAudioBindings:[{audioClipId:'sound',providerId:'a'}]});
const register=(doc:SequenceDocument)=>applySequenceCommand(doc,command());
const withoutMetadata=(doc:SequenceDocument)=>{const copy=structuredClone(doc);delete copy.speed;for(const c of copy.clips)delete c.speed;return sequenceContentBytes(copy);};
const dirs:string[]=[];afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});

describe('private native speed document registration',()=>{
  it('registers the current windows without changing any existing field, clock, anchor, ID or hidden tail',()=>{
    const original=document(),before=structuredClone(original);validateSequenceDocument(original);
    const next=register(original);
    expect(original).toEqual(before);expect(withoutMetadata(next)).toBe(sequenceContentBytes(original));expect(next.revision).toBe(5);
    expect(next.speed).toEqual({version:1,family:'native-exact-v1',groupId:'main-group',originFrame:10,fpsBasis:r(30),globalRate:r(2),sequenceEndBasis:{kind:'main-offset',offsetFrames:-5}});
    expect(next.clips[0]!.speed).toMatchObject({kind:'main',groupId:'main-group',order:0,span:r(60),source:{sourceStart:r(3),sourceEnd:r(5)},clock:{offset:r(7,3),slope:r(1,3),duration:r(200)},keyframeClock:{offset:r(11,2),slope:r(5,14),duration:r(100)}});
    expect(next.clips[1]!.speed).toMatchObject({kind:'main',order:1,span:r(40),runHead:{phase:r(60),gapFrames:5},source:{sourceStart:r(8),sourceEnd:r(28,3)}});
    expect(next.clips[2]!.speed).toMatchObject({kind:'main-audio',providerId:'a',source:{sourceStart:r(3),sourceEnd:r(5)},clock:{offset:r(13,4),slope:r(3,4),duration:r(120)}});
    expect(next.clips[3]!.speed).toBeUndefined();expect(next.clips.slice(0,2).every(c=>c.speed?.kind==='main'&&c.speed.override===undefined)).toBe(true);
    expect(parseSequence(serializeSequence(next))).toEqual(next);
    const a=new ScenePlan(original),b=new ScenePlan(next);
    const drawing=(value:unknown)=>JSON.stringify(value,(key,item)=>key==='speed'||key==='revision'?undefined:item);
    for(let frame=0;frame<60;frame++){
      expect(drawing(b.frame(frame))).toBe(drawing(a.frame(frame)));
      expect(b.audioGain(next.clips[2]!,frame)).toBe(a.audioGain(original.clips[2]!,frame));
    }
  });
  it('adopts mixed rates as global 1 and explicit overrides, including equal rational representations',()=>{
    const doc=document();if(doc.clips[1]!.content.kind==='video')doc.clips[1]!.content.rate=r(3);
    const next=register(doc);expect(next.speed!.globalRate).toEqual(r(1));
    expect(next.clips[0]!.speed).toMatchObject({override:r(2),span:r(60)});expect(next.clips[1]!.speed).toMatchObject({override:r(3),span:r(60)});
    expect(withoutMetadata(next)).toBe(sequenceContentBytes(doc));
    const nonReduced=document();if(nonReduced.clips[1]!.content.kind==='video')nonReduced.clips[1]!.content.rate={num:6,den:3};
    expect(register(nonReduced).speed!.globalRate).toEqual(r(2));expect(register(nonReduced).clips[1]!.speed).not.toHaveProperty('override');
    expect(nonReduced.clips[1]!.content).toHaveProperty('rate',{num:6,den:3});
  });
  it('retains a uniform transition and registers its actual overlap without moving either clip',()=>{
    const doc=document();doc.clips[1]!.startFrame=30;doc.transitions=[{id:'join',trackId:'v',outClipId:'a',inClipId:'b',kind:'crossfade',startFrame:30,durationFrames:10,audioCurve:'none'}];
    const next=register(doc);expect(next.clips[1]!.speed).toMatchObject({overlapBefore:r(20)});expect(next.clips[1]!.speed).not.toHaveProperty('runHead');
    expect(withoutMetadata(next)).toBe(sequenceContentBytes(doc));
  });
  it.each(['video-effect','video-key','audio-effect','audio-key'])('preserves the existing signed %s clock origin through registration and serialization',target=>{
    const doc=document(),clip=doc.clips[target.startsWith('video')?0:2]!;
    if(target.endsWith('effect'))clip.clock.offset=r(-7,3);
    else{
      clip.visual??={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[]};
      clip.visual.keyframeClock={offset:r(-7,3),rate:r(2,3),duration:r(100)};
    }
    validateSequenceDocument(doc);const before=structuredClone(doc),next=register(doc),registered=next.clips.find(c=>c.id===clip.id)!;
    expect(doc).toEqual(before);expect(withoutMetadata(next)).toBe(sequenceContentBytes(doc));
    expect(target.endsWith('effect')?registered.speed!.clock.offset:registered.speed!.keyframeClock!.offset).toEqual(r(-7,3));
    expect(parseSequence(serializeSequence(next))).toEqual(next);
  });
  it('derives main-audio media rate from its provider without rewriting its saved independent clock basis',()=>{
    const doc=document();doc.clips=doc.clips.slice(0,3);const registered=register(doc),next=structuredClone(registered);
    const ownClock=structuredClone(next.clips[2]!.speed);
    // Literal global 2 -> 1 projection. This is a metadata consistency test,
    // not an implementation of the still-unpublished speed editing command.
    next.speed!.globalRate=r(1);next.sequenceEndFrame=110;
    next.clips[0]!.durationFrames=60;next.clips[0]!.clock.rate=r(1,3);next.clips[0]!.visual!.keyframeClock!.rate=r(5,14);
    next.clips[1]!.startFrame=75;next.clips[1]!.durationFrames=40;next.clips[1]!.clock.rate=r(1,3);
    next.clips[2]!.durationFrames=60;next.clips[2]!.clock.rate=r(3,4);
    for(const clip of next.clips)if(clip.content.kind==='video'||clip.content.kind==='audio')clip.content.rate=r(1);
    validateSequenceDocument(next);expect(next.clips[2]!.speed).toEqual(ownClock);
    expect(next.clips[2]!.speed!.source).not.toHaveProperty('rate');
    expect(next.clips[2]!.clock.offset).toEqual(r(13,4));expect(next.clips[0]!.clock.offset).toEqual(r(7,3));
  });
  it('still rejects nonpositive saved clock slopes/durations and malformed signed origins',()=>{
    for(const index of [0,2])for(const field of ['slope','duration'] as const)for(const value of [r(0),r(-1)]){
      const next=register(document());next.clips[index]!.speed!.clock[field]=value;
      expect(()=>parseSequence(JSON.stringify(next))).toThrow();
    }
    for(const offset of [null,{num:-7,den:0},{num:-7.5,den:3},{num:-7,den:3,unit:'unknown'}]){
      const next=register(document());next.clips[0]!.speed!.clock.offset=offset as never;
      expect(()=>parseSequence(JSON.stringify(next))).toThrow();
    }
  });
  it.each([r(1),r(34,25),r(25,34),r(16)])('preserves independent clocks, loop/end behavior and a zero visible end at rate %j',rate=>{
    const doc=document();doc.sequenceEndFrame=0;doc.clips[3]!.anchor={kind:'timeline'};
    for(const c of doc.clips)if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=rate;
    if(doc.clips[2]!.content.kind==='audio'){doc.clips[2]!.content.loop=true;doc.clips[2]!.content.role='music';}
    const next=register(doc);expect(withoutMetadata(next)).toBe(sequenceContentBytes(doc));
    expect(next.speed!.sequenceEndBasis.offsetFrames).toBe(-65);expect(next.clips[1]!.startFrame+next.clips[1]!.durationFrames).toBe(65);
    expect(next.clips[2]!.content).toHaveProperty('loop',true);expect(next.clips[2]!.content).toHaveProperty('endBehavior','silence');
    validateSequenceDocument(parseSequence(serializeSequence(next)));
  });
  it('rejects an unrepresentable new stored span with its owner ID and preserves the session',()=>{
    const doc=document();doc.clips[0]!.durationFrames=31;if(doc.clips[0]!.content.kind==='video')doc.clips[0]!.content.rate=r(1000000000000001,1000000000000000);
    validateSequenceDocument(doc);const session=new SequenceSession('s',doc),before=session.document;
    let error:unknown;try{session.execute({sessionId:'s',expectedRevision:4,executionId:'overflow',command:command()});}catch(e){error=e;}
    expect(error).toBeInstanceOf(SequenceError);expect(error).toMatchObject({code:'TIME_OVERFLOW',targets:['a']});expect(session.document).toEqual(before);expect(session.canUndo).toBe(false);
  });
  it('does not infer main ownership from matching assets, track names or legacy provenance',()=>{
    const doc=document();doc.legacy={sourceFingerprint:'old',primaryAssetId:'asset',originalEndFrame:900};
    doc.tracks.push({id:'other',kind:'visual',name:'main',enabled:true});doc.clips.push({...structuredClone(doc.clips[1]!),id:'unselected',trackId:'other'});
    const next=register(doc);expect(next.clips.at(-1)!.speed).toBeUndefined();expect(next.legacy).toEqual(doc.legacy);
    expect(()=>applySequenceCommand(doc,{...command(),mainClipIds:[]} as unknown as SequenceCommand)).toThrow();
  });
  it.each([
    ['origin live start',(d:SequenceDocument)=>{d.clips[0]!.startFrame++;d.clips[2]!.startFrame++;d.clips[3]!.anchor={kind:'timeline'};}],
    ['gap live start',(d:SequenceDocument)=>{d.clips[1]!.startFrame++;}],
    ['sequence end',(d:SequenceDocument)=>{d.sequenceEndFrame++;}],
    ['source in',(d:SequenceDocument)=>{if(d.clips[1]!.content.kind==='video')d.clips[1]!.content.sourceIn=r(9);}],
    ['effect clock',(d:SequenceDocument)=>{d.clips[1]!.clock.rate=r(1);}],
    ['key clock',(d:SequenceDocument)=>{d.clips[0]!.visual!.keyframeClock!.rate=r(1);}],
    ['key clock removal',(d:SequenceDocument)=>{delete d.clips[0]!.visual!.keyframeClock;}],
    ['media rate',(d:SequenceDocument)=>{if(d.clips[1]!.content.kind==='video')d.clips[1]!.content.rate=r(1);}],
    ['audio clock',(d:SequenceDocument)=>{d.clips[2]!.clock.offset=r(0);}],
    ['fps',(d:SequenceDocument)=>{d.fps=r(60);d.clips[3]!.anchor={kind:'timeline'};}],
  ])('rejects %s changes that did not update saved metadata',(_name,mutate)=>{
    const next=register(document());mutate(next);expect(()=>validateSequenceDocument(next)).toThrow();
  });
  it('rejects detached, unknown or malformed metadata rather than ignoring it on reload',()=>{
    for(const mutate of [
      (d:SequenceDocument)=>{delete d.speed;},
      (d:SequenceDocument)=>{d.speed!.family='legacy-js-v1' as never;},
      (d:SequenceDocument)=>{d.speed!.originFrame=null as never;},
      (d:SequenceDocument)=>{(d.speed as unknown as Record<string,unknown>).origin=10;},
      (d:SequenceDocument)=>{d.clips[0]!.speed!.clock.slope={num:1,den:0};},
      (d:SequenceDocument)=>{if(d.clips[1]!.speed!.kind==='main')d.clips[1]!.speed!.order=0;},
      (d:SequenceDocument)=>{d.clips[3]!.speed=structuredClone(d.clips[0]!.speed);},
      (d:SequenceDocument)=>{if(d.clips[2]!.speed!.kind==='main-audio')d.clips[2]!.speed!.providerId='b';},
      (d:SequenceDocument)=>{d.clips[1]!.speed!.source.sourceEnd=r(99);},
    ]){const next=register(document());mutate(next);expect(()=>parseSequence(JSON.stringify(next))).toThrow();}
  });
  it('rejects invalid explicit roles, missing bindings, unknown request fields, and unsupported overlaps atomically',()=>{
    const doc=document(),before=serializeSequence(doc);
    for(const patch of [
      {mainClipIds:['a','a']},{mainClipIds:['b','a']},{mainClipIds:['sound']},{mainClipIds:['absent']},
      {mainAudioBindings:[]},{mainAudioBindings:[{audioClipId:'sound',providerId:'b'}]},
      {mainAudioBindings:[{audioClipId:'sound',providerId:'a'},{audioClipId:'sound',providerId:'a'}]},
      {groupId:''},{unknown:true},
    ])expect(()=>applySequenceCommand(doc,{...command(),...patch} as unknown as SequenceCommand)).toThrow();
    expect(serializeSequence(doc)).toBe(before);
    const overlap=document();overlap.clips[1]!.startFrame=21;overlap.transitions=[{id:'j',trackId:'v',outClipId:'a',inClipId:'b',kind:'wipeLeft',startFrame:21,durationFrames:19}];
    validateSequenceDocument(overlap);expect(()=>register(overlap)).toThrow();
    expect(()=>register(register(doc))).toThrow();
    const sparse=command();sparse.mainClipIds=new Array(2);expect(()=>applySequenceCommand(doc,sparse)).toThrow();
    const extra=command();Object.assign(extra.mainClipIds,{other:true});expect(()=>applySequenceCommand(doc,extra)).toThrow();
  });
  it('keeps registration, replay, stale rejection, rollback and Undo/Redo in the existing session',()=>{
    const doc=document(),session=new SequenceSession('session',doc),request={sessionId:'session',expectedRevision:4,executionId:'register',command:command() as unknown as SequenceCommand};
    const applied=session.execute(request);expect(applied.changed).toBe(true);expect(session.canUndo).toBe(true);
    expect(session.execute(request)).toMatchObject({replayed:true,appliedRevision:5});
    expect(()=>session.execute({...request,executionId:'stale'})).toThrow(/更新/);
    expect(()=>session.execute({...request,command:{...command(),groupId:'different'} as unknown as SequenceCommand})).toThrow(/実行ID/);
    session.execute({sessionId:'session',expectedRevision:5,executionId:'undo',command:{type:'undo'}});
    expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(doc));expect(session.canUndo).toBe(false);
    session.execute({sessionId:'session',expectedRevision:6,executionId:'redo',command:{type:'redo'}});expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(applied.document));
    const failed=new SequenceSession('fail',doc);
    expect(()=>failed.execute({sessionId:'fail',expectedRevision:4,executionId:'batch',command:{type:'batch',commands:[command() as unknown as SequenceCommand,{type:'update-clip',clipId:'missing',patch:{name:'bad'}}]}})).toThrow();
    expect(failed.document).toEqual(doc);expect(failed.canUndo).toBe(false);
  });
  it('stores the registered authoritative document, reopens, replays a lost save and persists Undo without changing legacy files',()=>{
    const dir=mkdtempSync(join(tmpdir(),'native-speed-registration-'));dirs.push(dir);writeFileSync(join(dir,'legacy.ts'),'old source remains');const store=new SequenceStore(dir),doc=document();
    store.save({expectedSavedRevision:null,executionId:'initial',document:doc});
    const session=new SequenceSession('s',doc),registered=session.execute({sessionId:'s',expectedRevision:4,executionId:'register',command:command() as unknown as SequenceCommand}).document;
    const save={expectedSavedRevision:4,executionId:'saved-registration',document:registered};store.save(save);
    const reopened=new SequenceStore(dir);expect(reopened.load()!.document).toEqual(registered);expect(reopened.save(save).replayed).toBe(true);
    const disk=readFileSync(store.file,'utf8'),bad=structuredClone(registered);bad.clips[1]!.startFrame++;
    expect(()=>reopened.save({expectedSavedRevision:5,executionId:'bad',document:bad})).toThrow();expect(readFileSync(store.file,'utf8')).toBe(disk);
    const undo=session.execute({sessionId:'s',expectedRevision:5,executionId:'undo',command:{type:'undo'}}).document;
    reopened.save({expectedSavedRevision:5,executionId:'save-undo',document:undo});expect(sequenceContentBytes(reopened.load()!.document)).toBe(sequenceContentBytes(doc));
    expect(readFileSync(join(dir,'legacy.ts'),'utf8')).toBe('old source remains');
  });
});
