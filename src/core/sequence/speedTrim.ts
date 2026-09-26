import {rebindSpeedStructure} from './speedStructural';
import {SequenceError} from './errors';
import {clipEnd,type SequenceDocument,type SpeedCaptionPart} from './model';
import {addTime,compareTime,divideTime,subtractTime} from './time';
import {rebindCaptionContinuations,captionLedgers,captionPartWindow,materializeSpeedCaptions,refreshCaptionBaselines,speedProjectionForDocument} from './speedCaptionLedger';
import type {SpeedFragment} from './speedRebind';
function fail(message:string,ids:string[]=[]):never {throw new SequenceError('INVALID_RANGE',message,ids);}
/** Linked trim adopts only the changed intent window, not a new source/effect origin. */
export function rebindSpeedTrim(before:SequenceDocument,next:SequenceDocument,fragments:Map<string,SpeedFragment[]>,fresh:(prefix:string)=>string):SequenceDocument {
  if(!before.speed)return next;
  const p=speedProjectionForDocument(before),byId=new Map(next.clips.map(c=>[c.id,c])),oldById=new Map(before.clips.map(c=>[c.id,c]));
  if(p.evaluationDelta)return rebindSpeedStructure(before,next,fragments,fresh);
  const affected=new Set<string>();
  for(const old of before.clips)if(old.speed?.kind==='main'){
    const f=fragments.get(old.id);if(!f||f.length!==1)fail('trimには主映像の一つの保持窓が必要です',[old.id]);
    if(f[0]!.slice.from!==old.startFrame||f[0]!.slice.to!==clipEnd(old))affected.add(old.speed.evaluationOwnerId??old.id);
  }
  for(const old of before.clips){
    const s=old.speed;if(s?.kind!=='main'||!affected.has(s.evaluationOwnerId??old.id))continue;
    const root=oldById.get(s.evaluationOwnerId??old.id)!,rootBasis=root.speed!;
    const f=fragments.get(old.id)![0]!,target=f.clip.speed!;if(target.kind!=='main')return fail('trimの主所有者がありません');
    const start=f.slice.from===old.startFrame?p.offset(old.id):p.rootInverse(old.id,f.slice.from);
    const end=f.slice.to===clipEnd(old)?addTime(p.offset(old.id),s.span):p.rootInverse(old.id,f.slice.to);
    if(compareTime(start,end)>=0)fail('trimの保存intentには正の長さが必要です',[old.id]);
    const origin=subtractTime(rootBasis.source.sourceStart,divideTime(p.offset(root.id),before.speed.fpsBasis));
    target.span=subtractTime(end,start);target.projectionOffset=start;target.evaluationOwnerId=root.id;
    target.source={...s.source,sourceStart:addTime(origin,divideTime(start,before.speed.fpsBasis)),sourceEnd:addTime(origin,divideTime(end,before.speed.fpsBasis))};
    if(root.id===old.id){target.projectionExtent=p.rootSpan(old.id);target.evaluationSourceStart=rootBasis.evaluationSourceStart??rootBasis.source.sourceStart;}
  }
  for(const old of before.clips){
    const s=old.speed;if(s?.kind!=='main-audio')continue;
    const oldMain=oldById.get(s.providerId)!;if(oldMain.speed?.kind!=='main'||!affected.has(oldMain.speed.evaluationOwnerId??oldMain.id))continue;
    const audio=byId.get(old.id)!,main=byId.get(s.providerId)!,f=fragments.get(old.id)![0]!,mf=fragments.get(s.providerId)![0]!;
    if(f.slice.from!==mf.slice.from||f.slice.to!==mf.slice.to)fail('原音を片側でtrimするには独立時計の再結合が必要です',[old.id,s.providerId]);
    const a=audio.speed!;if(a.kind!=='main-audio')return fail('trimの原音がありません');
    const root=s.evaluationOwnerId??old.id;a.evaluationOwnerId=root;
    a.source={...s.source,sourceStart:main.speed!.source.sourceStart,sourceEnd:main.speed!.source.sourceEnd};
    if(old.id===root)a.evaluationSourceStart=s.evaluationSourceStart??s.source.sourceStart;
  }
  const last=next.clips.filter(c=>c.speed?.kind==='main').sort((a,b)=>(a.speed!.kind==='main'?a.speed!.order:0)-(b.speed!.kind==='main'?b.speed!.order:0)).at(-1)!;
  next.speed!.sequenceEndBasis.offsetFrames=next.sequenceEndFrame-clipEnd(last);
  const oldLedgers=captionLedgers(before),recipeIds=new Set<string>();
  for(const ledger of oldLedgers)for(const part of ledger.parts)for(const f of fragments.get(part.reservedRenderId)??[])recipeIds.add(f.clip.id);
  for(const c of next.clips)if(c.speed){delete c.speed.captions;delete c.speed.captionBaselines;}
  const projection=speedProjectionForDocument(next);
  for(const old of oldLedgers){
    const ledger=structuredClone(old),parts:SpeedCaptionPart[]=[];
    for(const part of old.parts){
      const provider=byId.get(part.providerId);if(!provider?.speed)fail('trimの字幕所有者がありません',[part.providerId]);
      const source=provider.speed.source;
      const start=compareTime(part.intentStart,source.sourceStart)>=0?part.intentStart:source.sourceStart;
      const end=compareTime(part.intentEnd,source.sourceEnd)<=0?part.intentEnd:source.sourceEnd;
      if(compareTime(start,end)>=0)continue; // Explicitly removed source intent, not a rounded zero window.
      const updated={...part,intentStart:start,intentEnd:end},window=captionPartWindow(next,updated,projection);
      if(window.startFrame!==window.endFrame){const visible=(fragments.get(part.reservedRenderId)??[]).find(f=>f.clip.startFrame===window.startFrame&&clipEnd(f.clip)===window.endFrame);if(!visible)fail('trimの字幕intentと通常表示が一致しません',[part.reservedRenderId]);}
      parts.push(updated);
    }
    if(!parts.length)continue;
    ledger.parts=parts;rebindCaptionContinuations(ledger,old,fragments);(byId.get(parts[0]!.providerId)!.speed!.captions??=[]).push(ledger);
  }
  refreshCaptionBaselines(next);
  const materialized=materializeSpeedCaptions(next),captions=new Map(materialized.map(c=>[c.id,c]));
  next.clips=next.clips.flatMap(c=>{if(!recipeIds.has(c.id))return [c];const replacement=captions.get(c.id);captions.delete(c.id);return replacement?[replacement]:[];}).concat([...captions.values()]);
  return next;
}
