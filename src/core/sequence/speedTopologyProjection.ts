import {SequenceError} from './errors';
import {type SequenceDocument,type SequenceClip} from './model';
import {buildSpeedTimeMap,roundSpeedTime} from './speedTimeMap';
import {addTime,subtractTime,multiplyTime,divideTime,compareTime,rational,type Rational} from './time';
import type {DocumentSpeedProjection} from './speedCaptionLedger';
function fail(message:string):never{throw new SequenceError('INVALID_DOCUMENT',message);}
const safe=(v:number)=>{if(!Number.isSafeInteger(v)||v<0)fail('構造編集の表示時刻が不正です');return v;};
/** Same exact phase mapping as the frozen map, extended beyond the original cell. */
export function phasePoint(phase:Rational,offset:Rational,rate:Rational,mode:'absolute'|'cumulative'):number{
 return mode==='absolute'?roundSpeedTime(divideTime(addTime(phase,offset),rate))-roundSpeedTime(divideTime(phase,rate)):roundSpeedTime(divideTime(offset,rate));
}
export function phaseInverse(phase:Rational,frame:number,rate:Rational,mode:'absolute'|'cumulative'):Rational{
 return mode==='absolute'?subtractTime(multiplyTime(rational(frame+roundSpeedTime(divideTime(phase,rate))),rate),phase):multiplyTime(rational(frame),rate);
}
export function independentAudioMap(doc:SequenceDocument,clip:SequenceClip){
 const s=clip.speed;if(s?.kind!=='independent-audio')return fail('独立音声の基準がありません');
 const span=multiplyTime(subtractTime(s.source.sourceEnd,s.source.sourceStart),doc.speed!.fpsBasis),offset=s.projection.offset;
 const relative=(x:Rational)=>phasePoint(s.projection.phase,x,s.mediaRate,s.projection.mode);
 const rootStart=s.placement.startFrame-relative(offset),endOffset=addTime(offset,span),endFrame=safe(rootStart+relative(endOffset));
 return {rootStart,startFrame:s.placement.startFrame,endFrame,span,offset,
  point:(x:Rational)=>safe(rootStart+relative(x)),
  inverse:(frame:number)=>frame===s.placement.startFrame?offset:frame===endFrame?endOffset:phaseInverse(s.projection.phase,frame-rootStart,s.mediaRate,s.projection.mode)};
}
/** Rebound topologies anchor retained windows, not invisible original root edges. */
export function topologyProjection(doc:SequenceDocument):DocumentSpeedProjection {
 if(!doc.speed)return fail('速度基準がありません');
 const mains=doc.clips.filter(c=>c.speed?.kind==='main').sort((a,b)=>(a.speed!.kind==='main'?a.speed!.order:0)-(b.speed!.kind==='main'?b.speed!.order:0));
 if(!mains.length){if(doc.speed.sequenceEndBasis.kind!=='empty-fixed')return fail('空の主系列には固定完成尺が必要です');const missing=():never=>fail('主映像の所有者がありません');return {family:'native-exact-v1',mode:'absolute',entries:[],originFrame:doc.speed.originFrame,mainEndFrame:0,sequenceEndFrame:doc.speed.sequenceEndBasis.endFrame,point:missing,inverse:missing,rate:missing,rootStart:missing,rootSpan:missing,offset:missing,rootPoint:missing,rootInverse:missing,phase:missing};}
 if(doc.speed.sequenceEndBasis.kind!=='main-offset')return fail('主系列の完成尺基準が不正です');
 const mode=mains.some(c=>c.speed!.kind==='main'&&compareTime(c.speed!.override??doc.speed!.globalRate,doc.speed!.globalRate)!==0)?'cumulative' as const:'absolute' as const;
 type Group={root:SequenceClip;pieces:SequenceClip[];rate:Rational;phase:Rational;extent:Rational;virtualStart:number;fullDuration:number;gapStart:number;anchorStart:number;overlap:number};
 const groups:Group[]=[],byId=new Map<string,Group>();
 for(const c of mains){const s=c.speed!;if(s.kind!=='main')return fail('主映像が不正です');const owner=s.evaluationOwnerId??c.id;let g=groups.at(-1);
  if(!g||g.root.id!==owner){if(owner!==c.id||!s.structuralPlacement||!s.projectionExtent||!s.projectionOffset)return fail('構造投影の先頭基準がありません');const rate=s.override??doc.speed.globalRate,phase=s.structuralPlacement.phase;
   const map=buildSpeedTimeMap([{ownerId:c.id,span:s.projectionExtent,rate,mode,gapBefore:0,...(mode==='absolute'?{runBasisOffset:phase}:{})}]);
   g={root:c,pieces:[],rate,phase,extent:s.projectionExtent,virtualStart:0,fullDuration:map.endFrame,gapStart:0,anchorStart:0,overlap:0};groups.push(g);
  }else if(s.structuralPlacement||s.runHead||s.overlapBefore||compareTime(s.override??doc.speed.globalRate,g.rate)!==0)return fail('同じ投影ownerの構造関係が不正です');
  g.pieces.push(c);byId.set(c.id,g);
 }
 let cursor=doc.speed.originFrame;
 for(const [i,g] of groups.entries()){const s=g.root.speed!;if(s.kind!=='main')return fail('主映像が不正です');const p=s.structuralPlacement!;g.gapStart=cursor;
  if(s.overlapBefore){const prev=groups[i-1];if(!prev||p.gapFrames!==0||mode!=='absolute'||compareTime(prev.rate,g.rate)!==0)return fail('構造転換の速度または所有関係が不正です');g.overlap=Math.min(roundSpeedTime(divideTime(s.overlapBefore,prev.rate)),Math.floor(Math.min(prev.fullDuration,g.fullDuration)/2));if(g.overlap<=0)return fail('構造転換が0フレームになりました');}
  g.anchorStart=safe(cursor+p.gapFrames-g.overlap);g.virtualStart=g.anchorStart-phasePoint(g.phase,p.anchorStart,g.rate,mode);cursor=safe(g.virtualStart+phasePoint(g.phase,p.anchorEnd,g.rate,mode));
 }
 const get=(id:string)=>{const g=byId.get(id);if(!g)return fail('構造投影の所有者がありません');return g;};
 const off=(id:string)=>{const s=doc.clips.find(c=>c.id===id)!.speed!;if(s.kind!=='main'||!s.projectionOffset)return fail('構造投影片のoffsetがありません');return s.projectionOffset;};
 const rootPoint=(id:string,x:Rational)=>{const g=get(id);return safe(g.virtualStart+phasePoint(g.phase,x,g.rate,mode));};
 const entries=mains.map(c=>{const g=get(c.id),s=c.speed!;if(s.kind!=='main')return fail('主映像が不正です');return {ownerId:c.id,startFrame:rootPoint(c.id,off(c.id)),endFrame:rootPoint(c.id,addTime(off(c.id),s.span)),gapStartFrame:g.root.id===c.id?g.gapStart:rootPoint(c.id,off(c.id)),gapEndFrame:g.root.id===c.id?g.anchorStart+g.overlap:rootPoint(c.id,off(c.id)),overlapBeforeFrames:g.root.id===c.id?g.overlap:0};});
 const mainEndFrame=entries.at(-1)!.endFrame,sequenceEndFrame=safe(mainEndFrame+doc.speed.sequenceEndBasis.offsetFrames);
 const rootInverse=(id:string,frame:number)=>{const g=get(id);if(!Number.isSafeInteger(frame))return fail('構造編集境界が不正です');return phaseInverse(g.phase,frame-g.virtualStart,g.rate,mode);};
 return {family:'native-exact-v1',mode,entries,originFrame:doc.speed.originFrame,mainEndFrame,sequenceEndFrame,rootStart:id=>get(id).virtualStart,rootSpan:id=>get(id).extent,offset:off,phase:id=>get(id).phase,rootPoint,rootInverse,rate:id=>get(id).rate,
  point(p){if(p.kind==='clip'){const s=doc.clips.find(c=>c.id===p.ownerId)!.speed!;if(s.kind!=='main'||compareTime(p.offset,rational(0))<0||compareTime(p.offset,s.span)>0)return fail('時刻が構造片の外です');return rootPoint(p.ownerId,addTime(off(p.ownerId),p.offset));}if(p.kind==='after-main'){if(p.ownerId!==mains.at(-1)!.id||doc.speed!.sequenceEndBasis.kind!=='main-offset'||doc.speed!.sequenceEndBasis.offsetFrames<=0||compareTime(p.offset,rational(0))<0||compareTime(p.offset,rational(doc.speed!.sequenceEndBasis.offsetFrames))>0)return fail('時刻が末尾の外です');return safe(mainEndFrame+roundSpeedTime(p.offset));}const g=get(p.ownerId),s=g.root.speed!;if(s.kind!=='main'||p.ownerId!==g.root.id||s.structuralPlacement!.gapFrames<=0||compareTime(p.offset,rational(0))<0||compareTime(p.offset,rational(s.structuralPlacement!.gapFrames))>0)return fail('時刻が空白の外です');return safe(g.gapStart+roundSpeedTime(p.offset));},
  inverse(id,frame,kind='clip'){const e=entries.find(e=>e.ownerId===id);if(!e||!Number.isSafeInteger(frame))return fail('構造編集境界が不正です');if(kind==='after-main'){if(id!==mains.at(-1)!.id||frame<mainEndFrame||frame>sequenceEndFrame||sequenceEndFrame<=mainEndFrame)return fail('時刻が末尾の外です');return rational(frame-mainEndFrame);}if(kind==='gap-before'){const g=get(id),s=g.root.speed!;if(s.kind!=='main'||id!==g.root.id||s.structuralPlacement!.gapFrames<=0||frame<g.gapStart||frame>g.anchorStart)return fail('時刻が空白の外です');return rational(frame-g.gapStart);}const s=doc.clips.find(c=>c.id===id)!.speed!;if(s.kind!=='main'||frame<e.startFrame||frame>e.endFrame)return fail('時刻が構造片の外です');if(frame===e.startFrame)return rational(0);if(frame===e.endFrame)return s.span;return subtractTime(rootInverse(id,frame),off(id));}
 };
}
