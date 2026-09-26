import { editorChangeSetSchema, validateEditorTextTargets, type EditorTextTarget } from '../../shared/editorCommands';
import { clipEnd, sourceTimeAt, type SequenceClip, type SequenceDocument } from './model';
import { ceilTime, floorTime, multiplyTime, compareTime } from './time';
import type { SequenceCommand } from './commands';
import {buildNativeAgentCommand} from './nativeAgentCommands';

export const sequenceEditorRevision = (sessionId:string, revision:number) => `native:${sessionId}:${revision}`;

function legacyReferenceSafe(doc:SequenceDocument, clip:SequenceClip):boolean {
  const anchor=clip.anchor;
  if(!doc.legacy || anchor?.kind!=='source' || anchor.role!=='speech' || anchor.sourceAssetId!==doc.legacy.primaryAssetId) return false;
  if(multiplyTime(anchor.sourceStart,doc.fps).den!==1 || multiplyTime(anchor.sourceEnd,doc.fps).den!==1) return false;
  const provider=doc.clips.find(item=>item.id===anchor.clipOccurrenceId);
  if(provider?.content.kind!=='audio' || provider.content.role!=='speech' || provider.content.assetId!==anchor.sourceAssetId
    || provider.content.settings.muted || !doc.tracks.find(track=>track.id===provider.trackId)?.enabled) return false;
  // A source interval must belong to exactly this occurrence, even if the same media is repeated.
  const matches=doc.clips.filter(item=>item.content.kind==='audio' && item.content.role==='speech' && item.content.assetId===anchor.sourceAssetId
    && compareTime(item.content.sourceIn,anchor.sourceStart)<=0
    && compareTime(sourceTimeAt(item,clipEnd(item),doc.fps),anchor.sourceEnd)>=0);
  return matches.length===1 && matches[0]!.id===provider.id;
}

/** The legacy integer range is only a compatibility projection; reference retains exact rational time. */
export function sequenceEditorTargets(doc:SequenceDocument):EditorTextTarget[] {
  return doc.clips.flatMap(clip=>{
    if(clip.content.kind!=='telop') return [];
    const anchor=clip.anchor;
    const reference:NonNullable<EditorTextTarget['reference']>=anchor?.kind==='source'
      ? {kind:'source',assetId:anchor.sourceAssetId,occurrenceId:anchor.clipOccurrenceId,
        start:{num:anchor.sourceStart.num,den:anchor.sourceStart.den},end:{num:anchor.sourceEnd.num,den:anchor.sourceEnd.den}}
      : {kind:'timeline',startFrame:clip.startFrame,endFrame:clipEnd(clip)};
    const start=anchor?.kind==='source'?floorTime(multiplyTime(anchor.sourceStart,doc.fps)):clip.startFrame;
    const end=anchor?.kind==='source'?ceilTime(multiplyTime(anchor.sourceEnd,doc.fps)):clipEnd(clip);
    return [{id:clip.id,text:clip.content.data.text,sourceFrameRange:{start,end},reference,referenceRequired:!legacyReferenceSafe(doc,clip)}];
  });
}

export function sequenceEditorCommand(doc:SequenceDocument,projectId:string,sessionId:string,input:unknown):SequenceCommand {
  const parsed=editorChangeSetSchema.parse(input);
  if(parsed.script) throw new Error('NATIVE_SCRIPT_REVIEW_REQUIRED: 台本案の新形式への接続は準備中です');
  if(parsed.sequence){
    if(parsed.projectId!==projectId)throw new Error('PROJECT_MISMATCH: 対象の案件が異なります');
    if(parsed.baseRevision!==sequenceEditorRevision(sessionId,doc.revision))throw new Error('REVISION_CONFLICT: 編集状態が変わりました');
    return buildNativeAgentCommand(doc,parsed.sequence);
  }
  const targets=sequenceEditorTargets(doc);
  const request=validateEditorTextTargets({projectId,revision:sequenceEditorRevision(sessionId,doc.revision)},targets,parsed);
  return {type:'batch',commands:request.changes.map(change=>{
    const clip=doc.clips.find(item=>item.id===change.elementId)!;
    if(clip.content.kind!=='telop') throw new Error('TARGET_NOT_FOUND: 字幕がありません');
    if(clip.anchor?.kind==='source' && clip.anchor.role==='speech') {
      const occurrenceId=clip.anchor.clipOccurrenceId,provider=doc.clips.find(item=>item.id===occurrenceId);
      if(provider?.content.kind!=='audio' || provider.content.settings.muted || !doc.tracks.find(track=>track.id===provider.trackId)?.enabled)
        throw new Error('SOURCE_OCCURRENCE_UNAVAILABLE: 発話の原音が無効になっています');
    }
    if(!change.reference && !legacyReferenceSafe(doc,clip)) throw new Error('AMBIGUOUS_SOURCE_OCCURRENCE: 素材と使用箇所を指定してください');
    return {type:'update-clip',clipId:clip.id,patch:{content:{...clip.content,data:{...clip.content.data,text:change.after}}}};
  })};
}
