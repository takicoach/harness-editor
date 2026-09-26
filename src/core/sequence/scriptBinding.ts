import { z } from 'zod';
import type { ScriptEditArtifact } from '../scriptEditArtifact';
import type { ScriptEditModification } from '../scriptEditModification';
import { ceilTime,compareTime,divideTime,floorTime,frameSeconds,multiplyTime,subtractTime,type Rational } from './time';

const id=z.string().min(1).max(512),integer=z.number().int().nonnegative().safe();
const time=z.object({num:integer,den:z.number().int().positive().safe()}).strict();
/** Numeric caption labels are local to an immutable proposal. Clip identity remains explicit. */
export const nativeScriptBindingSchema=z.object({
  schemaVersion:z.literal(2),documentId:id,revision:integer,contentHash:z.string().regex(/^[a-f0-9]{64}$/),
  fps:time.refine(value=>value.num>0),sequenceEndFrame:integer,
  source:z.object({assetId:id,streamIndex:integer,assetFingerprint:z.string().min(1),occurrenceId:id,
    startFrame:integer,durationFrames:integer.refine(value=>value>0),sourceIn:time,rate:time.refine(value=>value.num>0)}).strict(),
  captions:z.array(z.object({telopId:integer,clipId:id,sourceStart:time,sourceEnd:time}).strict()).max(200000),
  wordTimes:z.array(z.object({start:time,end:time}).strict()).max(500000),
}).strict().superRefine((value,ctx)=>{
  const fail=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
  if(value.source.startFrame+value.source.durationFrames>value.sequenceEndFrame)fail('台本の対象区間がシーケンス外です');
  if(new Set(value.captions.map(c=>c.telopId)).size!==value.captions.length||new Set(value.captions.map(c=>c.clipId)).size!==value.captions.length)fail('台本の字幕参照が重複しています');
  for(const item of value.captions)if(compareTime(item.sourceStart,item.sourceEnd)>=0)fail('台本の字幕時刻が不正です');
  for(const item of value.wordTimes)if(compareTime(item.start,item.end)>=0)fail('台本の発話時刻が不正です');
});
export type NativeScriptBinding=z.infer<typeof nativeScriptBindingSchema>;
export interface NativeScriptRange {startFrame:number;endFrame:number}

export function nativeScriptSourceRange(binding:NativeScriptBinding,start:Rational,end:Rational):NativeScriptRange {
  const source=binding.source,first=multiplyTime(divideTime(subtractTime(start,source.sourceIn),source.rate),binding.fps),last=multiplyTime(divideTime(subtractTime(end,source.sourceIn),source.rate),binding.fps);
  if(compareTime(start,end)>=0||first.num<0||compareTime(last,{num:source.durationFrames,den:1})>0)throw new Error('SCRIPT_SOURCE_OUTSIDE: この発話は選んだ使用箇所の範囲外です');
  return {startFrame:source.startFrame+floorTime(first),endFrame:source.startFrame+ceilTime(last)};
}

/** Native application quantizes original word time directly onto the selected occurrence. */
export function nativeScriptStructureRanges(artifact:ScriptEditArtifact,modification?:ScriptEditModification):NativeScriptRange[] {
  const binding=artifact.input.native;if(!binding||artifact.proposal.kind!=='structure')throw new Error('NATIVE_SCRIPT_BINDING_REQUIRED');
  let selected:NativeScriptRange[];
  if(modification) {
    if(modification.kind!=='structure')throw new Error('SCRIPT_EDIT_KIND_CONFLICT');
    selected=modification.cutOrder.map(item=>nativeScriptSourceRange(binding,frameSeconds(item.originalStart,binding.fps),frameSeconds(item.originalEnd,binding.fps)));
  }else {
    const alignments=new Map(artifact.input.alignment.proposals.map(item=>[item.passageId,item]));
    selected=artifact.proposal.passages.flatMap(decision=>{
      if(decision.action==='skip')return [];
      const candidate=alignments.get(decision.passageId)?.candidates[decision.candidateIndex];if(!candidate)throw new Error('CANDIDATE_NOT_FOUND');
      const first=binding.wordTimes[candidate.wordRef.startIndex],last=binding.wordTimes[candidate.wordRef.endIndex-1];
      if(!first||!last)throw new Error('WORD_RANGE_INVALID');return [nativeScriptSourceRange(binding,first.start,last.end)];
    });
  }
  if(!selected.length)throw new Error('STRUCTURE_EMPTY');
  const sorted=[...selected].sort((a,b)=>a.startFrame-b.startFrame);
  if(sorted.some((item,index)=>item.endFrame<=item.startFrame||index>0&&item.startFrame<sorted[index-1]!.endFrame))throw new Error('STRUCTURE_FRAME_OVERLAP: 採用する発話が同じ完成フレームに重なります');
  const start=binding.source.startFrame,end=start+binding.source.durationFrames;
  return [...(start>0?[{startFrame:0,endFrame:start}]:[]),...selected,...(end<binding.sequenceEndFrame?[{startFrame:end,endFrame:binding.sequenceEndFrame}]:[])];
}
