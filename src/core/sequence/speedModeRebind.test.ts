import {describe,it,expect} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applySequenceCommand,type SequenceCommand} from './commands';
import {rational as r} from './time';
import {type SequenceDocument,DEFAULT_TEXT_APPEARANCE} from './model';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {parseSequence,serializeSequence,sequenceContentBytes,validateSequenceDocument} from './validate';
import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
const bytes=(d:SequenceDocument)=>sequenceContentBytes({...d,revision:0});
function strip(d:SequenceDocument){d=structuredClone(d);delete d.speed;for(const c of d.clips)delete c.speed;return d;}
// Registered and ordinary cuts preserve different non-executable speed archives.
// Compare current presentation here; cutArchive.test validates the archived clocks.
const visibleBytes=(d:SequenceDocument)=>{d=strip(d);delete d.cutArchive;return bytes(d);};
function fixture(audio=false):SequenceDocument {
 const d:SequenceDocument={schemaVersion:2,id:'mode-switch',name:'mode-switch',revision:0,fps:r(1),resolution:{width:640,height:360},sequenceEndFrame:60,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],assets:[{id:'asset',kind:'media',file:'media/test.mp4',name:'test',fingerprint:'mode',streams:[{index:0,kind:'video',codec:'h264',duration:r(1000),width:640,height:360,frameRate:r(1)},{index:1,kind:'audio',codec:'aac',duration:r(1000),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],clips:[],transitions:[]};
 for(let i=0;i<3;i++){
  d.clips.push({id:`v${i}`,trackId:'v',name:`v${i}`,startFrame:i*20,durationFrames:20,clock:{offset:r(i-3),rate:r(2),duration:r(400)},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(i-7),rate:r(3),duration:r(500)}},...(audio?{linkGroupId:`link${i}`}:{ }),content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(i*100),rate:r(1)}});
  if(audio)d.clips.push({id:`a${i}`,trackId:'a',name:`a${i}`,startFrame:i*20,durationFrames:20,linkGroupId:`link${i}`,clock:{offset:r(i-5),rate:r(5),duration:r(600)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(i*100),rate:r(1),role:'speech',loop:false,settings:{gainDb:-3,muted:false,fadeInFrames:5,fadeOutFrames:7}}});
 }
 if(audio)d.clips.push({id:'caption',trackId:'t',name:'caption',startFrame:20,durationFrames:20,clock:{offset:r(-2),rate:r(1),duration:r(30)},content:{kind:'telop',data:{text:'元字幕の保持'},appearance:{...DEFAULT_TEXT_APPEARANCE}},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'a1',sourceStart:r(100),sourceEnd:r(120)}});
 return applySequenceCommand(applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['v0','v1','v2'],mainAudioBindings:audio?[0,1,2].map(i=>({audioClipId:`a${i}`,providerId:`v${i}`})):[]}),{type:'upgrade-native-speed-operations'});
}
const controls=[r(2),r(3),r(34,25)].flatMap(global=>[r(1),global].flatMap(override=>['v0','v1','v2'].flatMap(owner=>['delete-linked','delete-one','ripple'].map(kind=>({global,override,owner,kind})))));
describe('ordinary structure after removal of the final different rate',()=>{
 it.each(controls)('keeps all canonical fields for %j',({global,override,owner,kind})=>{
  let d=applySequenceCommand(fixture(),{type:'set-native-global-speed',rate:global});d=applySequenceCommand(d,{type:'set-native-main-speed',clipId:owner,rate:override});d=parseSequence(serializeSequence(d));const selected=d.clips.find(c=>c.id===owner)!;
  const command:SequenceCommand=kind==='ripple'?{type:'ripple-delete',startFrame:selected.startFrame,endFrame:selected.startFrame+selected.durationFrames}:{type:'delete',clipIds:[owner],linked:kind==='delete-linked'};
  const original=bytes(d),expected=applySequenceCommand(strip(d),command),next=applySequenceCommand(d,command);expect(visibleBytes(next)).toBe(visibleBytes(expected));expect(bytes(d)).toBe(original);expect(next.speed?.globalRate).toEqual(global);expect(next.clips.filter(c=>c.speed?.kind==='main').every(c=>c.speed?.kind==='main'&&!Object.hasOwn(c.speed,'override'))).toBe(true);
  const before=bytes(next),other=applySequenceCommand(next,{type:'set-native-global-speed',rate:r(1)});expect(bytes(applySequenceCommand(other,{type:'set-native-global-speed',rate:global}))).toBe(before);expect(parseSequence(serializeSequence(next))).toEqual(next);
 });
 it('retains absolute phase when the document mode does not change',()=>{
  const d=applySequenceCommand(fixture(),{type:'set-native-global-speed',rate:r(3)}),next=applySequenceCommand(d,{type:'delete',clipIds:['v0'],linked:true});
  expect(next.clips.map(c=>[c.id,c.startFrame,c.durationFrames])).toEqual([['v1',7,6],['v2',13,7]]);expect(next.clips.map(c=>c.speed?.kind==='main'?c.speed.structuralPlacement?.phase:null)).toEqual([r(20),r(40)]);
 });
 it('preserves source/independent clocks, latent caption order and one Undo across Session and Store',()=>{
  let d=fixture(true);d=applySequenceCommand(d,{type:'split',clipIds:['v1'],frame:21,linked:true});
  // Do not zero a media fragment: use a late override on v2, while v1's small
  // fragment retains an explicit rate1. Then deleting both non-global overrides
  // exercises the source ledger carried by the surviving long v1 fragment.
  const small=d.clips.find(c=>c.id==='v1')!;d=applySequenceCommand(d,{type:'set-native-main-speed',clipId:small.id,rate:r(1)});
  d=applySequenceCommand(d,{type:'set-native-main-speed',clipId:'v2',rate:r(1)});d=applySequenceCommand(d,{type:'set-native-global-speed',rate:r(3)});
  const command:SequenceCommand={type:'delete',clipIds:['v1','v2'],linked:true};const expected=applySequenceCommand(strip(d),command),before=bytes(d),session=new SequenceSession('mode',d),request={sessionId:'mode',expectedRevision:d.revision,executionId:'delete',command};
  const result=session.execute(request);expect(visibleBytes(result.document)).toBe(visibleBytes(expected));expect(session.execute(request).replayed).toBe(true);expect(bytes(d)).toBe(before);
  const directory=mkdtempSync(join(tmpdir(),'native-speed-mode-'));try{const store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'save',document:result.document});const loaded=new SequenceStore(directory).load()!.document;expect(loaded).toEqual(result.document);validateSequenceDocument(loaded);
   expect(bytes(applySequenceCommand(applySequenceCommand(loaded,{type:'set-native-global-speed',rate:r(1)}),{type:'set-native-global-speed',rate:r(3)}))).toBe(bytes(loaded));
  }finally{rmSync(directory,{recursive:true,force:true});}
  const undo=session.execute({sessionId:'mode',expectedRevision:result.document.revision,executionId:'undo',command:{type:'undo'}}).document;expect(bytes(undo)).toBe(before);const redo=session.execute({sessionId:'mode',expectedRevision:undo.revision,executionId:'redo',command:{type:'redo'}}).document;expect(bytes(redo)).toBe(bytes(result.document));
 });
});
