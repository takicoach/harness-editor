import {SequenceError} from './errors';
import {clipEnd,type SequenceDocument,type SequenceClip,type NativeClipSpeedMetadata,type SpeedCaptionPart} from './model';
import {addTime,subtractTime,divideTime,multiplyTime,compareTime,rational,type Rational} from './time';
import {rebindCaptionContinuations,captionLedgers,captionPartWindow,materializeSpeedCaptions,refreshCaptionBaselines,speedProjectionForDocument} from './speedCaptionLedger';
import {independentAudioMap} from './speedTopologyProjection';
import type {SpeedFragment} from './speedRebind';
function fail(message:string,ids:string[]=[]):never{throw new SequenceError('INVALID_RANGE',message,ids);}
/** Final IDs/recipes already exist. Only this explicit edit rebinds saved topology. */
export function rebindSpeedStructure(before:SequenceDocument,next:SequenceDocument,fragments:Map<string,SpeedFragment[]>,fresh:(prefix:string)=>string):SequenceDocument {
 if(!before.speed)return next;
 const oldById=new Map(before.clips.map(c=>[c.id,c])),projection=speedProjectionForDocument(before);
 const byId=new Map(next.clips.map(c=>[c.id,c]));
 const audioFragments=before.clips.filter(c=>c.speed?.kind==='main-audio').flatMap(c=>fragments.get(c.id)??[]);
 const mains=before.clips.filter(c=>c.speed?.kind==='main').flatMap(c=>fragments.get(c.id)??[]).sort((a,b)=>a.clip.startFrame-b.clip.startFrame||(a.original.speed!.kind==='main'&&b.original.speed!.kind==='main'?a.original.speed!.order-b.original.speed!.order:0));
 // A topology edit can remove the last distinct override. Each surviving
 // cumulative run used a local zero phase, regardless of its dormant saved
 // absolute phase. Adopt that effective phase only when the document switches
 // back to absolute: round((0+x)/r)-round(0/r) === round(x/r), for every rate.
 // This preserves ordinary windows and clocks without resampling source intent
 // or retaining a deleted override. Existing absolute phases remain unchanged.
 const remainingMode=mains.some(f=>f.original.speed?.kind==='main'&&compareTime(f.original.speed.override??before.speed!.globalRate,before.speed!.globalRate)!==0)?'cumulative':'absolute';
 const adoptLocalPhase=projection.mode==='cumulative'&&remainingMode==='absolute';
 const matchingAudio=(f:SpeedFragment)=>audioFragments.filter(a=>a.original.speed?.kind==='main-audio'&&a.original.speed.providerId===f.original.id&&a.slice.from===f.slice.from&&a.slice.to===f.slice.to&&a.clip.startFrame===f.clip.startFrame&&a.clip.linkGroupId!==undefined&&a.clip.linkGroupId===f.clip.linkGroupId);
 const pairedAudio=(f:SpeedFragment,root?:string)=>matchingAudio(f).find(a=>root===undefined||(a.original.speed!.evaluationOwnerId??a.original.id)===root);
 type Part={f:SpeedFragment;start:Rational;end:Rational};type Group={oldRoot:SequenceClip;pieces:Part[];shift:number;audioRoot?:string};
 const groups:Group[]=[];
 for(const f of mains){const s=f.original.speed!;if(s.kind!=='main')return fail('主映像の基準がありません');const root=oldById.get(s.evaluationOwnerId??f.original.id)!;
  const start=f.slice.from===f.original.startFrame?projection.offset(f.original.id):projection.rootInverse(f.original.id,f.slice.from);
  const end=f.slice.to===clipEnd(f.original)?addTime(projection.offset(f.original.id),s.span):projection.rootInverse(f.original.id,f.slice.to);
  const ar=matchingAudio(f).map(a=>a.original.speed!.evaluationOwnerId??a.original.id).sort().join('|')||undefined,shift=f.clip.startFrame-f.slice.from;
  let group=groups.at(-1);if(!group||group.oldRoot.id!==root.id||group.shift!==shift||group.audioRoot!==ar||(projection.evaluationDelta&&compareTime(projection.rate(f.original.id),projection.rate(group.pieces[0]!.f.original.id))!==0)||compareTime(start,group.pieces.at(-1)!.end)<0){group={oldRoot:root,pieces:[],shift,...(ar?{audioRoot:ar}:{})};groups.push(group);}group.pieces.push({f,start,end});
 }
 let order=0,previousEnd=0;
 for(const group of groups){const first=group.pieces[0]!,root=group.oldRoot,old=root.speed!;if(old.kind!=='main')return fail('元投影が不正です');const origin=old.evaluationSourceStart??old.source.sourceStart,newRoot=first.f.clip.id,last=group.pieces.at(-1)!;
  const incoming=next.transitions.find(t=>t.inClipId===newRoot&&t.startFrame===first.f.clip.startFrame),overlap=incoming?.durationFrames??0;
  const gap=first.f.clip.startFrame-previousEnd+overlap;if(gap<0)fail('主系列の構造順と転換が不一致です',[newRoot]);
  for(const [index,p] of group.pieces.entries()){const oldPiece=p.f.original.speed!;if(oldPiece.kind!=='main')return fail('主映像が不正です');
   const s:NativeClipSpeedMetadata={...structuredClone(oldPiece),order:order++,span:subtractTime(p.end,p.start),evaluationOwnerId:newRoot,projectionOffset:p.start,source:{...oldPiece.source,sourceStart:addTime(origin,divideTime(p.start,before.speed.fpsBasis)),sourceEnd:addTime(origin,divideTime(p.end,before.speed.fpsBasis))},clock:structuredClone(old.clock),...(old.keyframeClock?{keyframeClock:structuredClone(old.keyframeClock)}:{})};
   delete s.runHead;delete s.overlapBefore;delete s.projectionExtent;delete s.evaluationSourceStart;delete s.structuralPlacement;delete s.captions;delete s.captionBaselines;
   if(index===0){s.projectionExtent=projection.rootSpan(root.id);s.evaluationSourceStart=origin;s.structuralPlacement={phase:adoptLocalPhase?rational(0):projection.phase(root.id),gapFrames:gap,anchorStart:first.start,anchorEnd:last.end};if(incoming)s.overlapBefore=old.overlapBefore??multiplyTime(rational(overlap),projection.rate(root.id));}
   p.f.clip.speed=s;
  }
  previousEnd=clipEnd(last.f.clip);
 }
 next.speed!.originFrame=0;
 next.speed!.sequenceEndBasis=mains.length?{kind:'main-offset',offsetFrames:next.sequenceEndFrame-clipEnd(mains.at(-1)!.clip)}:{kind:'empty-fixed',offsetFrames:0,endFrame:next.sequenceEndFrame};
 const unlinked=new Set<string>();
 // Removing an audio occurrence can leave no audio fragment to visit below.
 // Its surviving main still belongs to the affected one-sided edit.
 for(const old of before.clips)if(old.speed?.kind==='main-audio'&&old.linkGroupId){const provider=old.speed.providerId;for(const m of mains.filter(m=>m.original.id===provider))if(!matchingAudio(m).some(a=>a.original.id===old.id))unlinked.add(old.linkGroupId);}
 for(const old of before.clips){const s=old.speed;if(!s||s.kind==='main')continue;
  for(const f of fragments.get(old.id)??[]){
   const provider=s.kind==='main-audio'?mains.find(m=>m.original.id===s.providerId&&m.slice.from===f.slice.from&&m.slice.to===f.slice.to&&m.clip.startFrame===f.clip.startFrame&&m.clip.linkGroupId!==undefined&&m.clip.linkGroupId===f.clip.linkGroupId):undefined;
   const main=provider?.clip,ms=main?.speed;
   const rootMain=ms?.kind==='main'?mains.find(m=>m.clip.id===ms.evaluationOwnerId):undefined;
   const audioRoot=rootMain?pairedAudio(rootMain,s.evaluationOwnerId??old.id):undefined;
   if(s.kind==='main-audio'&&main&&ms?.kind==='main'&&audioRoot&&(!old.linkGroupId||!unlinked.has(old.linkGroupId))){
    const oldRoot=oldById.get(s.evaluationOwnerId??old.id)!,o=oldRoot.speed!;
    const a:NativeClipSpeedMetadata={kind:'main-audio',providerId:main.id,evaluationOwnerId:audioRoot.clip.id,source:{...s.source,sourceStart:ms.source.sourceStart,sourceEnd:ms.source.sourceEnd},clock:structuredClone(o.clock),...(o.keyframeClock?{keyframeClock:structuredClone(o.keyframeClock)}:{})};
    if(f.clip.id===audioRoot.clip.id)a.evaluationSourceStart=o.evaluationSourceStart??o.source.sourceStart;f.clip.speed=a;continue;
   }
   if(s.kind==='main-audio'&&old.linkGroupId)unlinked.add(old.linkGroupId);
   let offset:Rational,end:Rational,origin:Rational,rate:Rational,phase:Rational,mode:'absolute'|'cumulative',clock=s.clock,key=s.keyframeClock;
   if(s.kind==='independent-audio'){const map=independentAudioMap(before,old);offset=map.inverse(f.slice.from);end=map.inverse(f.slice.to);origin=s.evaluationSourceStart;rate=s.mediaRate;phase=s.projection.phase;mode=s.projection.mode;}
   else {const mainOld=oldById.get(s.providerId)!,root=oldById.get(s.evaluationOwnerId??old.id)!,o=root.speed!;offset=f.slice.from===old.startFrame?projection.offset(mainOld.id):projection.rootInverse(mainOld.id,f.slice.from);const mainBasis=mainOld.speed!;if(mainBasis.kind!=='main')return fail('原音所有者が不正です');end=f.slice.to===clipEnd(old)?addTime(projection.offset(mainOld.id),mainBasis.span):projection.rootInverse(mainOld.id,f.slice.to);origin=o.evaluationSourceStart??o.source.sourceStart;rate=projection.rate(mainOld.id);phase=projection.phase(mainOld.id);mode=projection.mode;clock=o.clock;key=o.keyframeClock;}
   f.clip.speed={kind:'independent-audio',placement:{startFrame:f.clip.startFrame},mediaRate:rate,projection:{mode,phase:mode==='cumulative'?rational(0):phase,offset},evaluationSourceStart:origin,source:{...s.source,sourceStart:addTime(origin,divideTime(offset,before.speed.fpsBasis)),sourceEnd:addTime(origin,divideTime(end,before.speed.fpsBasis))},clock:structuredClone(clock),...(key?{keyframeClock:structuredClone(key)}:{})};
  }
 }
 // Descendants may already have fresh link IDs allocated by the ordinary split.
 // Follow their original group, never the new string alone.
 for(const old of before.clips)if(old.linkGroupId&&unlinked.has(old.linkGroupId))for(const f of fragments.get(old.id)??[])delete f.clip.linkGroupId;
 const oldLedgers=captionLedgers(before),recipeIds=new Set<string>();
 for(const old of oldLedgers)for(const p of old.parts)for(const f of fragments.get(p.reservedRenderId)??[])if(f.clip.anchor?.kind==='source')recipeIds.add(f.clip.id);
 for(const c of next.clips)if(c.speed){delete c.speed.captions;delete c.speed.captionBaselines;}
 const projected=speedProjectionForDocument(next);
 for(const old of oldLedgers){const ledger=structuredClone(old),parts:SpeedCaptionPart[]=[];
  for(const part of old.parts){const pending:Array<{p:SpeedCaptionPart;visible?:SequenceClip}>=[];
   for(const f of fragments.get(part.providerId)??[]){if(!f.clip.speed)continue;const source=f.clip.speed.source,start=compareTime(part.intentStart,source.sourceStart)>=0?part.intentStart:source.sourceStart,end=compareTime(part.intentEnd,source.sourceEnd)<=0?part.intentEnd:source.sourceEnd;if(compareTime(start,end)>=0)continue;
    const p={...part,providerId:f.clip.id,intentStart:start,intentEnd:end},window=captionPartWindow(next,p,projected);
    const visible=(fragments.get(part.reservedRenderId)??[]).find(c=>c.clip.startFrame===window.startFrame&&clipEnd(c.clip)===window.endFrame&&c.clip.anchor?.kind==='source'&&c.clip.anchor.clipOccurrenceId===f.clip.id)?.clip;
    if(window.startFrame!==window.endFrame&&!visible){if((fragments.get(part.reservedRenderId)??[]).some(c=>c.clip.anchor?.kind==='timeline'))continue;fail('構造編集の字幕intentと通常表示が一致しません',[part.reservedRenderId]);}
    pending.push({p,visible});
   }
   const keep=Math.max(0,pending.findIndex(p=>p.visible?.id===part.reservedRenderId));
   for(const [i,{p,visible}] of pending.entries()){p.partId=i===keep?part.partId:fresh('caption-part');p.reservedRenderId=visible?.id??(i===keep?part.reservedRenderId:fresh('caption-render'));delete p.continuationGroupId;const continuation=visible?.continuationGroupId??part.continuationGroupId;if(continuation)p.continuationGroupId=continuation;parts.push(p);}
  }
  if(!parts.length)continue;ledger.parts=parts;
  // Deleting one provider may leave its rendered text detached on the timeline.
  // That ordinary clip retains its ID; the surviving source intent is now a
  // different logical caption and must not reserve the detached clip's ID.
  const rendered=new Set(parts.map(p=>p.reservedRenderId));
  if(next.clips.some(c=>!rendered.has(c.id)&&[c.id,c.linkGroupId,c.continuationGroupId].includes(ledger.captionId)))ledger.captionId=fresh('caption-intent');
  rebindCaptionContinuations(ledger,old,fragments);
  (byId.get(parts[0]!.providerId)!.speed!.captions??=[]).push(ledger);
 }
 refreshCaptionBaselines(next);const captions=new Map(materializeSpeedCaptions(next).map(c=>[c.id,c]));
 next.clips=next.clips.flatMap(c=>{if(!recipeIds.has(c.id))return [c];const replacement=captions.get(c.id);captions.delete(c.id);return replacement?[replacement]:[];}).concat([...captions.values()]);
 return next;
}
