import {SequenceError} from './errors';
import {clipEnd,type SequenceClip,type SequenceDocument,type SpeedCaptionPart} from './model';
import {addTime,compareTime,divideTime,subtractTime} from './time';
import {rebindCaptionContinuations,refreshCaptionBaselines,captionLedgers,captionPartWindow,materializeSpeedCaptions,speedProjectionForDocument} from './speedCaptionLedger';

export interface SpeedFragment {original:SequenceClip;slice:{from:number;to:number;start:number};clip:SequenceClip}
function fail(message:string,ids:string[]=[]):never {throw new SequenceError('INVALID_RANGE',message,ids);}
/** Called only for split, with final IDs already allocated by the existing recipe. */
export function rebindSpeedSplit(before:SequenceDocument,next:SequenceDocument,fragments:Map<string,SpeedFragment[]>,fresh:(prefix:string)=>string):SequenceDocument {
  if(!before.speed)return next;
  const projection=speedProjectionForDocument(before);
  const mains=before.clips.filter(c=>c.speed?.kind==='main').sort((a,b)=>(a.speed!.kind==='main'?a.speed!.order:0)-(b.speed!.kind==='main'?b.speed!.order:0));
  let order=0;
  for(const original of mains){
    const basis=original.speed!;if(basis.kind!=='main')continue;
    const parts=fragments.get(original.id)!;
    for(const [index,part] of parts.entries()){
      const start=projection.inverse(original.id,part.slice.from),end=projection.inverse(original.id,part.slice.to);
      const sourceStart=addTime(basis.source.sourceStart,divideTime(start,before.speed.fpsBasis));
      // The unchanged final intent is retained even when the display end rounded.
      const sourceEnd=part.slice.to===clipEnd(original)?basis.source.sourceEnd:addTime(basis.source.sourceStart,divideTime(end,before.speed.fpsBasis));
      const s=part.clip.speed!;if(s.kind!=='main')return fail('主映像の分割情報がありません');
      s.order=order++;s.span=subtractTime(end,start);if(basis.projectionOffset!==undefined)s.projectionOffset=addTime(basis.projectionOffset,start);s.source={...basis.source,sourceStart,sourceEnd};
      if(parts.length>1||basis.evaluationOwnerId)s.evaluationOwnerId=basis.evaluationOwnerId??original.id;
      s.clock=structuredClone(basis.clock);
      if(basis.keyframeClock)s.keyframeClock=structuredClone(basis.keyframeClock);
      delete s.captions;delete s.captionBaselines;
      if(index>0){delete s.overlapBefore;delete s.runHead;delete s.projectionExtent;delete s.evaluationSourceStart;delete s.structuralPlacement;}
      // Same logical run and original phase. No live start/gap re-adoption.
    }
  }
  for(const original of before.clips){
    if(original.speed?.kind!=='main-audio')continue;
    const basis=original.speed;
    const audioParts=fragments.get(original.id)!;
    for(const part of audioParts){
      const provider=fragments.get(basis.providerId)?.find(p=>p.slice.from===part.slice.from&&p.slice.to===part.slice.to);
      if(!provider||provider.clip.speed?.kind!=='main')fail('原音と主映像を同じ境界で分割してください',[original.id,basis.providerId]);
      const s=part.clip.speed!;if(s.kind!=='main-audio')return fail('原音の分割情報がありません');
      if(part.clip.id!==(basis.evaluationOwnerId??original.id))delete s.evaluationSourceStart;
      s.providerId=provider.clip.id;s.source={...basis.source,sourceStart:provider.clip.speed.source.sourceStart,sourceEnd:provider.clip.speed.source.sourceEnd};
      if(audioParts.length>1||basis.evaluationOwnerId)s.evaluationOwnerId=basis.evaluationOwnerId??original.id;
      s.clock=structuredClone(basis.clock);
      if(basis.keyframeClock)s.keyframeClock=structuredClone(basis.keyframeClock);
      delete s.captions;delete s.captionBaselines;
    }
  }
  // Independent audio can carry a ledger even when this split only changes main.
  for(const c of next.clips)if(c.speed){delete c.speed.captions;delete c.speed.captionBaselines;}
  // Reserve all part/render IDs before materialization. Existing visible recipe IDs
  // take priority over new latent IDs, so a latent prefix cannot steal the old ID.
  const oldLedgers=captionLedgers(before),oldRenderIds=new Set(oldLedgers.flatMap(l=>l.parts.map(p=>p.reservedRenderId)));
  const recipeCaptionIds=new Set<string>();for(const id of oldRenderIds)for(const f of fragments.get(id)??[])recipeCaptionIds.add(f.clip.id);
  const nextProjection=speedProjectionForDocument(next);
  for(const old of oldLedgers){
    const ledger=structuredClone(old),updated:SpeedCaptionPart[]=[];
    for(const part of old.parts){
      const providers=fragments.get(part.providerId);if(!providers?.length)fail('字幕の所有者がありません',[part.providerId]);
      const pending:Array<{p:SpeedCaptionPart;visible?:SequenceClip}>=[];
      for(const provider of providers){
        const source=provider.clip.speed!.source;
        const start=compareTime(part.intentStart,source.sourceStart)>=0?part.intentStart:source.sourceStart;
        const end=compareTime(part.intentEnd,source.sourceEnd)<=0?part.intentEnd:source.sourceEnd;
        if(compareTime(start,end)>=0)continue;
        const p:SpeedCaptionPart={...part,providerId:provider.clip.id,intentStart:start,intentEnd:end};
        const window=captionPartWindow(next,p,nextProjection);
        const visible=(fragments.get(part.reservedRenderId)??[]).find(f=>f.clip.startFrame===window.startFrame&&clipEnd(f.clip)===window.endFrame)?.clip;
        if(window.startFrame!==window.endFrame&&!visible)fail('字幕の分割intentと既存表示recipeが一致しません',[part.reservedRenderId]);
        pending.push({p,visible});
      }
      if(!pending.length)fail('字幕intentを分割できません',[part.partId]);
      const preserve=pending.findIndex(x=>x.visible?.id===part.reservedRenderId);
      const retain=preserve>=0?preserve:0;
      for(const [i,{p,visible}] of pending.entries()){
        p.partId=i===retain?part.partId:fresh('caption-part');
        p.reservedRenderId=visible?.id??(i===retain?part.reservedRenderId:fresh('caption-render'));
        delete p.continuationGroupId;
        const continuation=visible?.continuationGroupId??part.continuationGroupId;
        if(continuation)p.continuationGroupId=continuation;
        updated.push(p);
      }
    }
    ledger.parts=updated;rebindCaptionContinuations(ledger,old,fragments);
    ledger.baselineProjection={snapshotKey:'',inputKey:'',parts:updated.map(p=>({partId:p.partId,...captionPartWindow(next,p,nextProjection)}))};
    const carrier=next.clips.find(c=>c.id===updated[0]!.providerId)!;
    (carrier.speed!.captions??=[]).push(ledger);
  }
  refreshCaptionBaselines(next);
  const materialized=materializeSpeedCaptions(next),byId=new Map(materialized.map(c=>[c.id,c]));
  next.clips=next.clips.flatMap(c=>{
    if(!recipeCaptionIds.has(c.id))return [c];
    const replacement=byId.get(c.id);byId.delete(c.id);return replacement?[replacement]:[];
  }).concat([...byId.values()]);
  return next;
}
