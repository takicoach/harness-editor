import { expect,it } from 'vitest';
import { nativeScriptEditing,sequenceScriptEditCommand } from './scriptEdits';
import { applySequenceCommand } from './commands';
import type { SequenceDocument } from './model';
import { rational as r,timeNumber } from './time';
import { sequenceContentBytes } from './validate';
import { SequenceSession } from './session';
import { createScriptDocument } from '../scriptDocumentData';
import { buildLiteralAlignments } from '../scriptAlignment';
import { resolveScriptEditPlan } from '../scriptEditModification';
import { sequenceContentHash } from '../../server/sequence/store';
import { createScriptProposalArtifact,sealScriptInputPacket } from '../../server/scriptProposalArtifacts';
import { createScriptEditArtifact,sealScriptEditInput } from '../../server/scriptEditArtifacts';

function fixture(kind:'caption'|'structure'='structure') {
  const document:SequenceDocument={schemaVersion:2,id:'case',name:'台本の合成検証',revision:0,fps:r(30000,1001),resolution:{width:320,height:180},sequenceEndFrame:180,background:'#000000',
    ducking:{enabled:false,strength:'mid'},assets:[{id:'media',kind:'media',name:'素材',file:'.harness/assets/test.mp4',fingerprint:'owned',streams:[
      {index:0,kind:'video',codec:'h264',duration:r(10),frameRate:r(30),width:320,height:180},
      {index:1,kind:'audio',codec:'aac',duration:r(10),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',name:'映像',kind:'visual',enabled:true},{id:'a',name:'原音',kind:'audio',enabled:true},{id:'t',name:'字幕',kind:'visual',enabled:true}],
    clips:[
      {id:'video',trackId:'v',name:'映像',startFrame:0,durationFrames:180,clock:{offset:r(0),rate:r(1),duration:r(180)},content:{kind:'video',assetId:'media',streamIndex:0,sourceIn:r(0),rate:r(1)}},
      {id:'speech',trackId:'a',name:'原音',startFrame:30,durationFrames:120,clock:{offset:r(0),rate:r(1),duration:r(120)},content:{kind:'audio',assetId:'media',streamIndex:1,sourceIn:r(1),rate:r(1,2),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
      {id:'caption-stable',trackId:'t',name:'字幕',startFrame:41,durationFrames:13,clock:{offset:r(0),rate:r(1),duration:r(13)},content:{kind:'telop',data:{text:'サキ',template:2,animation:'none'}},anchor:{kind:'source',role:'speech',sourceAssetId:'media',clipOccurrenceId:'speech',sourceStart:r(71011,60000),sourceEnd:r(84024,60000)}},
    ],transitions:[],transcripts:[{assetId:'media',streamIndex:1,words:[{id:'w1',text:'先',start:r(6,5),end:r(7,5)},{id:'w2',text:'後',start:r(11,5),end:r(12,5)}]}],
    scriptDocument:createScriptDocument('後\n先',{documentId:'script',revision:'one'})};
  function artifactFor(doc:SequenceDocument) {
    const generator={skillId:kind==='caption'?'subtitle-orthography' as const:'script-structure' as const,skillVersion:'1',provider:'deterministic',model:'synthetic-test',configHash:'c'.repeat(64)};
    const packet=sealScriptInputPacket({schemaVersion:1,packetHash:'0'.repeat(64),projectId:'case',editRevision:'owned',source:{id:'media-speech',revision:'owned',durationMs:10000},script:doc.scriptDocument!,
      transcript:{revision:'words',words:doc.transcripts[0]!.words.map((word,index)=>({index,text:word.text,startMs:timeNumber(word.start)*1000,endMs:timeNumber(word.end)*1000}))}});
    const alignment=createScriptProposalArtifact(packet,buildLiteralAlignments(packet,generator));
    const input=sealScriptEditInput({schemaVersion:1,inputHash:'0'.repeat(64),alignment,...nativeScriptEditing(doc,sequenceContentHash(doc),'speech')});
    const passage=packet.script.passages[1]!,candidate=alignment.proposals[1]!.candidates[0]!;
    return createScriptEditArtifact(input,{schemaVersion:1,kind,proposalId:`script-edit:${kind}:${input.inputHash}`,inputHash:input.inputHash,generator,
      passages:packet.script.passages.map((p,index)=>kind==='caption'&&index===0?{passageId:p.id,action:'skip',reason:'この箇所の字幕変更はありません'}:{passageId:p.id,action:'use',candidateIndex:0,reason:'合成検証'}),
      ...(kind==='caption'?{changes:[{telopId:input.editing.telops[0]!.id,before:'サキ',after:'先',passageId:passage.id,scriptRange:passage.range,wordRef:candidate.wordRef}]}:{})});
  }
  return {document,artifact:artifactFor(document),artifactFor};
}

it('uses original rational word times at fractional fps and half speed, keeps outside context, and undoes all layers once',()=>{
  const {document,artifact}=fixture();
  const plan=resolveScriptEditPlan(artifact);
  expect(plan.native?.ranges).toEqual([{startFrame:0,endFrame:30},{startFrame:101,endFrame:114},{startFrame:41,endFrame:54},{startFrame:150,endFrame:180}]);
  const session=new SequenceSession('test',document),command=sequenceScriptEditCommand(document,sequenceContentHash(document),artifact);
  session.execute({sessionId:'test',expectedRevision:0,executionId:'adopt',command});
  expect(session.document.sequenceEndFrame).toBe(86);
  expect(session.document.clips.filter(c=>c.content.kind==='audio').map(c=>[c.startFrame,c.durationFrames])).toEqual([[30,13],[43,13]]);
  const caption=session.document.clips.find(c=>c.id==='caption-stable')!;
  expect(caption.startFrame).toBe(43);expect(caption.content).toEqual(document.clips[2]!.content);
  session.execute({sessionId:'test',expectedRevision:1,executionId:'undo',command:{type:'undo'}});
  expect(sequenceContentBytes(session.document)).toBe(sequenceContentBytes(document));
});

it('binds captions to actual clip IDs and refuses stale, muted, redirected and resealed inputs',()=>{
  const {document,artifact}=fixture('caption');
  const edited=applySequenceCommand(document,sequenceScriptEditCommand(document,sequenceContentHash(document),artifact));
  expect(edited.clips[2]!.content).toEqual({kind:'telop',data:{text:'先',template:2,animation:'none'}});
  expect(edited.clips.slice(0,2)).toEqual(document.clips.slice(0,2));
  const changed=structuredClone(document);changed.name='人の変更';
  expect(()=>sequenceScriptEditCommand(changed,sequenceContentHash(changed),artifact)).toThrow(/STALE_SCRIPT_EDIT/);
  const redirected=structuredClone(artifact);redirected.input.native!.captions[0]!.clipId='video';
  expect(()=>sequenceScriptEditCommand(document,sequenceContentHash(document),redirected)).toThrow(/STALE_SCRIPT_EDIT/);
  const speech=changed.clips[1]!.content;if(speech.kind==='audio')speech.settings.muted=true;
  expect(()=>sequenceScriptEditCommand(changed,sequenceContentHash(changed),artifact)).toThrow();
});

it('refuses a selected word outside the chosen occurrence even when the raw source contains it',()=>{
  const {document,artifactFor}=fixture();
  const shorter=structuredClone(document);shorter.clips[1]!.durationFrames=60;
  const artifact=artifactFor(shorter);
  expect(()=>sequenceScriptEditCommand(shorter,sequenceContentHash(shorter),artifact)).toThrow(/SCRIPT_SOURCE_OUTSIDE/);
});

it('keeps the second use of the same source and its caption independent',()=>{
  const {document,artifactFor}=fixture('caption');
  const repeated=structuredClone(document.clips[1]!);repeated.id='speech-again';repeated.startFrame=150;
  const secondCaption=structuredClone(document.clips[2]!);secondCaption.id='caption-again';secondCaption.startFrame=161;
  if(secondCaption.anchor?.kind==='source')secondCaption.anchor.clipOccurrenceId=repeated.id;
  document.clips.push(repeated,secondCaption);document.sequenceEndFrame=270;
  const artifact=artifactFor(document),after=applySequenceCommand(document,sequenceScriptEditCommand(document,sequenceContentHash(document),artifact));
  expect(artifact.input.native!.captions.map(c=>c.clipId)).toEqual(['caption-stable']);
  expect(after.clips.find(c=>c.id==='caption-again')).toEqual(secondCaption);
  expect(after.clips.find(c=>c.id==='speech-again')).toEqual(repeated);
});

it('records the actual completed-frame ranges for a human-adjusted source range and rejects adjustments outside the occurrence',()=>{
  const {document,artifact}=fixture();
  const modification={kind:'structure' as const,cutOrder:[{originalStart:66,originalEnd:72},{originalStart:36,originalEnd:42}]};
  const plan=resolveScriptEditPlan(artifact,modification);
  expect(plan.native?.ranges).toEqual([{startFrame:0,endFrame:30},{startFrame:102,endFrame:115},{startFrame:42,endFrame:55},{startFrame:150,endFrame:180}]);
  expect(applySequenceCommand(document,sequenceScriptEditCommand(document,sequenceContentHash(document),artifact,modification)).sequenceEndFrame).toBe(86);
  expect(()=>resolveScriptEditPlan(artifact,{kind:'structure',cutOrder:[{originalStart:0,originalEnd:10}]})).toThrow(/SCRIPT_SOURCE_OUTSIDE/);
});
