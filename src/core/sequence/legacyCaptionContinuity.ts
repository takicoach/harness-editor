import {isMediaContent,type EffectClock,type SequenceClip,type SequenceDocument,type SpeedCaptionLedger,type SpeedCaptionPart} from './model';
import {addTime,compareTime,divideTime,multiplyTime,rational,subtractTime,type Rational} from './time';
import {captionLedgers,materializeSpeedCaptions,refreshCaptionBaselines} from './speedCaptionLedger';
type Policy=NonNullable<SequenceClip['legacyCaptionContinuity']>;
type Witness=Policy['witnesses'][number];
const equal=(a:Rational,b:Rational)=>compareTime(a,b)===0;
function registeredPart(doc:SequenceDocument,id:string):{ledger:SpeedCaptionLedger;part:SpeedCaptionPart}|undefined {
 for(const ledger of captionLedgers(doc)){const part=ledger.parts.find(p=>p.reservedRenderId===id);if(part)return {ledger,part};}
}
export function legacyCaptionWitness(doc:SequenceDocument,c:SequenceClip):Witness|undefined {
 const a=c.anchor;if(c.content.kind!=='telop'||a?.kind!=='source')return;
 const p=doc.clips.find(x=>x.id===a.clipOccurrenceId);if(!p||!isMediaContent(p.content))return;
 const registered=registeredPart(doc,c.id),sourceStart=registered?.part.intentStart??a.sourceStart,sourceEnd=registered?.part.intentEnd??a.sourceEnd;
 const basis=(clock:EffectClock)=>{
  const slope=divideTime(clock.rate,p.content.kind==='audio'||p.content.kind==='video'?p.content.rate:rational(1));
  return {offset:addTime(clock.offset,multiplyTime(multiplyTime(subtractTime(sourceStart,a.sourceStart),doc.speed?.fpsBasis??doc.fps),slope)),slope,duration:structuredClone(clock.duration)};
 };
 return {clipId:c.id,assetId:p.content.assetId,streamIndex:p.content.streamIndex,role:a.role,sourceStart:structuredClone(sourceStart),sourceEnd:structuredClone(sourceEnd),clock:basis(c.clock),...(c.visual?.keyframeClock?{keyframeClock:basis(c.visual.keyframeClock)}:{})};
}
/** Include latent reserved parts as metadata-only candidates, never live clips. */
function captionCandidates(doc:SequenceDocument):SequenceClip[]{
 const result=[...doc.clips];
 for(const ledger of captionLedgers(doc))for(const part of ledger.parts){
  if(result.some(c=>c.id===part.reservedRenderId))continue;
  const provider=doc.clips.find(c=>c.id===part.providerId);if(!provider||!isMediaContent(provider.content))continue;
  const current=(clock:SpeedCaptionLedger['clock'])=>({offset:addTime(clock.offset,multiplyTime(multiplyTime(subtractTime(part.intentStart,ledger.sourceOrigin),doc.speed?.fpsBasis??doc.fps),clock.slope)),rate:multiplyTime(clock.slope,provider.content.kind==='audio'||provider.content.kind==='video'?provider.content.rate:rational(1)),duration:structuredClone(clock.duration)});
  const template=structuredClone(part.presentation?.template??ledger.template);if(template.visual&&ledger.keyframeClock)template.visual.keyframeClock=current(ledger.keyframeClock);
  result.push({...template,id:part.reservedRenderId,startFrame:0,durationFrames:0,clock:current(ledger.clock),...(part.continuationGroupId?{continuationGroupId:part.continuationGroupId}:{}),anchor:{kind:'source',role:ledger.role,sourceAssetId:provider.content.assetId,clipOccurrenceId:provider.id,sourceStart:part.intentStart,sourceEnd:part.intentEnd}});
 }
 return result;
}
function captionFamilyIds(doc:SequenceDocument,policy:Policy):Set<string>{
 const ids=new Set([policy.ownerClipId,...policy.witnesses.map(w=>w.clipId)]);
 for(const ledger of captionLedgers(doc))if(ids.has(ledger.captionId)||ledger.parts.some(p=>ids.has(p.reservedRenderId))||ledger.template.legacyCaptionContinuity?.ownerClipId===policy.ownerClipId&&ledger.template.legacyCaptionContinuity.sourceFingerprint===policy.sourceFingerprint){for(const part of ledger.parts)ids.add(part.reservedRenderId);}
 return ids;
}
/** The caller supplies the exact old subtitle ID; filenames never identify a usage. */
export function legacyCaptionPolicy(doc:SequenceDocument,ownerClipId:string):Policy|undefined {
 if(!doc.legacy)return;
 const members=doc.clips.filter(c=>c.id===ownerClipId||c.continuationGroupId===ownerClipId);
 const witnesses=members.flatMap(c=>{const w=legacyCaptionWitness(doc,c);return w?[w]:[];});
 if(witnesses.length!==members.length)return;
 return {version:1,sourceFingerprint:doc.legacy.sourceFingerprint,ownerClipId,witnesses};
}
function matches(doc:SequenceDocument,c:SequenceClip,w:Witness):boolean {
 const current=legacyCaptionWitness(doc,c);if(!current||compareTime(current.sourceStart,w.sourceStart)<0||compareTime(current.sourceEnd,w.sourceEnd)>0||current.assetId!==w.assetId||current.streamIndex!==w.streamIndex||current.role!==w.role)return false;
 const units=multiplyTime(subtractTime(current.sourceStart,w.sourceStart),doc.speed?.fpsBasis??doc.fps);
 const clock=(actual:Witness['clock']|undefined,expected:Witness['clock']|undefined)=>!actual||!expected?actual===expected:
  equal(actual.offset,addTime(expected.offset,multiplyTime(units,expected.slope)))&&equal(actual.slope,expected.slope)&&equal(actual.duration,expected.duration);
 return clock(current.clock,w.clock)&&clock(current.keyframeClock,w.keyframeClock);
}
/** A native fragment may be restored before the old band that owns its clock
 * proof. Carry only a matching explicit witness through fresh ID allocation. */
export function inheritLegacyCaptionPolicy(graph:SequenceDocument,current:SequenceDocument):void {
 const policies=current.cutArchive?.entries.filter(e=>e.legacyRecovery).flatMap(e=>e.clips.flatMap(c=>c.legacyCaptionContinuity?[{clip:c,policy:c.legacyCaptionContinuity}]:[]))??[];
 for(const c of graph.clips){if(c.legacyCaptionContinuity||c.content.kind!=='telop'||c.anchor?.kind!=='source')continue;
  const choices=policies.filter(({clip,policy})=>policy.sourceFingerprint===current.legacy?.sourceFingerprint&&clip.content.kind==='telop'&&c.content.kind==='telop'&&clip.content.legacyId===c.content.legacyId
   &&clip.anchor?.kind==='source'&&c.anchor?.kind==='source'&&clip.anchor.sourceAssetId===c.anchor.sourceAssetId
   &&policy.witnesses.some(w=>(w.clipId===c.id||w.clipId===c.continuationGroupId||c.continuationGroupId===policy.ownerClipId)&&matches(graph,c,w)));
  const owners=new Set(choices.map(x=>x.policy.ownerClipId));if(owners.size===1)c.legacyCaptionContinuity={...structuredClone(choices[0]!.policy),witnesses:[legacyCaptionWitness(graph,c)!]};
 }
}
/** Extend only the demonstrably unedited clocks of this one migrated subtitle.
 * Text/style stay on their existing render owners. Manual clock changes opt out. */
export function planLegacyCaptionContinuation(before:SequenceDocument,joined:SequenceDocument,restored:Set<string>): (next:SequenceDocument)=>void {
 const plans:Array<{savedId:string;policy:Policy;members:Set<string>;phase:Rational;delta:Rational;duration:Rational;slope:Rational;sourceStart:Rational;sourceEnd:Rational;key?:{phase:Rational;delta:Rational;duration:Rational;slope:Rational}}>=[];
 for(const saved of joined.clips){
  const policy=saved.legacyCaptionContinuity,a=saved.anchor;
  if(!restored.has(saved.id)||!policy||policy.sourceFingerprint!==before.legacy?.sourceFingerprint||saved.content.kind!=='telop'||a?.kind!=='source')continue;
  const legacyId=saved.content.legacyId;
  const witnessIds=captionFamilyIds(before,policy),savedProof=legacyCaptionWitness(joined,saved);if(!savedProof)continue;
  const chain=captionCandidates(before).filter(c=>witnessIds.has(c.id)||!!c.continuationGroupId&&witnessIds.has(c.continuationGroupId)||c.legacyCaptionContinuity?.ownerClipId===policy.ownerClipId&&c.legacyCaptionContinuity.sourceFingerprint===policy.sourceFingerprint);
  if(chain.some(c=>c.content.kind!=='telop'||c.content.legacyId!==legacyId||c.anchor?.kind!=='source'||c.anchor.sourceAssetId!==a.sourceAssetId))continue;
  const ordered=chain.map(c=>({clip:c,proof:legacyCaptionWitness(before,c)}));if(ordered.some(x=>!x.proof))continue;
  ordered.sort((x,y)=>compareTime(x.proof!.sourceStart,y.proof!.sourceStart));
  if(ordered.some(({clip:c,proof},i)=>{
   const witnesses=c.legacyCaptionContinuity?.witnesses??policy.witnesses,previous=ordered[i-1]?.proof;
   return !witnesses.some(w=>matches(before,c,w))||!!previous&&compareTime(previous.sourceEnd,proof!.sourceStart)>0;
  }))continue;
  if(ordered.some(x=>compareTime(x.proof!.sourceStart,savedProof.sourceEnd)<0&&compareTime(x.proof!.sourceEnd,savedProof.sourceStart)>0))continue;
  const left=ordered.filter(x=>compareTime(x.proof!.sourceEnd,savedProof.sourceStart)<=0).at(-1)?.proof;
  const right=ordered.find(x=>compareTime(x.proof!.sourceStart,savedProof.sourceEnd)>=0)?.proof;
  const anchor=left??right,witness=anchor??savedProof;
  const span=multiplyTime(subtractTime(savedProof.sourceEnd,savedProof.sourceStart),before.speed?.fpsBasis??before.fps);
  const end=(w:Witness,clock:Witness['clock'])=>addTime(clock.offset,multiplyTime(multiplyTime(subtractTime(w.sourceEnd,w.sourceStart),before.speed?.fpsBasis??before.fps),clock.slope));
  const delta=multiplyTime(span,witness.clock.slope),phase=left?end(left,left.clock):right?right.clock.offset:rational(0),duration=anchor?addTime(anchor.clock.duration,delta):delta;
  const key=witness.keyframeClock?{phase:left?.keyframeClock?end(left,left.keyframeClock):right?.keyframeClock?.offset??rational(0),delta:multiplyTime(span,witness.keyframeClock.slope),duration:addTime(anchor?.keyframeClock?.duration??rational(0),multiplyTime(span,witness.keyframeClock.slope)),slope:witness.keyframeClock.slope}:undefined;
  plans.push({savedId:saved.id,policy,members:new Set(chain.map(c=>c.id)),phase,delta,duration,slope:witness.clock.slope,sourceStart:savedProof.sourceStart,sourceEnd:savedProof.sourceEnd,key});
 }
 return next=>{
  const changed=new Set<string>();
  for(const plan of plans){
   const own=(c:SequenceClip)=>c.id===plan.savedId||plan.members.has(c.id)||c.legacyCaptionContinuity?.ownerClipId===plan.policy.ownerClipId&&c.legacyCaptionContinuity.sourceFingerprint===plan.policy.sourceFingerprint;
   for(const c of next.clips){if(!own(c)||c.anchor?.kind!=='source')continue;
    const provider=next.clips.find(p=>c.anchor?.kind==='source'&&p.id===c.anchor.clipOccurrenceId);if(!provider||!isMediaContent(provider.content))continue;
    if(c.id===plan.savedId){c.clock.offset=addTime(plan.phase,multiplyTime(multiplyTime(subtractTime(c.anchor.sourceStart,plan.sourceStart),next.speed?.fpsBasis??next.fps),plan.slope));c.clock.rate=multiplyTime(plan.slope,provider.content.rate);}
    else if(compareTime(c.anchor.sourceStart,plan.sourceEnd)>=0)c.clock.offset=addTime(c.clock.offset,plan.delta);
    c.clock.duration=plan.duration;
    if(c.visual?.keyframeClock&&plan.key){if(c.id===plan.savedId){c.visual.keyframeClock.offset=addTime(plan.key.phase,multiplyTime(multiplyTime(subtractTime(c.anchor.sourceStart,plan.sourceStart),next.speed?.fpsBasis??next.fps),plan.key.slope));c.visual.keyframeClock.rate=multiplyTime(plan.key.slope,provider.content.rate);}else if(compareTime(c.anchor.sourceStart,plan.sourceEnd)>=0)c.visual.keyframeClock.offset=addTime(c.visual.keyframeClock.offset,plan.key.delta);c.visual.keyframeClock.duration=plan.key.duration;}
    const witness=legacyCaptionWitness(next,c)!;c.legacyCaptionContinuity={...structuredClone(plan.policy),witnesses:[witness]};changed.add(c.id);
   }
   // Native cuts preserve the old source window. Propagate this explicit old
   // insertion's clock map into those saved pieces as well, before they return.
   for(const entry of next.cutArchive?.entries??[]){if(entry.legacyRecovery)continue;
    const graph:SequenceDocument={...next,clips:entry.clips,tracks:entry.tracks,sequenceEndFrame:entry.durationFrames,speed:entry.speed,insertOwnSpeed:entry.insertOwnSpeed,cutArchive:undefined};
    const archivedChanged=new Set<string>();
    for(const c of entry.clips){
     const a=c.anchor;if(c.content.kind!=='telop'||a?.kind!=='source')continue;
     const policy=c.legacyCaptionContinuity;
     const witnesses=policy?.ownerClipId===plan.policy.ownerClipId?policy.witnesses:plan.policy.witnesses;
     if(!witnesses.some(w=>(w.clipId===c.id||w.clipId===c.continuationGroupId||c.continuationGroupId===plan.policy.ownerClipId||policy?.ownerClipId===plan.policy.ownerClipId)&&matches(graph,c,w)))continue;
     if(compareTime(a.sourceStart,plan.sourceEnd)>=0)c.clock.offset=addTime(c.clock.offset,plan.delta);
     c.clock.duration=plan.duration;
     if(c.visual?.keyframeClock&&plan.key){if(compareTime(a.sourceStart,plan.sourceEnd)>=0)c.visual.keyframeClock.offset=addTime(c.visual.keyframeClock.offset,plan.key.delta);c.visual.keyframeClock.duration=plan.key.duration;}
     c.legacyCaptionContinuity={...structuredClone(plan.policy),witnesses:[legacyCaptionWitness(graph,c)!]};archivedChanged.add(c.id);
    }
    syncCaptionClocks(graph,archivedChanged);entry.clips=graph.clips;
   }
  }
  syncCaptionClocks(next,changed);
 };
}
function syncCaptionClocks(next:SequenceDocument,changed:Set<string>):void {
  // Source-ledger clocks are authoritative once registered. Update their basis,
  // not merely the materialized clip, so future rate changes retain the intent.
  if(next.speed?.version===2&&changed.size){
   const policies=new Map<string,Policy>();
   for(const ledger of captionLedgers(next)){
    const owned=ledger.parts.flatMap(part=>{const c=next.clips.find(c=>c.id===part.reservedRenderId);return c&&changed.has(c.id)?[c]:[];});if(!owned.length)continue;
    const c=owned[0]!,w=legacyCaptionWitness(next,c)!;
    const units=multiplyTime(subtractTime(w.sourceStart,ledger.sourceOrigin),next.speed.fpsBasis);
    ledger.clock={...w.clock,offset:subtractTime(w.clock.offset,multiplyTime(units,w.clock.slope))};
    if(w.keyframeClock)ledger.keyframeClock={...w.keyframeClock,offset:subtractTime(w.keyframeClock.offset,multiplyTime(units,w.keyframeClock.slope))};
    policies.set(ledger.captionId,structuredClone(c.legacyCaptionContinuity!));
   }
   const projected=new Map(materializeSpeedCaptions(next).map(c=>[c.id,c]));next.clips=next.clips.map(c=>projected.get(c.id)??c);
   // Updating one ledger basis also moves its freshly split parts. Capture
   // witnesses only after that projection, including parts absent from changed.
   // Otherwise a later partial restore mistakes our own update for a manual edit.
   const candidates=captionCandidates(next);
   for(const ledger of captionLedgers(next)){
    const policy=policies.get(ledger.captionId);if(!policy)continue;
    const witnesses:Witness[]=[];
    for(const part of ledger.parts){
     const peer=candidates.find(c=>c.id===part.reservedRenderId),proof=peer&&legacyCaptionWitness(next,peer);if(!proof)continue;
     witnesses.push(proof);const current={...structuredClone(policy),witnesses:[proof]};
     if(part.presentation)part.presentation.template.legacyCaptionContinuity=structuredClone(current);
    }
    ledger.template.legacyCaptionContinuity={...structuredClone(policy),witnesses};
   }
   const withProof=new Map(materializeSpeedCaptions(next).map(c=>[c.id,c]));next.clips=next.clips.map(c=>withProof.get(c.id)??c);
   refreshCaptionBaselines(next);
  }
 }
