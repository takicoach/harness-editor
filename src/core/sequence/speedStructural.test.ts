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

const visible=(d:SequenceDocument)=>{const x=structuredClone(d);delete x.speed;delete x.cutArchive;for(const c of x.clips)delete c.speed;return sequenceContentBytes(x);};
describe('registered structural operations',()=>{
 it.each([
  {type:'delete',clipIds:['video'],linked:true},
  {type:'move',clipIds:['video'],deltaFrames:1,linked:true},
  {type:'ripple-delete',startFrame:1,endFrame:2},
  {type:'reorder-ranges',ranges:[{startFrame:2,endFrame:4},{startFrame:0,endFrame:2}]},
 ] as const)('matches ordinary $type including source captions',command=>{
   const actual=applySequenceCommand(registered(),command as import('./commands').SequenceCommand);
   expect(visible(actual)).toBe(visible(applySequenceCommand(fixture(),command as import('./commands').SequenceCommand)));validateSequenceDocument(actual);
 });
});

import type {SequenceCommand} from './commands';
import {parseSequence,serializeSequence} from './validate';
import {captionLedgers,materializeSpeedCaptions,captionInputDigest,captionProjectionKey,speedProjectionForDocument,refreshCaptionBaselines,captionPartWindow} from './speedCaptionLedger';
import {SequenceSession} from './session';import {SequenceStore} from '../../server/sequence/store';
import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const strip=(doc:SequenceDocument)=>{const d=structuredClone(doc);delete d.speed;for(const c of d.clips)delete c.speed;return d;};
function same(doc:SequenceDocument,command:SequenceCommand,unlink:string[]=[]){const expected=applySequenceCommand(strip(doc),command);for(const c of expected.clips)if(c.linkGroupId&&unlink.includes(c.linkGroupId))delete c.linkGroupId;const actual=applySequenceCommand(doc,command);expect(visible(actual)).toBe(visible(expected));validateSequenceDocument(actual);expect(parseSequence(serializeSequence(actual))).toEqual(actual);return actual;}
describe('structural owner rebinding',()=>{
 it('promotes a surviving root, moves its right-hand intent to frame0, and keeps repeated cut/reorder clocks',()=>{
  const original=fixture();original.clips[0]!.durationFrames=8;original.clips[1]!.durationFrames=8;original.sequenceEndFrame=8;
  let d=applySequenceCommand(original,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  d=applySequenceCommand(d,{type:'split',clipIds:['video'],frame:2});const right=d.clips.find(c=>c.content.kind==='video'&&c.startFrame===2)!;
  d=same(d,{type:'delete',clipIds:['video'],linked:true});expect(d.clips.find(c=>c.id===right.id)!.speed).toMatchObject({evaluationOwnerId:right.id,projectionOffset:r(4),evaluationSourceStart:r(0)});
  d=same(d,{type:'move',clipIds:[right.id],deltaFrames:-2,linked:true});expect(d.clips.find(c=>c.id===right.id)!.content).toHaveProperty('sourceIn',r(4));expect(speedProjectionForDocument(d).rootStart(right.id)).toBe(-2);
  d=same(d,{type:'ripple-delete',startFrame:2,endFrame:3});d=same(d,{type:'reorder-ranges',ranges:[{startFrame:2,endFrame:5},{startFrame:0,endFrame:2}]});
  const target=d.clips.find(c=>c.content.kind==='video'&&c.durationFrames>1)!;d=same(d,{type:'trim',clipId:target.id,edge:'end',frame:target.startFrame+target.durationFrames-1,linked:true});
  const another=d.clips.find(c=>c.content.kind==='video'&&c.durationFrames>1);if(another)d=same(d,{type:'split',clipIds:[another.id],frame:another.startFrame+1});
  expect(d.clips.filter(c=>c.speed?.kind==='main').sort((a,b)=>a.startFrame-b.startFrame).map(c=>c.speed?.kind==='main'?c.speed.order:null)).toEqual(d.clips.filter(c=>c.speed?.kind==='main').map((_,i)=>i));
 });
 it('keeps empty main end explicit while surviving independent audio and source captions remain editable',()=>{
  let d=same(registered(),{type:'delete',clipIds:['video'],linked:false},['linked']);expect(d.speed!.sequenceEndBasis).toEqual({kind:'empty-fixed',offsetFrames:0,endFrame:4});expect(d.clips.find(c=>c.id==='audio')!.speed?.kind).toBe('independent-audio');
  expect(captionLedgers(d)).toHaveLength(1);expect(d.clips.find(c=>c.id==='audio')!.speed!.captionBaselines).toHaveLength(1);
  d=same(d,{type:'move',clipIds:['audio'],deltaFrames:1,linked:false});d=same(d,{type:'trim',clipId:'audio',edge:'start',frame:2,linked:false});d=same(d,{type:'split',clipIds:['audio'],frame:3,linked:false});
  d=same(d,{type:'ripple-delete',startFrame:0,endFrame:d.sequenceEndFrame});expect(d.clips).toEqual([]);expect(d.sequenceEndFrame).toBe(0);expect(d.speed!.sequenceEndBasis).toEqual({kind:'empty-fixed',offsetFrames:0,endFrame:0});
 });
 it.each(['video','audio'])('separates only the affected link on %s-only move and leaves source clocks and unrelated links intact',clipId=>{
  const d=registered();const fixed={...structuredClone(d.clips[2]!),id:'unrelated',startFrame:20,linkGroupId:'unrelated-link',anchor:{kind:'timeline' as const}};d.clips.push(fixed);d.sequenceEndFrame=22;d.speed!.sequenceEndBasis.offsetFrames=18;
  const next=same(d,{type:'move',clipIds:[clipId],deltaFrames:1,linked:false},['linked']);expect(next.clips.find(c=>c.id==='unrelated')!.linkGroupId).toBe('unrelated-link');expect(next.clips.find(c=>c.id==='audio')!.speed?.kind).toBe('independent-audio');
  const noOp=applySequenceCommand(d,{type:'move',clipIds:[clipId],deltaFrames:0,linked:false});expect(noOp).toBe(d);expect(noOp.speed!.version).toBe(1);
 });
 it('unlinks atomically, does not unlink twice, and preserves independent audio when main metadata rate changes literally',()=>{
  const d=same(registered(),{type:'unlink',clipIds:['video']},['linked']);expect(applySequenceCommand(d,{type:'unlink',clipIds:['video']})).toBe(d);
  const slow=structuredClone(d);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=8;const v=slow.clips.find(c=>c.id==='video')!;v.durationFrames=8;if(v.content.kind!=='video')throw Error('fixture');v.content.rate=r(1);v.clock.rate=r(1,2);
  const oldAudio=JSON.stringify(d.clips.find(c=>c.id==='audio')),oldCaption=JSON.stringify(d.clips.find(c=>c.id==='caption'));validateSequenceDocument(slow);expect(JSON.stringify(slow.clips.find(c=>c.id==='audio'))).toBe(oldAudio);expect(JSON.stringify(slow.clips.find(c=>c.id==='caption'))).toBe(oldCaption);
 });
 it('keeps replay, failed batch, Undo/Redo and Store atomic across empty-main topology',()=>{
  const before=registered(),session=new SequenceSession('structure',before),request={sessionId:'structure',expectedRevision:before.revision,executionId:'delete',command:{type:'delete' as const,clipIds:['video'],linked:false}};
  const first=session.execute(request);expect(session.execute(request).replayed).toBe(true);const directory=mkdtempSync(join(tmpdir(),'native-structure-'));
  try{const store=new SequenceStore(directory);store.save({expectedSavedRevision:null,executionId:'one',document:first.document});expect(store.load()!.document).toEqual(first.document);const undo=session.execute({sessionId:'structure',expectedRevision:first.document.revision,executionId:'undo',command:{type:'undo'}}).document;expect(sequenceContentBytes(undo)).toBe(sequenceContentBytes(before));const redo=session.execute({sessionId:'structure',expectedRevision:undo.revision,executionId:'redo',command:{type:'redo'}}).document;expect(sequenceContentBytes(redo)).toBe(sequenceContentBytes(first.document));}finally{rmSync(directory,{recursive:true,force:true});}
  const other=new SequenceSession('bad',before);expect(()=>other.execute({sessionId:'bad',expectedRevision:before.revision,executionId:'bad',command:{type:'batch',commands:[request.command,{type:'move',clipIds:['missing'],deltaFrames:1}]}})).toThrow();expect(other.document).toEqual(before);expect(other.canUndo).toBe(false);
 });
});

describe('structural projection invariants',()=>{
 it('keeps original absolute phase when a split root disappears, and restores source intent and clocks at2 ->1 ->2',()=>{
  const doc=fixture();doc.clips=[3,601].map((length,i)=>({...structuredClone(doc.clips[0]!),id:`main${i}`,linkGroupId:undefined,startFrame:i?3:0,durationFrames:length,clock:{offset:r(0),rate:r(1),duration:r(1000)},content:{kind:'video' as const,assetId:'asset',streamIndex:0,sourceIn:r(i?10:0),rate:r(1)}}));doc.sequenceEndFrame=604;for(const stream of doc.assets[0]!.streams!)stream.duration=r(2000);
  let d=applySequenceCommand(doc,{type:'register-native-speed',groupId:'phase',mainClipIds:['main0','main1'],mainAudioBindings:[]});d.speed!.globalRate=r(2);d.sequenceEndFrame=302;d.clips[0]!.durationFrames=2;d.clips[1]!.startFrame=2;d.clips[1]!.durationFrames=300;for(const c of d.clips){if(c.content.kind!=='video')throw Error();c.content.rate=r(2);c.clock.rate=r(2);}validateSequenceDocument(d);
  d=applySequenceCommand(d,{type:'split',clipIds:['main1'],frame:3});d=same(d,{type:'delete',clipIds:['main1']});const child=d.clips.find(c=>c.id!=='main0')!;
  expect(child).toMatchObject({startFrame:3,durationFrames:299,content:{sourceIn:r(12)},clock:{offset:r(2)},speed:{source:{sourceStart:r(13),sourceEnd:r(611)},structuralPlacement:{phase:r(3),anchorStart:r(3),anchorEnd:r(601),gapFrames:1}}});
  const slow=structuredClone(d);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=602;slow.clips[0]!.durationFrames=3;const right=slow.clips[1]!;right.startFrame=4;right.durationFrames=598;for(const c of slow.clips){if(c.content.kind!=='video')throw Error();c.content.rate=r(1);c.clock.rate=r(1);}if(right.content.kind!=='video')throw Error();right.content.sourceIn=r(13);right.clock.offset=r(3);
  validateSequenceDocument(slow);expect(slow.clips.map(c=>c.speed)).toEqual(d.clips.map(c=>c.speed));expect(speedProjectionForDocument(slow).rootStart(right.id)).toBe(1);
  const back=structuredClone(slow);back.speed!.globalRate=r(2);back.sequenceEndFrame=302;back.clips[0]!.durationFrames=2;back.clips[1]!.startFrame=3;back.clips[1]!.durationFrames=299;for(const c of back.clips){if(c.content.kind!=='video')throw Error();c.content.rate=r(2);c.clock.rate=r(2);}if(back.clips[1]!.content.kind!=='video')throw Error();back.clips[1]!.content.sourceIn=r(12);back.clips[1]!.clock.offset=r(2);validateSequenceDocument(back);expect(back).toEqual(d);
 });
 it('keeps the original overlap cap after split, topology move and end trim without changing later transition or audio clocks',()=>{
  const d=fixture();d.clips=d.clips.slice(0,2);d.sequenceEndFrame=180;for(const c of d.clips){c.durationFrames=100;if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);}for(const a of d.assets[0]!.streams!)a.duration=r(1000);
  d.clips.push({...structuredClone(d.clips[0]!),id:'second',startFrame:80,linkGroupId:'second-link'},{...structuredClone(d.clips[1]!),id:'second-audio',trackId:'a2',startFrame:80,linkGroupId:'second-link'});d.tracks.push({id:'a2',kind:'audio',name:'a2',enabled:true});d.transitions=[{id:'cross',kind:'crossfade',trackId:'v',outClipId:'video',inClipId:'second',startFrame:80,durationFrames:20}];
  let reg=applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video','second'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'},{audioClipId:'second-audio',providerId:'second'}]});reg=same(reg,{type:'split',clipIds:['video'],frame:70});
  reg=same(reg,{type:'ripple-delete',startFrame:0,endFrame:5});expect(reg.transitions[0]).toMatchObject({startFrame:75,durationFrames:20});
  reg=same(reg,{type:'trim',clipId:'second',edge:'end',frame:145,linked:true});expect(reg.transitions[0]).toMatchObject({startFrame:75,durationFrames:20});expect(reg.sequenceEndFrame).toBe(175);expect(reg.clips.find(c=>c.id==='second')!.speed).toMatchObject({projectionExtent:r(100),span:r(70)});
  same(reg,{type:'reorder-ranges',ranges:[{startFrame:0,endFrame:175}]});
 });
 it('preserves a latent part after visible sibling/provider deletion and re-materializes it at a literal slower rate',()=>{
  const d=registered();d.clips[2]!.startFrame=2;d.clips[2]!.durationFrames=1;d.clips[2]!.clock.duration=r(1);if(d.clips[2]!.anchor?.kind!=='source')throw Error();d.clips[2]!.anchor.sourceStart=r(4);d.clips[2]!.anchor.sourceEnd=r(6);
  const upgraded=applySequenceCommand(d,{type:'upgrade-native-speed'});const ledger=captionLedgers(upgraded)[0]!;ledger.parts[0]!.intentStart=r(3);ledger.parts[0]!.intentEnd=r(5);refreshCaptionBaselines(upgraded);validateSequenceDocument(upgraded);
  const split=applySequenceCommand(upgraded,{type:'split',clipIds:['video'],frame:2}),before=captionLedgers(split)[0]!.parts;
  expect(before.map(p=>captionPartWindow(split,p))).toEqual([{startFrame:2,endFrame:2},{startFrame:2,endFrame:3}]);
  const right=split.clips.find(c=>c.content.kind==='video'&&c.startFrame===2)!;let result=same(split,{type:'delete',clipIds:[right.id],linked:true});
  const retained=captionLedgers(result)[0]!.parts;expect(retained).toEqual([before[0]]);expect(result.clips.every(c=>c.durationFrames>0)).toBe(true);expect(result.clips.some(c=>c.id===before[0]!.reservedRenderId)).toBe(false);
  const detached=result.clips.find(c=>c.content.kind==='telop')!;expect(detached.anchor).toEqual({kind:'timeline'});result=same(result,{type:'delete',clipIds:[detached.id]});
  const slow=structuredClone(result);slow.speed!.globalRate=r(1);slow.sequenceEndFrame=6;for(const c of slow.clips)if(c.speed){c.durationFrames=4;c.clock.rate=r(c.clock.rate.num,c.clock.rate.den*2);if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(1);}slow.clips.push(...materializeSpeedCaptions(slow));validateSequenceDocument(slow);expect(slow.clips.find(c=>c.id===before[0]!.reservedRenderId)).toMatchObject({startFrame:3,durationFrames:1});
  const corrupt=structuredClone(result);corrupt.speed!.globalRate=r(3);corrupt.sequenceEndFrame=3;for(const c of corrupt.clips)if(c.speed){c.durationFrames=1;if(c.content.kind==='video'||c.content.kind==='audio')c.content.rate=r(3);c.clock.rate=r(c.clock.rate.num*3,c.clock.rate.den*2);}expect(captionPartWindow(corrupt,captionLedgers(corrupt)[0]!.parts[0]!)).toEqual({startFrame:1,endFrame:1});expect(()=>validateSequenceDocument(corrupt)).toThrow(/字幕/);
 });
 it.each(['end','empty-offset','placement','rate','source','slope','mode','unknown'] as const)('rejects independently rebound audio %s corruption on validate and Store serialization',kind=>{
  const d=applySequenceCommand(registered(),{type:'delete',clipIds:['video'],linked:false});const s=d.clips.find(c=>c.id==='audio')!.speed!;if(s.kind!=='independent-audio')throw Error();
  if(kind==='end')d.sequenceEndFrame++;if(kind==='empty-offset')d.speed!.sequenceEndBasis.offsetFrames=1;if(kind==='placement')s.placement.startFrame++;if(kind==='rate')s.mediaRate=r(0);if(kind==='source')s.evaluationSourceStart=r(1);if(kind==='slope')s.clock.slope=r(0);if(kind==='mode')(s.projection as {mode:string}).mode='other';if(kind==='unknown')Object.assign(s,{evaluationOwnerId:'audio'});
  expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>serializeSequence(d)).toThrow();
 });
 it.each(['phase','gap','owner','anchor','unknown'] as const)('rejects structural root %s corruption and rehashed historical inputs',kind=>{
  const original=applySequenceCommand(registered(),{type:'move',clipIds:['video'],deltaFrames:2,linked:true});
  const mutate=(s:NonNullable<SequenceDocument['clips'][number]['speed']>)=>{if(s.kind!=='main'||!s.structuralPlacement)throw Error();if(kind==='phase')s.structuralPlacement.phase={num:1,den:0};if(kind==='gap')s.structuralPlacement.gapFrames++;if(kind==='owner')s.evaluationOwnerId='audio';if(kind==='anchor')s.structuralPlacement.anchorStart=s.structuralPlacement.anchorEnd;if(kind==='unknown')Object.assign(s.structuralPlacement,{shift:1});};
  const current=structuredClone(original);mutate(current.clips.find(c=>c.id==='video')!.speed!);expect(()=>validateSequenceDocument(current)).toThrow();
  const historical=structuredClone(original),table=historical.clips.find(c=>c.speed?.captionBaselines)!.speed!.captionBaselines!,entry=table[0]!;mutate(entry.input.providers.find(p=>p.id==='video')!.basis);entry.key=captionInputDigest(entry.input);for(const l of captionLedgers(historical)){l.baselineProjection.snapshotKey=entry.key;l.baselineProjection.inputKey=captionProjectionKey(historical,l,entry.key);}expect(()=>validateSequenceDocument(historical)).toThrow();
 });
});

describe('one-sided split link descendants',()=>{
 it.each(['video','audio'])('removes the affected original group from every generated %s fragment',clipId=>{
  const d=registered(),command={type:'split' as const,clipIds:[clipId],frame:2,linked:false};const ordinary=applySequenceCommand(strip(d),command);
  const expected=structuredClone(ordinary);for(const c of expected.clips)if(c.content.kind==='video'||c.content.kind==='audio')delete c.linkGroupId;
  const result=applySequenceCommand(d,command);expect(visible(result)).toBe(visible(expected));expect(result.clips.filter(c=>c.content.kind==='video'||c.content.kind==='audio').every(c=>c.linkGroupId===undefined)).toBe(true);validateSequenceDocument(result);
 });
});

describe('audio-side removal and plural independent clocks',()=>{
 it('removes only the affected link when the audio side is deleted',()=>{
  const result=same(registered(),{type:'delete',clipIds:['audio'],linked:false},['linked']);expect(result.clips.find(c=>c.id==='video')!.linkGroupId).toBeUndefined();expect(result.clips.find(c=>c.id==='caption')!.anchor).toEqual({kind:'timeline'});
 });
 it('keeps each explicitly bound audio evaluation root when multiple independent clocks share one main',()=>{
  const d=fixture();d.tracks.push({id:'a2',kind:'audio',name:'audio2',enabled:true});d.clips.push({...structuredClone(d.clips[1]!),id:'audio2',trackId:'a2',clock:{offset:r(7),rate:r(5),duration:r(100)}});
  let registered=applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'},{audioClipId:'audio2',providerId:'video'}]});registered=same(registered,{type:'move',clipIds:['video'],deltaFrames:1,linked:true});
  expect(registered.clips.find(c=>c.id==='audio')!.speed!.evaluationOwnerId).toBe('audio');expect(registered.clips.find(c=>c.id==='audio2')!.speed!.evaluationOwnerId).toBe('audio2');
  const cut=same(registered,{type:'delete',clipIds:['audio2'],linked:false},['linked']);expect(cut.clips.find(c=>c.id==='audio')!.speed?.kind).toBe('independent-audio');
 });
});

const reviewerDocument:SequenceDocument={"assets": [{"file": "media/owned.mp4", "fingerprint": "owned-v1", "id": "asset", "kind": "media", "name": "Owned fixture", "streams": [{"codec": "h264", "duration": {"den": 1, "num": 10000}, "frameRate": {"den": 1, "num": 30}, "height": 360, "index": 0, "kind": "video", "width": 640}, {"channels": 2, "codec": "aac", "duration": {"den": 1, "num": 10000}, "index": 1, "kind": "audio", "sampleRate": 48000}]}], "background": "#000000", "clips": [{"clock": {"duration": {"den": 1, "num": 300}, "offset": {"den": 3, "num": -11}, "rate": {"den": 5, "num": 2}}, "content": {"assetId": "asset", "kind": "video", "rate": {"den": 10, "num": 1}, "sourceIn": {"den": 7, "num": 5}, "streamIndex": 0}, "durationFrames": 3, "id": "main", "linkGroupId": "linked", "name": "Main", "startFrame": 0, "trackId": "visual", "visual": {"keyframeClock": {"duration": {"den": 1, "num": 200}, "offset": {"den": 11, "num": -17}, "rate": {"den": 13, "num": 5}}, "keyframes": [], "layout": {"background": "#000000", "flipH": false, "flipV": false, "position": {"x": 0, "y": 0}, "rotation": 0, "scale": 1}, "opacity": 0.8}}, {"clock": {"duration": {"den": 1, "num": 300}, "offset": {"den": 1, "num": -4}, "rate": {"den": 5, "num": 3}}, "content": {"assetId": "asset", "kind": "audio", "loop": false, "rate": {"den": 10, "num": 1}, "role": "speech", "settings": {"fadeInFrames": 0, "fadeOutFrames": 0, "gainDb": 0, "muted": false}, "sourceIn": {"den": 7, "num": 5}, "streamIndex": 1}, "durationFrames": 3, "id": "audio", "linkGroupId": "linked", "name": "Owned audio", "startFrame": 0, "trackId": "audio-track", "visual": {"keyframeClock": {"duration": {"den": 1, "num": 200}, "offset": {"den": 11, "num": -18}, "rate": {"den": 13, "num": 6}}, "keyframes": [], "layout": {"background": "#000000", "flipH": false, "flipV": false, "position": {"x": 0, "y": 0}, "rotation": 0, "scale": 1}, "opacity": 0.8}}, {"anchor": {"clipOccurrenceId": "audio", "kind": "source", "role": "speech", "sourceAssetId": "asset", "sourceEnd": {"den": 70, "num": 71}, "sourceStart": {"den": 70, "num": 57}}, "clock": {"duration": {"den": 1, "num": 100}, "offset": {"den": 3, "num": -2}, "rate": {"den": 7, "num": 3}}, "content": {"appearance": {"align": "center", "background": "transparent", "color": "#ffffff", "fontFamily": "\"Noto Sans JP\", \"Hiragino Sans\", sans-serif", "fontSize": 64, "fontWeight": 600, "letterSpacing": 0, "lineHeight": 1.4, "strokeColor": "#000000", "strokeWidth": 0}, "data": {"text": "分割しても時計を保つ"}, "kind": "telop"}, "durationFrames": 2, "id": "caption", "name": "Independent caption", "startFrame": 1, "trackId": "text-track"}], "ducking": {"enabled": false, "strength": "mid"}, "fps": {"den": 1, "num": 1}, "id": "split-oracle-0", "name": "Current legal v2", "resolution": {"height": 360, "width": 640}, "revision": 0, "schemaVersion": 2, "sequenceEndFrame": 2, "tracks": [{"enabled": true, "id": "visual", "kind": "visual", "name": "Video"}, {"enabled": true, "id": "audio-track", "kind": "audio", "name": "Owned audio"}, {"enabled": true, "id": "text-track", "kind": "visual", "name": "Captions"}], "transcripts": [], "transitions": []};
const reviewerRegister:SequenceCommand={"type": "register-native-speed", "groupId": "g", "mainClipIds": ["main"], "mainAudioBindings": [{"audioClipId": "audio", "providerId": "main"}]};
describe('independent review regressions',()=>{
 it.each([false,true])('reorder/delete with detached continuation, optional trim=%s, retains ordinary IDs and Store roundtrip',trim=>{
  let d=applySequenceCommand(reviewerDocument,reviewerRegister);d=same(d,{type:'reorder-ranges',ranges:[{startFrame:1,endFrame:2},{startFrame:0,endFrame:1}]});if(trim)d=same(d,{type:'trim',clipId:'clip-6',edge:'end',frame:5,linked:true});
  d=same(d,{type:'delete',clipIds:['clip-6'],linked:true});expect(d.clips.find(c=>c.id==='caption')).toMatchObject({continuationGroupId:'caption',anchor:{kind:'source'}});expect(d.clips.find(c=>c.id==='clip-7')).toMatchObject({continuationGroupId:'caption',anchor:{kind:'timeline'}});
  d=same(d,{type:'split',clipIds:['clip-7'],frame:d.clips.find(c=>c.id==='clip-7')!.startFrame+1,linked:true});
  const dir=mkdtempSync(join(tmpdir(),'native-structural02-'));try{const store=new SequenceStore(dir);store.save({expectedSavedRevision:null,executionId:'save',document:d});expect(store.load()!.document).toEqual(d);}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it.each([false,true])('updates non-speed timeline trim completed end with empty main=%s',empty=>{
  let d=applySequenceCommand(reviewerDocument,reviewerRegister);if(empty)d=same(d,{type:'delete',clipIds:['main'],linked:true});else d=same(d,{type:'move',clipIds:['caption'],deltaFrames:1,linked:true});
  const after=same(d,{type:'trim',clipId:'caption',edge:'end',frame:7,linked:true});expect(after.sequenceEndFrame).toBe(7);if(empty)expect(after.speed!.sequenceEndBasis).toEqual({kind:'empty-fixed',offsetFrames:0,endFrame:7});
 });
});

describe('explicit detached continuation ownership',()=>{
 function shared(){let d=applySequenceCommand(reviewerDocument,reviewerRegister);d=applySequenceCommand(d,{type:'reorder-ranges',ranges:[{startFrame:1,endFrame:2},{startFrame:0,endFrame:1}]});return applySequenceCommand(d,{type:'delete',clipIds:['clip-6'],linked:true});}
 it('does not duplicate an independent audio carrier ledger when splitting only main',()=>{
  const d=same(registered(),{type:'move',clipIds:['video'],deltaFrames:1,linked:false},['linked']);const next=same(d,{type:'split',clipIds:['video'],frame:2,linked:true});expect(captionLedgers(next)).toHaveLength(1);expect(next.clips.find(c=>c.id==='audio')!.speed!.captions).toHaveLength(1);
 });
 it('follows detached split/trim/delete IDs but never adopts another clip by group lookup',()=>{
  let d=shared();expect(captionLedgers(d)[0]!.detachedContinuations!.map(p=>[p.clipId,p.continuationGroupId])).toEqual([['clip-7','caption']]);
  d=same(d,{type:'trim',clipId:'clip-7',edge:'end',frame:5});d=same(d,{type:'trim',clipId:'clip-7',edge:'start',frame:3});d=same(d,{type:'split',clipIds:['clip-7'],frame:4});const peers=captionLedgers(d)[0]!.detachedContinuations!;expect(peers).toHaveLength(2);expect(new Set(peers.map(p=>p.clipId)).size).toBe(2);
  d=same(d,{type:'delete',clipIds:[peers[0]!.clipId]});expect(captionLedgers(d)[0]!.detachedContinuations).toHaveLength(1);
 });
 it.each(['unrelated-caption','peer-id','peer-group','peer-clock','peer-rate','peer-empty','peer-duplicate','peer-dangling','peer-unknown','non-telop','link-id','real-id','other-ledger','forged-unrelated-peer'] as const)('rejects %s corruption including save/read without blanket continuation exceptions',kind=>{
  const d=shared(),ledger=captionLedgers(d)[0]!,peer=ledger.detachedContinuations![0]!,clip=d.clips.find(c=>c.id===peer.clipId)!;
  if(kind==='unrelated-caption'||kind==='forged-unrelated-peer'){const unrelated={...structuredClone(clip),id:'unrelated',startFrame:50,clock:{...clip.clock,duration:r(999)}};d.clips.push(unrelated);if(kind==='forged-unrelated-peer')ledger.detachedContinuations!.push({...peer,clipId:unrelated.id});}
  if(kind==='peer-id')peer.clipId='caption';if(kind==='peer-group')peer.continuationGroupId='other';if(kind==='peer-clock')peer.sourceFrameOffset=r(999);if(kind==='peer-rate')peer.mediaRate=r(0);if(kind==='peer-empty')ledger.detachedContinuations=[];if(kind==='peer-duplicate')ledger.detachedContinuations!.push(structuredClone(peer));if(kind==='peer-dangling')peer.clipId='missing';if(kind==='peer-unknown')Object.assign(peer,{anything:1});
  if(kind==='non-telop')clip.content={kind:'title',data:{text:'foreign'},style:{top:10,left:20,fontSize:32}};if(kind==='link-id')clip.linkGroupId='caption';if(kind==='real-id')d.clips.push({...structuredClone(clip),id:'caption',startFrame:50});if(kind==='other-ledger'){const another=structuredClone(ledger);another.captionId='other-ledger';another.parts[0]!.partId='other-part';another.parts[0]!.reservedRenderId=peer.clipId;(d.clips.find(c=>c.speed?.captions)!.speed!.captions??=[]).push(another);}
  if(kind==='non-telop'||kind==='unrelated-caption'||kind==='forged-unrelated-peer')validateSequenceDocument(strip(d));
  // Even self-updated part checksums cannot excuse an invalid peer's clock/ID/shape.
  for(const l of captionLedgers(d))l.baselineProjection.inputKey=captionProjectionKey(d,l,l.baselineProjection.snapshotKey);
  expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>serializeSequence(d)).toThrow();expect(()=>parseSequence(JSON.stringify(d))).toThrow();
 });
});
