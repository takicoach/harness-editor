import {SequenceError} from './errors';
import {clipEnd,effectFrameAt,isMediaContent,sourceTimeAt,type CutArchiveEntry,type SequenceDocument} from './model';
import {compareTime} from './time';
import {registerLegacyRoles} from './cutRegistration';

/** Server-only payload, deliberately absent from the public command allowlist. */
export interface AdoptLegacyCutHistoryCommand {
 type:'adopt-legacy-cut-history';sourceFingerprint:string;entries:CutArchiveEntry[];
}
function fail(message:string):never{throw new SequenceError('INVALID_DOCUMENT',message);}
export function assertLegacyCutHistoryEligible(document:SequenceDocument,sourceFingerprint:string):void{
 if(!document.legacy||document.legacy.sourceFingerprint!==sourceFingerprint||!/^[a-f0-9]{64}$/.test(sourceFingerprint))fail('この案件の移行元と旧編集データが一致しません');
 if(document.legacy.cutHistoryImport||document.cutArchive?.entries.some(e=>e.legacyRecovery?.sourceFingerprint===sourceFingerprint))fail('この旧カットは引き継ぎ済みです');
 if(document.insertOwnSpeed)fail('素材ごとの速度登録済み案件では、旧保存帯の役割を確認してから引き継いでください');
}

/** Compare explicit migrated occurrences; source equality alone never identifies a use. */
export function buildLegacyCutHistoryCommand(current:SequenceDocument,baseline:SequenceDocument,reconstructed:SequenceDocument):AdoptLegacyCutHistoryCommand {
 const fingerprint=baseline.legacy?.sourceFingerprint??'';
 assertLegacyCutHistoryEligible(current,fingerprint);
 if(current.id!==baseline.id||reconstructed.id!==baseline.id||current.legacy!.primaryAssetId!==baseline.legacy!.primaryAssetId||compareTime(current.fps,baseline.fps)!==0)fail('移行時の案件・素材・フレーム基準が一致しません');
 const entries=structuredClone(reconstructed.cutArchive?.entries??[]);
 for(const entry of entries){
  let ambiguous=entry.boundary.ambiguous;const references:CutArchiveEntry['boundary']['references']=[];
  const owners=new Map<string,SequenceDocument['clips'][number]>();
  for(const ref of entry.boundary.references){
   const original=baseline.clips.find(c=>c.id===ref.clipId);
   if(!original||!isMediaContent(original.content)){ambiguous=true;continue;}
   const originalContent=original.content,originalEdge=ref.edge==='start'?original.startFrame:clipEnd(original);
   const matches=current.clips.filter(c=>{
    if(c.id!==original.id&&c.continuationGroupId!==(original.continuationGroupId??original.id))return false;
    if(!isMediaContent(c.content)||c.content.kind!==originalContent.kind||c.content.assetId!==originalContent.assetId||c.content.streamIndex!==originalContent.streamIndex)return false;
    if(compareTime(c.content.rate,originalContent.rate)!==0&&(!current.speed||c.speed?.kind!==(originalContent.kind==='video'?'main':'main-audio')))return false;
    const edge=ref.edge==='start'?c.startFrame:clipEnd(c);
    return compareTime(sourceTimeAt(c,edge,current.fps),sourceTimeAt(original,originalEdge,baseline.fps))===0
      &&compareTime(effectFrameAt(c,edge),effectFrameAt(original,originalEdge))===0
      &&compareTime(sourceTimeAt(c,c.startFrame,current.fps),sourceTimeAt(original,original.startFrame,baseline.fps))>=0
      &&compareTime(sourceTimeAt(c,clipEnd(c),current.fps),sourceTimeAt(original,clipEnd(original),baseline.fps))<=0;
   });
   if(matches.length!==1){ambiguous=true;continue;}
   owners.set(original.id,matches[0]!);
   references.push({...ref,clipId:matches[0]!.id});
  }
  const points=references.map(ref=>{const c=current.clips.find(c=>c.id===ref.clipId)!;return (ref.edge==='start'?c.startFrame:clipEnd(c))+ref.offsetFrames;});
  // Empty historic main and an edited empty current graph are not a saved placement history.
  if(!points.length||points.some(p=>p!==points[0]||p<0||p>current.sequenceEndFrame))ambiguous=true;
  entry.boundary={references,ambiguous,hintFrame:points[0]??entry.boundary.hintFrame};
  // Keep the concrete original-edge proof when a later split changed its live ID.
  // Rates may change only through the explicitly registered roles checked above.
  for(const clip of entry.clips)if(clip.legacyMainRole)for(const witness of clip.legacyMainRole.witnesses){
   const owner=owners.get(witness.clipId);if(!owner||!isMediaContent(owner.content))continue;
   witness.clipId=owner.id;witness.rate=structuredClone(owner.content.rate);
   if(witness.providerId)witness.providerId=owners.get(witness.providerId)?.id??witness.providerId;
  }
 }
 return {type:'adopt-legacy-cut-history',sourceFingerprint:fingerprint,entries};
}

export function adoptLegacyCutHistory(document:SequenceDocument,command:AdoptLegacyCutHistoryCommand,fresh:(prefix:string)=>string):SequenceDocument {
 assertLegacyCutHistoryEligible(document,command.sourceFingerprint);
 if(!Array.isArray(command.entries))fail('旧カットの確認結果が不正です');
 const next=structuredClone(document),entries=structuredClone(command.entries);
 for(const entry of entries){
  if(entry.legacyRecovery?.sourceFingerprint!==command.sourceFingerprint||entry.sourceRecovery||entry.speed||entry.insertOwnSpeed)fail('旧カットの出典または速度基準が一致しません');
  const ids=new Map<string,string>();const mapped=(id:string)=>{let value=ids.get(id);if(!value){value=fresh('legacy-history');ids.set(id,value);}return value;};
  entry.id=mapped(entry.id);entry.origin.cutId=mapped(entry.origin.cutId);
  for(const c of entry.clips){c.id=mapped(c.id);if(c.linkGroupId)c.linkGroupId=mapped(c.linkGroupId);if(c.continuationGroupId)c.continuationGroupId=mapped(c.continuationGroupId);}
  // Archived AV providers are local identities; witnesses and music owners
  // still refer to the current live graph and must not be allocated fresh IDs.
  for(const c of entry.clips)if(c.legacyMainRole?.providerId){const provider=ids.get(c.legacyMainRole.providerId);if(!provider)fail('旧原音の主映像が保存帯にありません');c.legacyMainRole.providerId=provider;}
  for(const c of entry.clips)if(c.anchor?.kind==='source'){const id=ids.get(c.anchor.clipOccurrenceId);if(!id)fail('旧字幕の原音使用箇所が保存帯にありません');c.anchor.clipOccurrenceId=id;}
 }
 if(entries.length)next.cutArchive={version:1,...next.cutArchive,entries:[...(next.cutArchive?.entries??[]),...entries]};
 if(next.speed)for(const entry of entries){
  if(entry.boundary.ambiguous)continue;
  // Capture the old global-default basis, then let normal restore projection
  // apply today's rate. Assigning today's rate here would freeze the old rate
  // as an override and make restoration play at the wrong speed.
  const proof={...next,speed:{...next.speed,globalRate:entry.legacyRecovery!.mainRate}};
  const graph=registerLegacyRoles(next,proof,entry);
  // As with registering already imported bands, preserve an unproven band
  // without assigning roles to it. Its restore still rejects the missing
  // speed basis, while independently proven bands remain available.
  if(!graph)continue;
  entry.clips=graph.clips;entry.speed=graph.speed;
 }
 next.legacy!.cutHistoryImport={version:1,sourceFingerprint:command.sourceFingerprint};
 return next;
}
