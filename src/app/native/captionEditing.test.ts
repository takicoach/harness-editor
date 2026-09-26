import {expect,it} from 'vitest';
import {applySequenceCommand} from '../../core/sequence/commands';
import {type SequenceDocument,DEFAULT_TEXT_APPEARANCE} from '../../core/sequence/model';
import {rational as r} from '../../core/sequence/time';
import {parseSequence,serializeSequence} from '../../core/sequence/validate';
import {SequenceSession} from '../../core/sequence/session';
import {resolveCutBoundary} from '../../core/sequence/cutArchive';
import {captionClips,captionTextCommand,splitCaptionCommand,mergeCaptionCommand} from './captionEditing';

function fixture():SequenceDocument {
  return {schemaVersion:2,id:'caption-edit',name:'字幕操作',revision:0,fps:r(30),resolution:{width:640,height:360},sequenceEndFrame:300,background:'#000',ducking:{enabled:false,strength:'mid'},transcripts:[],transitions:[],
    assets:[{id:'asset',kind:'media',file:'media/source.mp4',name:'source',fingerprint:'fixture',streams:[{index:0,kind:'video',codec:'h264',duration:r(20),width:640,height:360,frameRate:r(30)},{index:1,kind:'audio',codec:'aac',duration:r(20),sampleRate:48000,channels:2}]}],
    tracks:[{id:'v',kind:'visual',name:'映像',enabled:true},{id:'a',kind:'audio',name:'原音',enabled:true},{id:'t',kind:'visual',name:'字幕',enabled:true}],
    clips:[{id:'video',trackId:'v',name:'video',startFrame:0,durationFrames:300,linkGroupId:'av',clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'video',assetId:'asset',streamIndex:0,sourceIn:r(0),rate:r(1)}},
      {id:'audio',trackId:'a',name:'audio',startFrame:0,durationFrames:300,linkGroupId:'av',clock:{offset:r(0),rate:r(1),duration:r(300)},content:{kind:'audio',assetId:'asset',streamIndex:1,sourceIn:r(0),rate:r(1),role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}}},
      {id:'caption',trackId:'t',name:'字幕',startFrame:30,durationFrames:240,clock:{offset:r(0),rate:r(1),duration:r(240)},content:{kind:'telop',data:{text:'今日はゴルフです'},appearance:{...DEFAULT_TEXT_APPEARANCE,color:'#ffcc00'}},anchor:{kind:'source',role:'speech',sourceAssetId:'asset',clipOccurrenceId:'audio',sourceStart:r(1),sourceEnd:r(9)}}]};
}
function mediaWithoutCaptionLedger(document:SequenceDocument){
  return document.clips.filter(c=>c.content.kind==='audio'||c.content.kind==='video').map(c=>{
    const copy=structuredClone(c);if(copy.speed){delete copy.speed.captions;delete copy.speed.captionBaselines;}return copy;
  });
}
it('changes only caption text/name and survives serialization, preserving media, style and timing',()=>{
  const doc=fixture(),before=structuredClone(doc),next=applySequenceCommand(doc,captionTextCommand(doc,'caption','明日はゴルフです'));
  expect(captionClips(parseSequence(serializeSequence(next)))[0]!.content.data.text).toBe('明日はゴルフです');
  expect(next.clips.slice(0,2)).toEqual(before.clips.slice(0,2));
  expect(next.clips[2]).toEqual({...before.clips[2],name:'明日はゴルフです',content:{...before.clips[2]!.content,data:{text:'明日はゴルフです'}}});
  expect(doc).toEqual(before);
});
it.each([false,true])('splits and merges a caption without moving AV; registered speed=%s',registered=>{
  let doc=fixture();
  if(registered)doc=applySequenceCommand(doc,{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  const media=mediaWithoutCaptionLedger(doc),split=splitCaptionCommand(doc,'caption',120,3);
  const next=applySequenceCommand(doc,split.command),captions=captionClips(next);
  expect(captions.map(c=>[c.startFrame,c.durationFrames,c.content.data.text])).toEqual([[30,90,'今日は'],[120,150,'ゴルフです']]);
  expect(captions[1]!.id).toBe(split.selectedId);expect(mediaWithoutCaptionLedger(next)).toEqual(media);
  const merged=applySequenceCommand(next,mergeCaptionCommand(next,'caption').command);
  expect(captionClips(merged).map(c=>[c.startFrame,c.durationFrames,c.content.data.text])).toEqual([[30,240,'今日はゴルフです']]);
  expect(mediaWithoutCaptionLedger(merged)).toEqual(media);
  parseSequence(serializeSequence(merged));
  if(registered){
    const faster=applySequenceCommand(merged,{type:'set-native-global-speed',rate:r(2)});
    expect(captionClips(faster).map(c=>c.content.data.text)).toEqual(['今日はゴルフです']);
  }
});
it('uses source-word boundaries and never splits a grapheme or emoji',()=>{
  const doc=fixture();doc.transcripts=[{assetId:'asset',streamIndex:1,words:[{id:'w1',text:'今日は',start:r(1),end:r(2)},{id:'w2',text:'ゴルフです',start:r(6),end:r(9)}]}];
  const next=applySequenceCommand(doc,splitCaptionCommand(doc,'caption',100).command);
  expect(captionClips(next).map(c=>c.content.data.text)).toEqual(['今日は','ゴルフです']);
  const emoji=applySequenceCommand(doc,captionTextCommand(doc,'caption','👨‍👩‍👧‍👦ゴルフ'));
  const halves=captionClips(applySequenceCommand(emoji,splitCaptionCommand(emoji,'caption',40,2).command)).map(c=>c.content.data.text);
  expect(halves).toEqual(['👨‍👩‍👧‍👦','ゴルフ']);
});
it('duplicates decorative text and refuses invalid split endpoints atomically',()=>{
  const doc=fixture();const c=doc.clips[2]!;if(c.content.kind==='telop')c.content.data.manual=true;
  const next=applySequenceCommand(doc,splitCaptionCommand(doc,'caption',120).command);
  expect(captionClips(next).map(c=>c.content.data.text)).toEqual(['今日はゴルフです','今日はゴルフです']);
  const before=serializeSequence(doc);
  for(const frame of [30,270,NaN,90.5])expect(()=>splitCaptionCommand(doc,'caption',frame)).toThrow();
  expect(serializeSequence(doc)).toBe(before);
});
it.each([r(1),r(2),r(3,2),r(2,3)])('keeps caption words and exact split windows across a later speed round trip (%j)',rate=>{
  let doc=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  doc=applySequenceCommand(doc,{type:'set-native-global-speed',rate});
  const original=captionClips(doc)[0]!,at=original.startFrame+Math.floor(original.durationFrames/2);
  const split=splitCaptionCommand(doc,original.id,at,3),next=applySequenceCommand(doc,split.command);
  expect(captionClips(next).map(c=>[c.startFrame,c.durationFrames,c.content.data.text])).toEqual([[original.startFrame,at-original.startFrame,'今日は'],[at,original.startFrame+original.durationFrames-at,'ゴルフです']]);
  const saved=parseSequence(serializeSequence(next));
  const faster=applySequenceCommand(saved,{type:'set-native-global-speed',rate:r(4)}),back=applySequenceCommand(faster,{type:'set-native-global-speed',rate});
  expect(captionClips(back)).toEqual(captionClips(next));
  const merged=applySequenceCommand(back,mergeCaptionCommand(back,original.id).command);
  expect(captionClips(merged).map(c=>[c.startFrame,c.durationFrames,c.content.data.text])).toEqual([[original.startFrame,original.durationFrames,'今日はゴルフです']]);
  const renderedMedia=(d:SequenceDocument)=>d.clips.filter(c=>c.content.kind==='audio'||c.content.kind==='video').map(({speed:_speed,...c})=>c);
  expect(renderedMedia(next)).toEqual(renderedMedia(doc));expect(renderedMedia(merged)).toEqual(renderedMedia(doc));
});
it('records the complete split as one Undo and one Redo, including source intent',()=>{
  const doc=applySequenceCommand(fixture(),{type:'register-native-speed',groupId:'group',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  const session=new SequenceSession('editing',doc),command=splitCaptionCommand(doc,'caption',120,3).command;
  session.execute({sessionId:session.id,executionId:'split',expectedRevision:doc.revision,command});const split=session.document;
  session.execute({sessionId:session.id,executionId:'undo',expectedRevision:split.revision,command:{type:'undo'}});
  expect({...session.document,revision:doc.revision}).toEqual(doc);expect(session.canUndo).toBe(false);
  session.execute({sessionId:session.id,executionId:'redo',expectedRevision:session.document.revision,command:{type:'redo'}});
  expect({...session.document,revision:split.revision}).toEqual(split);
});
it.each([false,true])('keeps a saved cut attached to the right subtitle fragment after splitting; registered=%s',registered=>{
  let doc=fixture();if(registered)doc=applySequenceCommand(doc,{type:'register-native-speed',groupId:'speed',mainClipIds:['video'],mainAudioBindings:[{audioClipId:'audio',providerId:'video'}]});
  const cut=applySequenceCommand(doc,{type:'ripple-delete',startFrame:120,endFrame:150}),entry=cut.cutArchive!.entries[0]!;
  expect(resolveCutBoundary(cut,entry).frame).toBe(120);
  const split=applySequenceCommand(cut,splitCaptionCommand(cut,'caption',60,2).command),saved=parseSequence(serializeSequence(split));
  expect(resolveCutBoundary(saved,saved.cutArchive!.entries[0]!).frame).toBe(120);
  const restored=applySequenceCommand(saved,{type:'restore-cut',entryId:entry.id});
  expect(restored.sequenceEndFrame).toBe(doc.sequenceEndFrame);expect(restored.cutArchive?.entries??[]).toHaveLength(0);
  expect(captionClips(restored)[0]!.content.data.text).toBe('今日');
});
