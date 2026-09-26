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

import {parseSequence,serializeSequence} from './validate';
import {captionLedgers,materializeSpeedCaptions,refreshCaptionBaselines} from './speedCaptionLedger';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
const normal=(x:SequenceDocument)=>{x=structuredClone(x);delete x.speed;for(const c of x.clips)delete c.speed;return x;};
function same(d:SequenceDocument,command:import('./commands').SequenceCommand){const expected=applySequenceCommand(normal(d),command),next=applySequenceCommand(d,command);expect(visible(next)).toBe(visible(expected));expect(parseSequence(serializeSequence(next))).toEqual(next);return next;}
describe('registered generic edits',()=>{
 it('inserts ordinary fixed text beyond completed end and keeps source/main basis',()=>{const d=registered(),clip={...structuredClone(d.clips[2]!),id:'inserted',startFrame:8,anchor:{kind:'timeline' as const}};const next=same(d,{type:'insert',clips:[clip]});expect(next.clips.find(c=>c.id==='inserted')!.speed).toBeUndefined();expect(next.clips.find(c=>c.id==='video')!.speed).toEqual(d.clips[0]!.speed);expect(next.sequenceEndFrame).toBe(10);});
 it.each(['name','content','visual'] as const)('updates a source caption %s without rejecting its unchanged intent',field=>{const d=applySequenceCommand(registered(),{type:'upgrade-native-speed'}),caption=d.clips.find(c=>c.id==='caption')!;const patch=field==='name'?{name:'新しい名前'}:field==='content'?{content:{...caption.content,data:{text:'変更した本文'}} as typeof caption.content}:{visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.4,keyframes:[]}};const next=same(d,{type:'update-clip',clipId:'caption',patch});expect(captionLedgers(next).flatMap(l=>l.parts).map(p=>[p.partId,p.reservedRenderId,p.intentStart,p.intentEnd])).toEqual(captionLedgers(d).flatMap(l=>l.parts).map(p=>[p.partId,p.reservedRenderId,p.intentStart,p.intentEnd]));});
 it('keeps gain/name/ordinary visual media patches independent from source basis',()=>{const d=registered(),audio=d.clips[1]!;if(audio.content.kind!=='audio')throw Error();const next=same(d,{type:'update-clip',clipId:'audio',patch:{name:'音声',content:{...audio.content,settings:{...audio.content.settings,gainDb:-8}},visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.5,keyframes:[]}}});expect(next.clips.find(c=>c.id==='audio')!.speed).toEqual(audio.speed);});
});

function split(d:SequenceDocument,atFrame:number,clipId='video'){return applySequenceCommand(d,{type:'split',clipIds:[clipId],frame:atFrame,linked:true});}
function projected(d:SequenceDocument,rate:1|2){const next=structuredClone(d),factor=rate===1?2:0.5;next.speed!.globalRate=r(rate);next.sequenceEndFrame*=factor;for(const c of next.clips)if(c.speed){c.startFrame*=factor;c.durationFrames*=factor;c.clock.rate=r(c.clock.rate.num,c.clock.rate.den*factor);if(c.content.kind==='audio'||c.content.kind==='video')c.content.rate=r(rate);}next.clips=next.clips.filter(c=>c.content.kind!=='telop').concat(materializeSpeedCaptions(next));validateSequenceDocument(next);return next;}
describe('presentation belongs to the explicitly edited part',()=>{
 it('keeps latent text unchanged when a visible sibling is edited, reappears on slowing, and restores IDs',()=>{
  const d=fixture();d.clips[2]!.durationFrames=1;d.clips[2]!.anchor={kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(2),sourceEnd:r(4)};
  const adopted=applySequenceCommand(applySequenceCommand(d,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]}),{type:'upgrade-native-speed'});
  const ledger=captionLedgers(adopted)[0]!;ledger.parts[0]!.intentStart=r(1);ledger.parts[0]!.intentEnd=r(3);refreshCaptionBaselines(adopted);validateSequenceDocument(adopted);
  const cut=split(adopted,1),caption=cut.clips.find(c=>c.id==='caption')!;
  const edited=same(cut,{type:'update-clip',clipId:caption.id,patch:{content:{...caption.content,data:{text:'右だけ'}} as typeof caption.content}});
  const parts=captionLedgers(edited)[0]!.parts;
  const collision={...structuredClone(caption),id:parts[0]!.reservedRenderId,startFrame:8,anchor:{kind:'timeline' as const}};
  expect(()=>applySequenceCommand(edited,{type:'insert',clips:[collision]})).toThrow();
  expect(parts[0]!.presentation).toBeUndefined();expect(parts[1]!.presentation?.template.content).toMatchObject({kind:'telop',data:{text:'右だけ'}});
  const slow=projected(edited,1);expect(slow.clips.filter(c=>c.content.kind==='telop').map(c=>[c.id,c.content.kind==='telop'?c.content.data.text:''])).toEqual([[parts[0]!.reservedRenderId,'保持'],['caption','右だけ']]);expect(projected(slow,2)).toEqual(edited);
 });
 it('changes only the chosen visible style',()=>{
  const cut=split(applySequenceCommand(registered(),{type:'upgrade-native-speed'}),2),captions=cut.clips.filter(c=>c.content.kind==='telop');expect(captions).toHaveLength(2);
  const chosen=captions[1]!,edited=same(cut,{type:'update-clip',clipId:chosen.id,patch:{visual:{layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:.25,keyframes:[]}}});
  expect(edited.clips.find(c=>c.id===captions[0]!.id)!.visual).toEqual(captions[0]!.visual);expect(edited.clips.find(c=>c.id===chosen.id)!.visual?.opacity).toBe(.25);
 });
 it('does not cross two ledgers sharing a continuation group',()=>{
  const doc=fixture();doc.clips[2]!.continuationGroupId='shared-caption';doc.tracks.push({id:'t2',kind:'visual',name:'t2',enabled:true});doc.clips.push({...structuredClone(doc.clips[2]!),id:'other-caption',trackId:'t2'});
  const d=applySequenceCommand(applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]}),{type:'upgrade-native-speed'});
  const next=same(d,{type:'update-clip',clipId:'caption',patch:{name:'片方'}});expect(next.clips.find(c=>c.id==='other-caption')).toEqual(d.clips.find(c=>c.id==='other-caption'));expect(captionLedgers(next).find(l=>l.captionId==='other-caption')).toEqual(captionLedgers(d).find(l=>l.captionId==='other-caption'));
 });
});
it('adopts new source captions using intent inverse rather than rounded materialized coverage',()=>{
 const doc=fixture();doc.clips=[3,601].map((durationFrames,i)=>({...structuredClone(doc.clips[0]!),id:`main${i}`,linkGroupId:undefined,startFrame:i?3:0,durationFrames,content:{kind:'video' as const,assetId:'asset',streamIndex:0,sourceIn:r(i*10),rate:r(1)}}));for(const s of doc.assets[0]!.streams!)s.duration=r(2000);doc.sequenceEndFrame=604;
 const d=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['main0','main1'],mainAudioBindings:[]});d.speed!.globalRate=r(2);d.sequenceEndFrame=302;d.clips[0]!.durationFrames=2;d.clips[1]!.startFrame=2;d.clips[1]!.durationFrames=300;for(const c of d.clips){if(c.content.kind==='video')c.content.rate=r(2);c.clock.rate=r(2);}
 validateSequenceDocument(d);const cut=split(d,3,'main1'),right=cut.clips.find(c=>c.startFrame===3)!;
 const caption={...structuredClone(fixture().clips[2]!),id:'phase-caption',startFrame:3,durationFrames:1,anchor:{kind:'source' as const,role:'visual' as const,sourceAssetId:'asset',clipOccurrenceId:right.id,sourceStart:r(12),sourceEnd:r(14)}};
 const next=same(cut,{type:'insert',clips:[caption]});expect(captionLedgers(next).find(l=>l.captionId==='phase-caption')!.parts[0]!.intentStart).toEqual(r(13));
});

import {SequenceSession} from './session';
import {SequenceStore} from '../../server/sequence/store';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createScriptDocument} from '../scriptDocumentData';
import {punchVisualKeyframe} from './visualTransform';
import type {SequenceCommand} from './commands';
describe('generic insertion and preservation boundaries',()=>{
 it.each([false,true])('adopts inserted source captions at v2=%s without changing existing providers',v2=>{
  const d=v2?applySequenceCommand(registered(),{type:'upgrade-native-speed'}):registered();
  const clip={...structuredClone(d.clips[2]!),id:'new-caption',startFrame:0,durationFrames:1,anchor:{kind:'source' as const,role:'speech' as const,sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(0),sourceEnd:r(2)}};
  const next=same(d,{type:'insert',clips:[clip]});expect(captionLedgers(next).map(l=>l.captionId)).toEqual(['caption','new-caption']);
  for(const id of ['video','audio']){const speed=structuredClone(next.clips.find(c=>c.id===id)!.speed!);delete speed.captions;delete speed.captionBaselines;const old=structuredClone(d.clips.find(c=>c.id===id)!.speed!);delete old.captions;delete old.captionBaselines;expect(speed).toEqual(old);}
 });
 it.each(['video','audio'] as const)('inserts ordinary %s as fixed even when all registered main clips were deleted',kind=>{
  const d=applySequenceCommand(registered(),{type:'delete',clipIds:['video'],linked:true});const clip={...structuredClone(fixture().clips[kind==='video'?0:1]!),id:`new-${kind}`,startFrame:10,linkGroupId:undefined};const next=same(d,{type:'insert',clips:[clip]});expect(next.speed!.sequenceEndBasis).toEqual({kind:'empty-fixed',offsetFrames:0,endFrame:14});expect(next.clips.find(c=>c.id===clip.id)!.speed).toBeUndefined();
 });
 it('does not inject speed roles through ordinary insertion',()=>{const d=registered(),clip={...structuredClone(d.clips[0]!),id:'forged',startFrame:8};expect(()=>applySequenceCommand(d,{type:'insert',clips:[clip]})).toThrow(/専用登録/);});
 it.each(['asset','stream','source','rate','kind'] as const)('rejects generic registered %s changes atomically',field=>{
  const d=registered(),content=structuredClone(d.clips[0]!.content);if(content.kind!=='video')throw Error();
  const patch=field==='asset'?{...content,assetId:'other'}:field==='stream'?{...content,streamIndex:1}:field==='source'?{...content,sourceIn:r(1)}:field==='rate'?{...content,rate:r(1)}:{...content,endBehavior:undefined,kind:'audio' as const,role:'speech' as const,loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}};
  const saved=structuredClone(d);expect(()=>applySequenceCommand(d,{type:'update-clip',clipId:'video',patch:{content:patch}})).toThrow(/専用コマンド/);expect(d).toEqual(saved);
 });
 it('accepts equivalent non-reduced rates and Inspector visual key patches without rewriting source clocks',()=>{
  const d=registered(),video=d.clips[0]!;if(video.content.kind!=='video')throw Error();
  expect(applySequenceCommand(d,{type:'update-clip',clipId:'video',patch:{content:{...video.content,rate:{num:4,den:2}}}})).toBe(d);
  const next=same(d,{type:'update-clip',clipId:'video',patch:{visual:punchVisualKeyframe(video,1)}});expect(next.clips[0]!.speed).toEqual(video.speed);
  expect(()=>applySequenceCommand(next,{type:'update-clip',clipId:'video',patch:{visual:{...next.clips[0]!.visual!,keyframeClock:{offset:r(0),rate:r(1),duration:r(4)}}}})).toThrow(/専用.*時計/);
 });
 it('preserves independent audio rate/source basis through gain changes',()=>{
  const d=applySequenceCommand(registered(),{type:'delete',clipIds:['video'],linked:false}),audio=d.clips.find(c=>c.id==='audio')!;if(audio.content.kind!=='audio')throw Error();expect(audio.speed!.kind).toBe('independent-audio');
  const next=same(d,{type:'update-clip',clipId:'audio',patch:{content:{...audio.content,settings:{...audio.content.settings,gainDb:-9}}}});expect(next.clips.find(c=>c.id==='audio')!.speed).toEqual(audio.speed);
 });
 it('keeps selected presentation through later split/trim/move/reorder and provider deletion',()=>{
  let d=registered();const caption=d.clips[2]!;d=same(d,{type:'update-clip',clipId:'caption',patch:{content:{...caption.content,data:{text:'編集済み'}} as typeof caption.content}});
  d=same(d,{type:'split',clipIds:['video'],frame:2,linked:true});expect(d.clips.filter(c=>c.content.kind==='telop').map(c=>c.content.kind==='telop'?c.content.data.text:'')).toEqual(['編集済み','編集済み']);
  d=same(d,{type:'trim',clipId:'video',edge:'start',frame:1,linked:true});d=same(d,{type:'reorder-ranges',ranges:[{startFrame:2,endFrame:4},{startFrame:0,endFrame:2}]});d=same(d,{type:'delete',clipIds:['video'],linked:true});
  const peer=d.clips.find(c=>c.content.kind==='telop'&&c.anchor?.kind==='timeline');if(peer){const next=same(d,{type:'update-clip',clipId:peer.id,patch:{name:'独立本文片'}});expect(next.clips.find(c=>c.id===peer.id)!.clock).toEqual(peer.clock);}
 });
 it('keeps metadata unchanged through script/transcript/track/asset updates',()=>{
  let d=applySequenceCommand(registered(),{type:'upgrade-native-speed'});const meta=()=>[d.speed,d.clips.map(c=>c.speed)];const before=structuredClone(meta());
  const commands:SequenceCommand[]=[{type:'set-script',script:createScriptDocument('本文',{documentId:'script',revision:'r1'})},{type:'set-transcript',assetFingerprint:'private',before:null,transcript:{assetId:'asset',streamIndex:1,words:[{id:'word',text:'保持',start:r(2),end:r(3)}]}},{type:'add-track',track:{id:'new-track',kind:'visual',name:'追加',enabled:true}},{type:'set-track-enabled',trackId:'t',enabled:false},{type:'move-track',trackId:'t',index:0},{type:'register-assets',assets:[structuredClone(d.assets[0]!)]}];
  for(const command of commands){d=same(d,command);expect(meta()).toEqual(before);}d=same(d,{type:'set-script',script:null});expect(meta()).toEqual(before);
 });
});
describe('saved presentation validation and transaction boundaries',()=>{
 it.each(['unknown','content','opacity','track','clock'] as const)('rejects saved presentation %s corruption even when the affected part is latent',kind=>{
  const d=applySequenceCommand(registered(),{type:'upgrade-native-speed'}),ledger=captionLedgers(d)[0]!;const part=ledger.parts[0]!;part.presentation={template:structuredClone(ledger.template)};
  part.intentStart=r(2);part.intentEnd=r(5,2);refreshCaptionBaselines(d);d.clips=d.clips.filter(c=>c.id!=='caption');validateSequenceDocument(d);
  const t=part.presentation.template;if(kind==='unknown')(part.presentation as unknown as Record<string,unknown>).extra=true;if(kind==='content'){if(t.content.kind!=='telop')throw Error();t.content.data=null as never;}if(kind==='opacity')t.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:NaN,keyframes:[]};if(kind==='track')t.trackId='missing';if(kind==='clock')t.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:{offset:r(0),rate:r(1),duration:r(1)}};
  expect(()=>validateSequenceDocument(d)).toThrow();expect(()=>serializeSequence(d)).toThrow();
 });
 it('saves/replays one property+insert batch and exactly restores original v1 with one Undo',()=>{
  const before=registered(),session=new SequenceSession('generic',before);const clip={...structuredClone(before.clips[2]!),id:'fixed',startFrame:8,anchor:{kind:'timeline' as const}};
  const command:SequenceCommand={type:'batch',commands:[{type:'update-clip',clipId:'caption',patch:{name:'変更'}},{type:'insert',clips:[clip]}]};const request={sessionId:'generic',expectedRevision:before.revision,executionId:'edit',command};const first=session.execute(request);expect(session.execute(request).replayed).toBe(true);
  const dir=mkdtempSync(join(tmpdir(),'native-generic-'));try{const store=new SequenceStore(dir),save={expectedSavedRevision:null,executionId:'save',document:first.document};store.save(save);expect(store.save(save).replayed).toBe(true);expect(new SequenceStore(dir).load()!.document).toEqual(first.document);
   const undo=session.execute({sessionId:'generic',expectedRevision:first.document.revision,executionId:'undo',command:{type:'undo'}}).document;expect(sequenceContentBytes(undo)).toBe(sequenceContentBytes(before));const redo=session.execute({sessionId:'generic',expectedRevision:undo.revision,executionId:'redo',command:{type:'redo'}}).document;expect(sequenceContentBytes(redo)).toBe(sequenceContentBytes(first.document));
  }finally{rmSync(dir,{recursive:true,force:true});}
  const failed=new SequenceSession('failed',before);expect(()=>failed.execute({sessionId:'failed',expectedRevision:before.revision,executionId:'failed',command:{type:'batch',commands:[command,{type:'update-clip',clipId:'absent',patch:{name:'不正'}}]}})).toThrow();expect(failed.document).toEqual(before);expect(failed.canUndo).toBe(false);
 });
});
