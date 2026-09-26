import {upgradeNativeSpeedOperations} from './speedOperationBasis';
import {isMediaContent,clipEnd,sourceTimeAt,type CutArchiveEntry,type SequenceClip,type SequenceDocument} from './model';
import {addTime,compareTime,divideTime,multiplyTime,subtractTime,rational,type Rational} from './time';
import {readArchivedCutGraph,resolveCutBoundary} from './cutArchive';
import {registerNativeSpeedMetadata,validateNativeSpeedMetadata} from './speedMetadata';

const usage=(clip:SequenceClip)=>clip.continuationGroupId??clip.id;
const equal=(a:Rational,b:Rational)=>compareTime(a,b)===0;
/** Identity lineage is necessary; matching asset names or source ranges alone never assigns a role. */
function sameSourceClock(saved:SequenceClip,live:SequenceClip,fps:Rational):boolean {
 if(!isMediaContent(saved.content)||!isMediaContent(live.content)||saved.content.kind!==live.content.kind
  ||saved.content.assetId!==live.content.assetId||saved.content.streamIndex!==live.content.streamIndex
  ||!equal(saved.content.rate,live.content.rate)||!!saved.insertOwnSpeed!==!!live.insertOwnSpeed)return false;
 const source=saved.content,peerSource=live.content;
 const clock=(a:SequenceClip['clock'],b:SequenceClip['clock'])=>equal(a.duration,b.duration)&&equal(a.rate,b.rate)
  &&equal(subtractTime(a.offset,multiplyTime(multiplyTime(source.sourceIn,fps),divideTime(a.rate,source.rate))),
   subtractTime(b.offset,multiplyTime(multiplyTime(peerSource.sourceIn,fps),divideTime(b.rate,peerSource.rate))));
 if(!clock(saved.clock,live.clock)||!!saved.visual?.keyframeClock!==!!live.visual?.keyframeClock)return false;
 if(saved.visual?.keyframeClock&&live.visual?.keyframeClock&&!clock(saved.visual.keyframeClock,live.visual.keyframeClock))return false;
 const savedEnd=addTime(saved.content.sourceIn,divideTime(multiplyTime(rational(saved.durationFrames),saved.content.rate),fps));
 const liveEnd=addTime(live.content.sourceIn,divideTime(multiplyTime(rational(live.durationFrames),live.content.rate),fps));
 return compareTime(savedEnd,live.content.sourceIn)<=0||compareTime(liveEnd,saved.content.sourceIn)<=0;
}

/** A new native cut can remove the old seam's live endpoint. Only the adjacent
 * ordered native band, already registered from that same live occurrence, may
 * supply it. Matching source bytes in an unrelated archive is not a witness. */
function archivedWitness(registered:SequenceDocument,entry:CutArchiveEntry,live:SequenceClip,witness:NonNullable<SequenceClip['legacyMainRole']>['witnesses'][number]):SequenceClip|undefined {
 const group=registered.cutArchive?.groups?.find(g=>g.entryIds.includes(entry.id));
 if(!group)return;
 const index=group.entryIds.indexOf(entry.id),neighborId=group.entryIds[index+(witness.edge==='end'?-1:1)];
 const neighbor=registered.cutArchive!.entries.find(e=>e.id===neighborId);
 if(!neighbor||neighbor.legacyRecovery||neighbor.sourceRecovery||!neighbor.speed||neighbor.speed.groupId!==registered.speed?.groupId)return;
 const seam=resolveCutBoundary(registered,entry).frame;
 if(seam===null||resolveCutBoundary(registered,neighbor).frame!==seam)return;
 const candidates=neighbor.clips.filter(saved=>usage(saved)===usage(live)&&saved.speed?.kind===witness.kind
  &&sameSourceClock(saved,live,registered.fps)
  &&(witness.edge==='end'?clipEnd(saved)===neighbor.durationFrames:saved.startFrame===0)
  &&equal(sourceTimeAt(saved,witness.edge==='end'?clipEnd(saved):saved.startFrame,registered.fps),witness.sourceTime));
 if(candidates.length!==1)return;
 const saved=candidates[0]!;
 if(saved.speed?.kind==='main-audio'){
  const provider=neighbor.clips.find(c=>c.id===(saved.speed?.kind==='main-audio'?saved.speed.providerId:undefined));
  const liveProvider=registered.clips.find(c=>c.id===witness.providerId);
  if(!provider||!liveProvider||provider.speed?.kind!=='main'||usage(provider)!==usage(liveProvider)
   ||!provider.linkGroupId||provider.linkGroupId!==saved.linkGroupId)return;
 }
 return saved;
}


/** Initial migration records the concrete main graph and boundary AV witnesses.
 * This path never infers a legacy role from a matching asset or source interval. */
export function registerLegacyRoles(before:SequenceDocument,registered:SequenceDocument,entry:CutArchiveEntry):SequenceDocument|undefined {
 if(!entry.legacyRecovery||before.legacy?.sourceFingerprint!==entry.legacyRecovery.sourceFingerprint)return;
 const roles=entry.clips.filter(c=>c.legacyMainRole),mains=roles.filter(c=>c.legacyMainRole!.kind==='main');
 if(!mains.length||roles.some(c=>c.legacyMainRole!.sourceFingerprint!==entry.legacyRecovery!.sourceFingerprint))return;
 for(const saved of roles){const proof=saved.legacyMainRole!;
  if(!proof.witnesses.length)return;
  for(const witness of proof.witnesses){
   const c=registered.clips.find(c=>c.id===witness.clipId),source=c?.content,s=c?.speed;
   if(!c||!source||!isMediaContent(source)||!s||s.kind!==witness.kind||source.assetId!==witness.assetId||source.streamIndex!==witness.streamIndex
    ||!equal(source.rate,witness.rate))return;
   if(s.kind==='main-audio'){const provider=registered.clips.find(v=>v.id===witness.providerId);
    if(s.providerId!==witness.providerId||!provider?.linkGroupId||provider.linkGroupId!==c.linkGroupId)return;}
   if(!equal(sourceTimeAt(c,witness.edge==='start'?c.startFrame:clipEnd(c),before.fps),witness.sourceTime)
    &&!archivedWitness(registered,entry,c,witness))return;
  }
 }
 const bindings=roles.filter(c=>c.legacyMainRole!.kind==='main-audio').map(c=>({audioClipId:c.id,providerId:c.legacyMainRole!.providerId!}));
 if(bindings.some(b=>!mains.some(c=>c.id===b.providerId)))return;
 const graph=registerNativeSpeedMetadata(readArchivedCutGraph(before,entry),{type:'register-native-speed',groupId:registered.speed!.groupId,mainClipIds:mains.sort((a,b)=>a.startFrame-b.startFrame).map(c=>c.id),mainAudioBindings:bindings});
 // The deleted legacy window uses the recorded global defaults, not a nearby
 // surviving segment's per-piece override.
 graph.speed!.globalRate=structuredClone(registered.speed!.globalRate);
 for(const c of graph.clips)if(c.speed?.kind==='main'&&isMediaContent(c.content)){
  if(equal(c.content.rate,graph.speed!.globalRate))delete c.speed.override;else c.speed.override=structuredClone(c.content.rate);
 }
 validateNativeSpeedMetadata(graph);return upgradeNativeSpeedOperations(graph);
}

/** Extend the user's explicit live registration only over provable pieces of the
 * same saved usage. Unknown/contradictory bands remain unregistered and reject
 * restoration; registering an unrelated live video does not resolve their role. */
export function registerProvenCutRoles(before:SequenceDocument,registered:SequenceDocument):SequenceDocument {
 if(before.speed||!registered.speed||!before.cutArchive)return registered;
 const next=structuredClone(registered);let attached=false;const legacy:CutArchiveEntry[]=[];
 for(const entry of next.cutArchive!.entries){
  if(entry.speed||entry.insertOwnSpeed||resolveCutBoundary(before,entry).frame===null)continue;
  if(entry.legacyRecovery){legacy.push(entry);continue;}
  const boundaryIds=new Set(entry.boundary.references.map(ref=>ref.clipId));
  const owners=new Map<string,SequenceClip>();let unknown=false;
  for(const saved of entry.clips.filter(c=>isMediaContent(c.content))){
   const peers=registered.clips.filter(c=>usage(c)===usage(saved));
   // A current explicit boundary reference rules out a detached/reused identity.
   if(!peers.length||!peers.some(c=>boundaryIds.has(c.id))||peers.some(c=>!sameSourceClock(saved,c,before.fps))){unknown=true;break;}
   const kinds=new Set(peers.map(c=>c.speed?.kind??'fixed'));
   if(kinds.size!==1||peers.some(c=>c.insertOwnSpeed)){unknown=true;break;}
   owners.set(saved.id,peers[0]!);
  }
  if(unknown)continue;
  const mains=entry.clips.filter(c=>owners.get(c.id)?.speed?.kind==='main').sort((a,b)=>a.startFrame-b.startFrame);
  // An empty main series has no registration command in the current UI. Do not
  // invent a speed basis for a fully deleted or purely fixed historical band.
  if(!mains.length)continue;
  const bindings:Array<{audioClipId:string;providerId:string}>=[];
  for(const saved of entry.clips.filter(c=>owners.get(c.id)?.speed?.kind==='main-audio')){
   const live=owners.get(saved.id)!,metadata=live.speed,provider=metadata?.kind==='main-audio'?registered.clips.find(c=>c.id===metadata.providerId):undefined;
   const matches=mains.filter(c=>provider&&usage(c)===usage(provider)&&c.linkGroupId&&c.linkGroupId===saved.linkGroupId&&c.startFrame===saved.startFrame&&c.durationFrames===saved.durationFrames);
   if(matches.length!==1){unknown=true;break;}bindings.push({audioClipId:saved.id,providerId:matches[0]!.id});
  }
  if(unknown)continue;
  // Unlinking the live AV does not rewrite the saved editing link. A saved
  // main can only acquire its role when every linked member has the matching
  // explicit audio binding; otherwise keep this band unregistered, without
  // rejecting the user's independently valid live registration.
  if(mains.some(main=>main.linkGroupId&&entry.clips.some(member=>member.id!==main.id
   &&member.linkGroupId===main.linkGroupId
   &&!bindings.some(binding=>binding.audioClipId===member.id&&binding.providerId===main.id))))continue;
  const graph=registerNativeSpeedMetadata(readArchivedCutGraph(before,entry),{type:'register-native-speed',groupId:registered.speed.groupId,mainClipIds:mains.map(c=>c.id),mainAudioBindings:bindings});
  // Registration captures the selected roles, not a new rate. Mixed live rates
  // use the same explicit overrides while every saved source/effect clock stays intact.
  graph.speed!.globalRate=structuredClone(registered.speed.globalRate);
  for(const clip of graph.clips){if(clip.speed?.kind!=='main')continue;const owner=owners.get(clip.id)!;if(owner.speed?.kind!=='main')continue;
   if(owner.speed.override)clip.speed.override=structuredClone(owner.speed.override);else delete clip.speed.override;
  }
  validateNativeSpeedMetadata(graph);
  const ready=upgradeNativeSpeedOperations(graph);
  entry.clips=ready.clips;entry.speed=ready.speed;attached=true;
 }
 // Native pieces acquire roles from live selections first. Legacy bands may
 // then use their concrete saved endpoints, independent of storage order.
 for(const entry of legacy){const graph=registerLegacyRoles(before,next,entry);if(graph){entry.clips=graph.clips;entry.speed=graph.speed;attached=true;}}
 return attached?upgradeNativeSpeedOperations(next):next;
}
