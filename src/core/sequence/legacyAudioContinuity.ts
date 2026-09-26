import {clipEnd,effectFrameAt,sourceTimeAt,type SequenceClip,type SequenceDocument} from './model';
import {addTime,subtractTime,multiplyTime,divideTime,compareTime,rational,type Rational} from './time';

type AudioClip=SequenceClip&{content:Extract<SequenceClip['content'],{kind:'audio'}>};
const audio=(c:SequenceClip):c is AudioClip=>c.content.kind==='audio';
const equal=(a:Rational,b:Rational)=>compareTime(a,b)===0;

/** A native snapshot made before an old band is restored can still carry the
 * original clip ID instead of a continuation marker. Preserve that explicit
 * legacy music identity when allocating its fresh restored render ID. */
export function legacyAudioPolicyForRestore(document:SequenceDocument,clip:SequenceClip):SequenceClip['legacyAudioContinuity'] {
 if(clip.legacyAudioContinuity)return clip.legacyAudioContinuity;
 if(!audio(clip)||!document.legacy)return;
 const owner=clip.continuationGroupId??clip.id,fingerprint=document.legacy.sourceFingerprint;
 for(const entry of document.cutArchive?.entries??[]){
  if(entry.legacyRecovery?.sourceFingerprint!==fingerprint)continue;
  for(const saved of entry.clips){const policy=saved.legacyAudioContinuity;
   if(!audio(saved)||!policy||policy.sourceFingerprint!==fingerprint||policy.ownerClipId!==owner
    ||saved.content.assetId!==clip.content.assetId||saved.content.streamIndex!==clip.content.streamIndex||saved.content.role!==clip.content.role)continue;
   return {version:1,sourceFingerprint:fingerprint,ownerClipId:owner};
  }
 }
}

/** Only a saved legacy policy can extend a continuous soundtrack. Ordinary native
 * deletion snapshots always retain their recorded source windows. */
export function planLegacyAudioContinuation(before:SequenceDocument,entryId:string,joined:SequenceDocument,restored:Set<string>,offset:number,
 insertionPoint:(trackId:string)=>number): (next:SequenceDocument)=>void {
 const plans:Array<{owner:string;restoredId:string;start:number;end:number;duration:number;source:Rational;effect:Rational;
  sourceDelta:Rational;effectDelta:Rational;clockDuration:Rational;clockRate:Rational;rate:Rational;settings:AudioClip['content']['settings'];members:Set<string>;bridge:number;policy:NonNullable<SequenceClip['legacyAudioContinuity']>;oldEffect:Rational;oldSource:Rational}>=[];
 for(const saved of joined.clips.filter(c=>restored.has(c.id)&&c.legacyAudioContinuity&&audio(c)) as AudioClip[]){
  const policy=saved.legacyAudioContinuity!;
  if(before.legacy?.sourceFingerprint!==policy.sourceFingerprint)continue;
  const owner=policy.ownerClipId;
  const all=before.clips.filter(c=>c.id===owner||c.continuationGroupId===owner);
  const chain=all.filter(audio).sort((a,b)=>a.startFrame-b.startFrame);
  const point=insertionPoint(saved.trackId),start=saved.startFrame-offset+point,end=start+saved.durationFrames;
  if(all.length!==chain.length)continue;
  const first=chain[0],last=chain.at(-1);
  const bridge=policy.leftClampBridge&&saved.startFrame===offset&&last&&clipEnd(last)===point-1?1:0;
  const phasePoint=point-bridge;
  if(first){
   // Source/effect affine is independent of timeline gaps left by native cuts.
   // A separately edited source offset/rate or reordered usage cannot be inferred.
   const slope=divideTime(first.content.rate,multiplyTime(before.fps,first.clock.rate));
   const base=subtractTime(first.content.sourceIn,multiplyTime(first.clock.offset,slope));
   if(chain.some((c,i)=>c.trackId!==saved.trackId||c.speed||c.insertOwnSpeed||c.content.assetId!==saved.content.assetId
     ||c.content.streamIndex!==saved.content.streamIndex||c.content.role!==saved.content.role||c.content.loop!==first.content.loop
     ||!equal(c.content.rate,first.content.rate)||!equal(c.clock.rate,first.clock.rate)||!equal(c.clock.duration,first.clock.duration)
     ||!equal(subtractTime(c.content.sourceIn,multiplyTime(c.clock.offset,slope)),base)
     ||i>0&&(clipEnd(chain[i-1]!)>c.startFrame||compareTime(effectFrameAt(chain[i-1]!,clipEnd(chain[i-1]!)),c.clock.offset)>0)))continue;
   if(phasePoint<first.startFrame||phasePoint>clipEnd(chain.at(-1)!))continue;
  }
  const anchor=chain.find(c=>c.startFrame<=phasePoint&&phasePoint<clipEnd(c))??chain.find(c=>clipEnd(c)===phasePoint);
  if(chain.length&&!anchor)continue;
  let phaseSource=anchor?sourceTimeAt(anchor,phasePoint,before.fps):rational(0),phaseEffect=anchor?effectFrameAt(anchor,phasePoint):rational(0);
  // A native cut spanning this old band can leave no live sample at its original
  // music phase. The explicit archive group still owns that order; use its
  // adjacent native fragment edge, never the right live piece across the gap.
  const group=before.cutArchive?.groups?.find(g=>g.entryIds.includes(entryId)),index=group?.entryIds.indexOf(entryId)??-1;
  if(anchor&&group){
   const candidates=[{id:group.entryIds[index-1],end:true},{id:group.entryIds[index+1],end:false}].flatMap(edge=>{
    const band=before.cutArchive!.entries.find(e=>e.id===edge.id);if(!band||band.legacyRecovery)return [];
    return band.clips.filter(c=>audio(c)&&(c.id===owner||c.continuationGroupId===owner)).flatMap(c=>{
     if(!audio(c)||c.content.assetId!==anchor.content.assetId||c.content.streamIndex!==anchor.content.streamIndex||!equal(c.content.rate,anchor.content.rate)||!equal(c.clock.rate,anchor.clock.rate))return [];
     const expected=addTime(phaseSource,multiplyTime(divideTime(subtractTime(c.clock.offset,phaseEffect),multiplyTime(before.fps,anchor.clock.rate)),anchor.content.rate));
     if(!equal(c.content.sourceIn,expected))return [];
     const f=edge.end?clipEnd(c):c.startFrame;return [{source:sourceTimeAt(c,f,before.fps),effect:effectFrameAt(c,f)}];
    });
   });
   if(candidates.length&&candidates.every(c=>equal(c.source,candidates[0]!.source)&&equal(c.effect,candidates[0]!.effect))){phaseSource=candidates[0]!.source;phaseEffect=candidates[0]!.effect;}
  }
  const rate=anchor?.content.rate??saved.content.rate,clockRate=anchor?.clock.rate??saved.clock.rate;
  const sourceDelta=multiplyTime(divideTime(rational(saved.durationFrames+bridge),before.fps),rate);
  const effectDelta=multiplyTime(rational(saved.durationFrames+bridge),clockRate);
  plans.push({owner,restoredId:saved.id,start,end,duration:saved.durationFrames,
   source:phaseSource,effect:phaseEffect,
   sourceDelta,effectDelta,clockDuration:anchor?addTime(anchor.clock.duration,effectDelta):effectDelta,clockRate,rate,
   settings:structuredClone(anchor?.content.settings??saved.content.settings),members:new Set(chain.map(c=>c.id)),bridge,policy,oldEffect:phaseEffect,oldSource:phaseSource});
 }
 return next=>{
  for(const plan of plans){
   for(const c of next.clips){if(!audio(c))continue;
    if(c.id===plan.restoredId){
     c.startFrame-=plan.bridge;c.durationFrames+=plan.bridge;
     c.content.sourceIn=plan.source;c.content.rate=plan.rate;c.content.settings=structuredClone(plan.settings);
     c.clock={offset:plan.effect,rate:plan.clockRate,duration:plan.clockDuration};c.continuationGroupId=plan.owner;
    }else if(plan.members.has(c.id)||c.continuationGroupId===plan.owner){
     // Existing source gaps/manual gain are preserved; only the inserted duration
     // is added to subsequent pieces of the proven occurrence.
     if(c.startFrame>=plan.end){c.content.sourceIn=addTime(c.content.sourceIn,plan.sourceDelta);c.clock.offset=addTime(c.clock.offset,plan.effectDelta);}
     c.clock.duration=plan.clockDuration;c.legacyAudioContinuity=structuredClone(plan.policy);
    }
   }
   for(const e of next.cutArchive?.entries??[]){if(e.legacyRecovery)continue;
    for(const c of e.clips){if(!audio(c)||(c.id!==plan.owner&&c.continuationGroupId!==plan.owner))continue;
     const same=next.clips.find(x=>x.id===plan.restoredId);if(!same||!audio(same)||c.content.assetId!==same.content.assetId||c.content.streamIndex!==same.content.streamIndex||!equal(c.content.rate,plan.rate)||!equal(c.clock.rate,plan.clockRate))continue;
     const expected=addTime(plan.oldSource,multiplyTime(divideTime(subtractTime(c.clock.offset,plan.oldEffect),multiplyTime(before.fps,plan.clockRate)),plan.rate));
     if(!equal(c.content.sourceIn,expected))continue;
     if(compareTime(c.clock.offset,plan.oldEffect)>=0){c.clock.offset=addTime(c.clock.offset,plan.effectDelta);c.content.sourceIn=addTime(c.content.sourceIn,plan.sourceDelta);}
     c.clock.duration=plan.clockDuration;c.legacyAudioContinuity=structuredClone(plan.policy);
    }
   }
  }
 };
}
