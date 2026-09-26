import type { ScriptEditInput } from '../scriptEditProposal';
import { validateScriptEditInput } from '../scriptEditProposal';
import { validateScriptEditArtifact,type ScriptEditArtifact } from '../scriptEditArtifact';
import { resolveScriptEditPlan,type ScriptEditModification } from '../scriptEditModification';
import { clipEnd,sourceTimeAt,type SequenceDocument } from './model';
import { nativeScriptBindingSchema,nativeScriptStructureRanges } from './scriptBinding';
import { ceilTime,compareTime,floorTime,multiplyTime,timeNumber } from './time';
import { validateSequenceDocument,validateSourceSelection } from './validate';
import { applySequenceCommand,type SequenceCommand } from './commands';

export function nativeScriptEditing(document:SequenceDocument,contentHash:string,occurrenceId:string):Pick<ScriptEditInput,'editing'|'native'> {
  validateSequenceDocument(document);
  const occurrence=document.clips.find(clip=>clip.id===occurrenceId);
  if(!occurrence||occurrence.content.kind!=='audio'||occurrence.content.role!=='speech')throw new Error('SCRIPT_SOURCE_REQUIRED: 台本と照合する原音の使用箇所を選択してください');
  validateSourceSelection(document,occurrence);const content=occurrence.content;
  const asset=document.assets.find(asset=>asset.id===content.assetId)!,stream=asset.streams.find(stream=>stream.index===content.streamIndex)!;
  const words=document.transcripts.find(item=>item.assetId===asset.id&&item.streamIndex===stream.index)?.words;
  if(!words?.length)throw new Error('SCRIPT_TRANSCRIPT_REQUIRED: 原音の文字起こしが必要です');
  const totalFrames=ceilTime(multiplyTime(stream.duration,document.fps));
  const first=floorTime(multiplyTime(content.sourceIn,document.fps)),last=Math.min(totalFrames,ceilTime(multiplyTime(sourceTimeAt(occurrence,clipEnd(occurrence),document.fps),document.fps)));
  const captions=document.clips.filter(clip=>clip.content.kind==='telop'&&clip.anchor?.kind==='source'&&clip.anchor.clipOccurrenceId===occurrenceId)
    .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).flatMap((clip,index)=>{
      if(clip.content.kind!=='telop'||clip.anchor?.kind!=='source')return [];
      const originalStart=floorTime(multiplyTime(clip.anchor.sourceStart,document.fps)),originalEnd=Math.min(totalFrames,ceilTime(multiplyTime(clip.anchor.sourceEnd,document.fps)));
      if(originalStart>=originalEnd)return [];
      return [{telop:{id:index+1,text:clip.content.data.text,originalStart,originalEnd},binding:{telopId:index+1,clipId:clip.id,sourceStart:clip.anchor.sourceStart,sourceEnd:clip.anchor.sourceEnd}}];
    });
  return {editing:{fps:timeNumber(document.fps),totalFrames,telops:captions.map(item=>item.telop),
    cutRegions:[...(first>0?[{start:0,end:first}]:[]),...(last<totalFrames?[{start:last,end:totalFrames}]:[])],cutOrder:[{originalStart:first,originalEnd:last}]},
    native:nativeScriptBindingSchema.parse({schemaVersion:2,documentId:document.id,revision:document.revision,contentHash,fps:document.fps,sequenceEndFrame:document.sequenceEndFrame,
      source:{assetId:asset.id,streamIndex:stream.index,assetFingerprint:asset.fingerprint,occurrenceId,startFrame:occurrence.startFrame,durationFrames:occurrence.durationFrames,sourceIn:content.sourceIn,rate:content.rate},
      captions:captions.map(item=>item.binding),wordTimes:words.map(word=>({start:word.start,end:word.end}))})};
}

/** Translation only: the server separately requires the exact durable human judgment. */
export function sequenceScriptEditCommand(document:SequenceDocument,actualContentHash:string,value:ScriptEditArtifact,modification?:ScriptEditModification):SequenceCommand {
  const artifact=validateScriptEditArtifact(value),binding=artifact.input.native;
  if(!binding)throw new Error('NATIVE_SCRIPT_BINDING_REQUIRED: 独自編集用の素材参照が必要です');
  const expected=validateScriptEditInput({...artifact.input,...nativeScriptEditing(document,actualContentHash,binding.source.occurrenceId)});
  if(JSON.stringify(expected.native)!==JSON.stringify(binding)||JSON.stringify(expected.editing)!==JSON.stringify(artifact.input.editing))throw new Error('STALE_SCRIPT_EDIT: 台本案を作った時の素材・字幕・編集内容と異なります');
  const plan=resolveScriptEditPlan(artifact,modification);
  let command:SequenceCommand;
  if(plan.kind==='structure')command={type:'reorder-ranges',ranges:nativeScriptStructureRanges(artifact,modification)};
  else {
    const changes=artifact.proposal.kind==='caption'?artifact.proposal.changes:[];
    command={type:'batch',commands:plan.changes.map(change=>{
      const target=binding.captions.find(item=>item.telopId===change.telopId),evidence=changes.find(item=>item.telopId===change.telopId);
      const clip=document.clips.find(clip=>clip.id===target?.clipId);
      if(!target||!evidence||clip?.content.kind!=='telop'||clip.content.data.text!==change.before)throw new Error('TELOP_BASE_CONFLICT: 対象の字幕が変わっています');
      const start=binding.wordTimes[evidence.wordRef.startIndex]!.start,end=binding.wordTimes[evidence.wordRef.endIndex-1]!.end;
      if(compareTime(start,target.sourceEnd)>=0||compareTime(end,target.sourceStart)<=0)throw new Error('TELOP_TIME_CONFLICT: 字幕と発話が一致しません');
      return {type:'update-clip',clipId:clip.id,patch:{name:change.after.slice(0,30),content:{...clip.content,data:{...clip.content.data,text:change.after}}}};
    })};
  }
  if(applySequenceCommand(document,command)===document)throw new Error('SCRIPT_EDIT_NO_OP: 現在の編集と同じ内容です');
  return command;
}
