import {type CutArchiveEntry,type SequenceDocument,type SequenceClip} from './model';
import {addTime,ceilTime,divideTime,multiplyTime,subtractTime} from './time';
import {cutBoundaryAt} from './cutArchive';
import {inspectNativeSourceGaps} from './sourceGapRecovery';
import {SequenceError} from './errors';

export interface AdoptSourceGapCommand {type:'adopt-source-gap';candidateId:string;ownerClipId:string;atFrame?:number}
function fail(message:string):never {throw new SequenceError('INVALID_RANGE',message);}
export function validateAdoptSourceGap(value:unknown):asserts value is AdoptSourceGapCommand {
  if(!value||typeof value!=='object'||Array.isArray(value))fail('元映像の復元範囲が不正です');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(key=>!['type','candidateId','ownerClipId','atFrame'].includes(key))||v.type!=='adopt-source-gap'
    ||typeof v.candidateId!=='string'||!v.candidateId.length||v.candidateId.length>2048
    ||typeof v.ownerClipId!=='string'||!v.ownerClipId.length||v.ownerClipId.length>256
    ||v.atFrame!==undefined&&(!Number.isSafeInteger(v.atFrame)||(v.atFrame as number)<0))fail('元映像の復元範囲が不正です');
}

/** Adds a verified raw AV band only. Live clips, subtitles and completion time remain unchanged. */
export function adoptSourceGap(document:SequenceDocument,command:AdoptSourceGapCommand,fresh:(prefix:string)=>string):SequenceDocument {
  validateAdoptSourceGap(command);
  const candidate=inspectNativeSourceGaps(document).candidates.find(item=>item.id===command.candidateId);
  if(!candidate)fail('元映像の使用範囲が変わりました。範囲を選び直してください');
  const choice=candidate.ownerChoices.find(item=>item.ownerClipId===command.ownerClipId);
  if(!choice||choice.reason||choice.durationFrames===null)fail('設定を引き継ぐ使用箇所を選択してください');
  const at=command.atFrame??candidate.placement.frame;
  if(at===null||at>document.sequenceEndFrame)fail('復元用の範囲を置く位置を選択してください');
  const next=structuredClone(document),id=fresh('source-gap'),link=choice.mediaOwnerIds.length>1?fresh('source-gap-link'):undefined;
  const clips:SequenceClip[]=choice.mediaOwnerIds.map(ownerId=>{
    const owner=document.clips.find(clip=>clip.id===ownerId);
    if(!owner||(owner.content.kind!=='video'&&owner.content.kind!=='audio'))return fail('設定を引き継ぐ素材が見つかりません');
    const content=owner.content;
    const media=candidate.media.find(item=>item.continuationGroupId===owner.continuationGroupId&&item.assetId===content.assetId&&item.streamIndex===content.streamIndex);
    if(!media)return fail('元映像と使用箇所の対応を確認できません');
    const delta=multiplyTime(divideTime(subtractTime(media.source.start,owner.content.sourceIn),owner.content.rate),document.fps);
    const duration=ceilTime(multiplyTime(divideTime(subtractTime(media.source.end,media.source.start),owner.content.rate),document.fps));
    if(duration!==choice.durationFrames)return fail('映像と原音の復元する長さが一致しません');
    const clip=structuredClone(owner);clip.id=fresh('source-gap-clip');clip.startFrame=0;clip.durationFrames=duration;
    clip.clock.offset=addTime(owner.clock.offset,multiplyTime(delta,owner.clock.rate));
    if(clip.content.kind==='video'||clip.content.kind==='audio')clip.content.sourceIn=structuredClone(media.source.start);
    if(clip.visual?.keyframeClock&&owner.visual?.keyframeClock)
      clip.visual.keyframeClock.offset=addTime(owner.visual.keyframeClock.offset,multiplyTime(delta,owner.visual.keyframeClock.rate));
    if(link)clip.linkGroupId=link;else delete clip.linkGroupId;
    return clip;
  });
  const entry:CutArchiveEntry={id,durationFrames:choice.durationFrames,completionFloorFrames:choice.durationFrames,
    origin:{cutId:id,startFrame:0,endFrame:choice.durationFrames},boundary:cutBoundaryAt(next,at),clips,
    tracks:next.tracks.filter(track=>clips.some(clip=>clip.trackId===track.id)),
    sourceRecovery:{version:1,documentId:document.id,revision:document.revision,ownerClipIds:[...choice.mediaOwnerIds],
      sources:candidate.media.map(media=>({assetId:media.assetId,streamIndex:media.streamIndex,...structuredClone(media.source)}))}};
  next.cutArchive??={version:1,entries:[]};next.cutArchive.entries.push(entry);return next;
}
