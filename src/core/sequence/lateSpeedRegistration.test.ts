import {expect,it} from 'vitest';
import {applySequenceCommand} from './commands';
import {type SequenceDocument,effectFrameAt,sourceTimeAt} from './model';
import {rational as r} from './time';
import {parseSequence,serializeSequence,validateSequenceDocument} from './validate';
import {captionLedgers,refreshCaptionBaselines,materializeSpeedCaptions} from './speedCaptionLedger';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SequenceStore} from '../../server/sequence/store';
function fixture():SequenceDocument{return {schemaVersion:2,id:'cut-test',name:'cut',revision:0,fps:r(30),resolution:{width:320,height:180},sequenceEndFrame:120,background:'#000',assets:[{id:'media',kind:'media',file:'media/a.mp4',name:'a',fingerprint:'a',streams:[{kind:'video',index:0,codec:'h264',duration:r(10),width:320,height:180,frameRate:r(30)},{kind:'audio',index:1,codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],tracks:[{id:'v',kind:'visual',name:'v',enabled:true},{id:'a',kind:'audio',name:'a',enabled:true},{id:'t',kind:'visual',name:'t',enabled:true}],transcripts:[],transitions:[],ducking:{enabled:false,strength:'mid'},clips:[
{id:'v1',trackId:'v',name:'映像',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(7),rate:r(2),duration:r(250)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(2)}},
{id:'a1',trackId:'a',name:'原音',startFrame:0,durationFrames:120,linkGroupId:'av',clock:{offset:r(3),rate:r(3),duration:r(400)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(0),rate:r(2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
{id:'t1',trackId:'t',name:'字幕',startFrame:0,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'telop',data:{text:'元の本文'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'a1',sourceStart:r(0),sourceEnd:r(8)}}]};}
const sample=(d:SequenceDocument,at:number)=>d.clips.filter(c=>c.startFrame<=at&&at<c.startFrame+c.durationFrames).map(c=>({kind:c.content.kind,track:c.trackId,clock:effectFrameAt(c,at),source:c.content.kind==='video'||c.content.kind==='audio'?sourceTimeAt(c,at,d.fps):null,text:c.content.kind==='telop'?c.content.data.text:null})).sort((a,b)=>a.track.localeCompare(b.track));


function registeredAfterCut(){
 let d=applySequenceCommand(fixture(),{type:'ripple-delete',startFrame:30,endFrame:60});
 return applySequenceCommand(d,{type:'register-native-speed',groupId:'speed',mainClipIds:d.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:d.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:d.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))});
}
function same(a:SequenceDocument,b:SequenceDocument){expect(a.sequenceEndFrame).toBe(b.sequenceEndFrame);for(let i=0;i<a.sequenceEndFrame;i++)expect(sample(a,i)).toEqual(sample(b,i));}
it('upgrades already cut source caption peers without changing their rendered fields or archive',()=>{
 const before=registeredAfterCut(),bytes=serializeSequence(before),next=applySequenceCommand(before,{type:'upgrade-native-speed'});
 expect(next.clips.filter(c=>c.content.kind==='telop')).toEqual(before.clips.filter(c=>c.content.kind==='telop'));expect(next.cutArchive).toEqual(before.cutArchive);expect(captionLedgers(next)).toHaveLength(2);
 same(next,before);expect(serializeSequence(before)).toBe(bytes);validateSequenceDocument(next);
});
it('allows ordinary cut after late registration and restores the newly cut band after a real save/load roundtrip',()=>{
 const before=registeredAfterCut(),next=applySequenceCommand(before,{type:'ripple-delete',startFrame:20,endFrame:30});
 expect(next.sequenceEndFrame).toBe(80);expect(next.cutArchive!.entries).toHaveLength(2);expect(next.cutArchive!.entries[0]!.clips).toEqual(before.cutArchive!.entries[0]!.clips);
 const dir=mkdtempSync(join(tmpdir(),'late-register-cut-'));try{
  const store=new SequenceStore(dir),saved=store.save({document:next,expectedSavedRevision:null,executionId:'cut'}),bytes=readFileSync(store.file);
  const loaded=new SequenceStore(dir).load()!.document;expect(loaded).toEqual(saved.document);
  const restored=applySequenceCommand(loaded,{type:'restore-cut',entryId:loaded.cutArchive!.entries[1]!.id});same(restored,before);expect(readFileSync(store.file)).toEqual(bytes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it.each([1,1.5,3,4])('changes speed to %s after late registration and permits another cut without losing text/source clocks',speed=>{
 const registered=registeredAfterCut(),before=applySequenceCommand(registered,{type:'set-native-global-speed',rate:r(speed*2,2)});
 const next=applySequenceCommand(before,{type:'ripple-delete',startFrame:5,endFrame:10});
 for(let f=0;f<next.sequenceEndFrame;f++)expect(sample(next,f)).toEqual(sample(before,f<5?f:f+5));
 const last=next.cutArchive!.entries.at(-1)!;
 const restored=applySequenceCommand(parseSequence(serializeSequence(next)),{type:'restore-cut',entryId:last.id});same(restored,before);
 expect(next.cutArchive!.entries[0]!.clips).toEqual(registered.cutArchive!.entries[0]!.clips);
});
it('retains separate ledger ownership for same-source repeated occurrences',()=>{
 const original=fixture();original.sequenceEndFrame=240;original.clips.push(...structuredClone(original.clips).map(c=>({...c,id:c.id+'-again',startFrame:120,linkGroupId:c.linkGroupId?'again':undefined,...(c.anchor?.kind==='source'?{anchor:{...c.anchor,clipOccurrenceId:'a1-again'}}:{})})));
 let d=applySequenceCommand(original,{type:'ripple-delete',startFrame:30,endFrame:60});
 d=applySequenceCommand(d,{type:'register-native-speed',groupId:'speed',mainClipIds:d.clips.filter(c=>c.content.kind==='video').map(c=>c.id),mainAudioBindings:d.clips.filter(c=>c.content.kind==='audio').map(c=>({audioClipId:c.id,providerId:d.clips.find(v=>v.content.kind==='video'&&v.startFrame===c.startFrame)!.id}))});
 const before=structuredClone(d),next=applySequenceCommand(d,{type:'ripple-delete',startFrame:20,endFrame:30});
 expect(captionLedgers(next)).toHaveLength(3);for(let f=0;f<next.sequenceEndFrame;f++)expect(sample(next,f)).toEqual(sample(before,f<20?f:f+10));
});
it.each(['unregistered','link-id','real-id','wrong-part-group','effect-duration','effect-phase','asset','stream'] as const)('does not permit %s as a registered continuation peer',kind=>{
 const d=applySequenceCommand(registeredAfterCut(),{type:'upgrade-native-speed'}),ledgers=captionLedgers(d),first=ledgers.find(l=>l.captionId==='t1')!,other=ledgers.find(l=>l!==first)!,part=other.parts[0]!,peer=d.clips.find(c=>c.id===part.reservedRenderId)!;
 if(kind==='unregistered'){const carrier=d.clips.find(c=>c.speed?.captions?.includes(other))!;carrier.speed!.captions=carrier.speed!.captions!.filter(l=>l!==other);}
 if(kind==='link-id')peer.linkGroupId='t1';
 if(kind==='real-id'){d.clips.push({...structuredClone(peer),id:'t1',startFrame:70});}
 if(kind==='wrong-part-group')part.continuationGroupId='unrelated';
 if(kind==='effect-duration')other.clock.duration=r(999);
 if(kind==='effect-phase')other.clock.offset=r(999);
 if(kind==='asset'||kind==='stream'){
  const provider=d.clips.find(c=>c.id===part.providerId)!;if(provider.content.kind!=='audio')throw new Error('fixture');
  if(kind==='asset')provider.content.assetId='another';else provider.content.streamIndex=0;
 }
 // Recompute legitimate displays where relevant; wrong affine ownership still rejects.
 if(kind==='effect-duration'||kind==='effect-phase'){
  const rendered=new Set(ledgers.flatMap(l=>l.parts.map(p=>p.reservedRenderId)));d.clips=d.clips.filter(c=>!rendered.has(c.id)).concat(materializeSpeedCaptions(d));
 }
 refreshCaptionBaselines(d);
 expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>parseSequence(JSON.stringify(d))).toThrow();
});
it('preserves independently edited text/style and occurrence ownership of both surviving siblings',()=>{
 let d=registeredAfterCut();const right=d.clips.find(c=>c.content.kind==='telop'&&c.startFrame===30)!;
 d=applySequenceCommand(d,{type:'update-clip',clipId:right.id,patch:{name:'別の本文',content:{kind:'telop',data:{text:'後で修正した本文',style:'emphasis',scale:1.2}}}});
 const before=structuredClone(d),next=applySequenceCommand(d,{type:'ripple-delete',startFrame:10,endFrame:20});
 expect(next.clips.find(c=>c.id===right.id)?.content).toEqual(right.content.kind==='telop'?before.clips.find(c=>c.id===right.id)!.content:null);
 for(let f=0;f<next.sequenceEndFrame;f++)expect(sample(next,f)).toEqual(sample(before,f<10?f:f+10));
});
