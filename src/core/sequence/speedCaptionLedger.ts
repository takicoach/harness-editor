import {isLegacyCaptionPolicy,normalizeLegacyCaptionContinuations} from './legacyCaptionContinuations';
import {timingReservedIds} from './speedTimingBasis';
import {variableSpeedProjection} from './speedVariableProjection';
import {topologyProjection,independentAudioMap} from './speedTopologyProjection';
import {sha256} from '@noble/hashes/sha2.js';
import {validateNativeSpeedMetadata} from './speedMetadata';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';
import {SequenceError} from './errors';
import {isMediaContent,sourceTimeAt,type SequenceClip,type SequenceDocument,type SpeedCaptionLedger,type SpeedCaptionPart,type SpeedClockBasis,type SpeedCaptionBaseline} from './model';
import {roundSpeedTime} from './speedTimeMap';
import {buildNativeSpeedProjection,type NativeSpeedProjection,type SpeedProjectionPart} from './speedProjection';
import {addTime,compareTime,divideTime,isRational,multiplyTime,rational,subtractTime,type Rational} from './time';

function fail(message:string,ids:string[]=[]):never {throw new SequenceError('INVALID_DOCUMENT',message,ids);}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const equal=(a:unknown,b:unknown):boolean=>JSON.stringify(sort(a))===JSON.stringify(sort(b));
function sort(v:unknown):unknown {
  if(Array.isArray(v))return v.map(sort);
  if(isRational(v)&&Object.keys(v).length===2){const t=rational(v.num,v.den);return {den:t.den,num:t.num};}
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sort(x)]));
  return v;
}
function object(v:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v))return fail('字幕intentの形式が不正です');
  const r=v as Record<string,unknown>;
  if(required.some(k=>r[k]===undefined)||Object.keys(r).some(k=>![...required,...optional].includes(k)))fail('字幕intentに未対応の項目があります');
  return r;
}
function list(v:unknown):asserts v is unknown[]{if(!Array.isArray(v)||Object.keys(v).length!==v.length||Object.keys(v).some((k,i)=>k!==String(i)))fail('字幕baselineの一覧が不正です');}
function time(v:unknown,positive=false,signed=false):asserts v is Rational {
  object(v,['num','den']);if(!isRational(v)||(!signed&&(positive?v.num<=0:v.num<0)))fail('字幕intentの時刻が不正です');
}
function clock(v:unknown):asserts v is SpeedClockBasis {const c=object(v,['offset','slope','duration']);time(c.offset,false,true);time(c.slope,true);time(c.duration,true);}
/** v2 split pieces retain their original projection owner, including overlap caps.
 * The pure map sees the uncut span; only displayed fragment endpoints are sliced.
 */
export interface DocumentSpeedProjection extends NativeSpeedProjection {
  evaluationDelta?(ownerId:string):number;
  phase(ownerId:string):Rational; rootStart(ownerId:string):number; rootSpan(ownerId:string):Rational; offset(ownerId:string):Rational;
  rootPoint(ownerId:string,offset:Rational):number; rootInverse(ownerId:string,frame:number):Rational;
}
export function speedProjectionForDocument(doc:SequenceDocument):DocumentSpeedProjection {
  if(!doc.speed)return fail('速度の保存基準がありません');
  const mains=doc.clips.filter(c=>c.speed?.kind==='main').sort((a,b)=>(a.speed!.kind==='main'?a.speed!.order:0)-(b.speed!.kind==='main'?b.speed!.order:0));
  const hasSplitRates=mains.some(c=>{const s=c.speed!;if(s.kind!=='main'||!s.evaluationOwnerId)return false;const root=mains.find(x=>x.id===s.evaluationOwnerId)?.speed;return root?.kind==='main'&&compareTime(s.override??doc.speed!.globalRate,root.override??doc.speed!.globalRate)!==0;});
  if(hasSplitRates&&doc.speed.projectionPolicy==='split-rate-v1')return variableSpeedProjection(doc);
  if(!mains.length||mains.some(c=>c.speed?.kind==='main'&&c.speed.structuralPlacement!==undefined))return topologyProjection(doc);
  type Piece={clip:SequenceClip;offset:Rational;span:Rational};
  const groups:Array<{root:SequenceClip;pieces:Piece[];span:Rational}>=[],byId=new Map<string,{group:number;piece:Piece}>();
  for(const clip of mains){
    const s=clip.speed!;if(s.kind!=='main')return fail('主映像が不正です');
    const owner=s.evaluationOwnerId??clip.id;
    let group=groups.at(-1);
    if(!group||group.root.id!==owner){
      if(owner!==clip.id)return fail('元投影の先頭所有者がありません',[clip.id,owner]);
      group={root:clip,pieces:[],span:rational(0)};groups.push(group);
    }else{
      if(s.runHead!==undefined||s.overlapBefore!==undefined)return fail('分割途中に未対応の丸め区間または転換があります',[clip.id]);
      const root=group.root.speed!;if(root.kind!=='main')return fail('元投影が不正です');
      if(compareTime(s.override??doc.speed.globalRate,root.override??doc.speed.globalRate)!==0)return fail('元時計を共有する分割片の異なる速度は再結合が必要です',[group.root.id,clip.id]);
    }
    const piece={clip,offset:s.projectionOffset??group.span,span:s.span};group.pieces.push(piece);byId.set(clip.id,{group:groups.length-1,piece});group.span=addTime(group.span,s.span);
  }
  const map=buildNativeSpeedProjection({family:doc.speed.family,globalRate:doc.speed.globalRate,originFrame:doc.speed.originFrame,tailOffsetFrames:0,
    clips:groups.map(g=>{const s=g.root.speed!;if(s.kind!=='main')return fail('主映像が不正です');return {ownerId:g.root.id,span:s.projectionExtent??g.span,...(s.override===undefined?{}:{override:s.override}),...(s.runHead?{runHead:s.runHead}:{}),...(s.overlapBefore?{overlapBefore:s.overlapBefore}:{})};})});
  const get=(id:string)=>{const found=byId.get(id);if(!found)return fail('投影片がありません',[id]);return {...found,root:groups[found.group]!.root.id};};
  // Explicit trim windows may extend past the original cell. Evaluate the same
  // exact phase formula; do not change the cell's overlap cap or later prefixes.
  const phases=new Map<string,Rational>();let phase=rational(0);
  for(const g of groups){const s=g.root.speed!;if(s.kind!=='main')return fail('主映像が不正です');if(s.runHead)phase=s.runHead.phase;phases.set(g.root.id,phase);phase=addTime(phase,s.projectionExtent??g.span);}
  const safe=(v:number)=>{if(!Number.isSafeInteger(v)||v<0)return fail('trim後の表示窓を保存できません');return v;};
  const extent=(root:string)=>{const g=groups.find(g=>g.root.id===root)!,s=g.root.speed!;return s.kind==='main'?(s.projectionExtent??g.span):g.span;};
  const rootPoint=(ownerId:string,offset:Rational)=>{
    const {root}=get(ownerId),at=map.entries.find(e=>e.ownerId===root)!.startFrame,r=map.rate(root),ph=phases.get(root)!;
    if(compareTime(offset,rational(0))>=0&&compareTime(offset,extent(root))<=0)return map.point({ownerId:root,kind:'clip',offset});
    return safe(at+(map.mode==='absolute'?roundSpeedTime(divideTime(addTime(ph,offset),r))-roundSpeedTime(divideTime(ph,r)):roundSpeedTime(divideTime(offset,r))));
  };
  const rootInverse=(ownerId:string,frame:number)=>{
    const {root}=get(ownerId),e=map.entries.find(e=>e.ownerId===root)!,r=map.rate(root),ph=phases.get(root)!;
    if(frame>=e.startFrame&&frame<=e.endFrame)return map.inverse(root,frame);
    if(!Number.isSafeInteger(frame))return fail('trim境界が不正です');
    return map.mode==='absolute'?subtractTime(multiplyTime(rational(frame-e.startFrame+roundSpeedTime(divideTime(ph,r))),r),ph):multiplyTime(rational(frame-e.startFrame),r);
  };
  const entries=groups.flatMap((g,i)=>g.pieces.map((p,j)=>{
    const start=rootPoint(g.root.id,p.offset),end=rootPoint(g.root.id,addTime(p.offset,p.span)),whole=map.entries[i]!;
    return {ownerId:p.clip.id,startFrame:start,endFrame:end,gapStartFrame:j===0?whole.gapStartFrame:start,gapEndFrame:j===0?whole.gapEndFrame:start,overlapBeforeFrames:j===0?whole.overlapBeforeFrames:0};
  }));
  const mainEndFrame=entries.at(-1)!.endFrame,sequenceEndFrame=safe(mainEndFrame+doc.speed.sequenceEndBasis.offsetFrames);
  const point=(ownerId:string,offset:Rational,kind:SpeedProjectionPart)=>{
    const {root,piece}=get(ownerId);
    if(kind==='clip'){
      if(!isRational(offset)||compareTime(offset,rational(0))<0||compareTime(offset,piece.span)>0)return fail('時刻が分割片の範囲外です',[ownerId]);
      return rootPoint(root,addTime(piece.offset,offset));
    }
    if(kind==='gap-before'&&ownerId!==root)return fail('分割片の途中に空白はありません',[ownerId]);
    if(kind==='after-main'&&ownerId!==mains.at(-1)?.id)return fail('分割片の途中に末尾はありません',[ownerId]);
    if(kind==='after-main'){if(doc.speed!.sequenceEndBasis.offsetFrames<=0||compareTime(offset,rational(0))<0||compareTime(offset,rational(doc.speed!.sequenceEndBasis.offsetFrames))>0)return fail('時刻が末尾の範囲外です');return safe(mainEndFrame+roundSpeedTime(offset));}
    return map.point({ownerId:root,kind,offset});
  };
  return {...map,entries,mainEndFrame,sequenceEndFrame,phase:id=>phases.get(get(id).root)!,rootStart:id=>map.entries.find(e=>e.ownerId===get(id).root)!.startFrame,rootSpan:id=>extent(get(id).root),offset:id=>get(id).piece.offset,rootPoint,rootInverse,point:p=>point(p.ownerId,p.offset,p.kind),rate:id=>map.rate(get(id).root),
    inverse(ownerId,frame,kind='clip'){
      const {root,piece}=get(ownerId);
      if(kind!=='clip'){
        if(kind==='gap-before'&&ownerId!==root)return fail('分割片の途中に空白はありません',[ownerId]);
        if(kind==='after-main'&&ownerId!==mains.at(-1)?.id)return fail('分割片の途中に末尾はありません',[ownerId]);
        if(kind==='after-main'){if(doc.speed!.sequenceEndBasis.offsetFrames<=0||!Number.isSafeInteger(frame)||frame<mainEndFrame||frame>sequenceEndFrame)return fail('時刻が末尾の範囲外です');return rational(frame-mainEndFrame);}
        return map.inverse(root,frame,kind);
      }
      const entry=entries.find(e=>e.ownerId===ownerId)!;
      if(!Number.isSafeInteger(frame)||frame<entry.startFrame||frame>entry.endFrame)return fail('切断点が分割片の範囲外です',[ownerId]);
      if(frame===entry.startFrame)return rational(0);if(frame===entry.endFrame)return piece.span;
      return subtractTime(rootInverse(root,frame),piece.offset);
    }};
}
export function captionLedgers(doc:SequenceDocument):SpeedCaptionLedger[]{return doc.clips.flatMap(c=>c.speed?.captions??[]);}
/** Follow final ordinary fragment IDs, not arbitrary clips claiming the same group. */
export function rebindCaptionContinuations(ledger:SpeedCaptionLedger,previous:SpeedCaptionLedger,fragments:ReadonlyMap<string,readonly {clip:SequenceClip;original:SequenceClip;slice:{from:number}}[]>):void {
  const groups=new Set(ledger.parts.filter(p=>p.continuationGroupId===p.reservedRenderId||p.continuationGroupId===ledger.captionId).map(p=>p.continuationGroupId!));
  const ids=new Set([...previous.parts.map(p=>p.reservedRenderId),...(previous.detachedContinuations??[]).map(p=>p.clipId)]);
  const peers=new Map<string,NonNullable<SpeedCaptionLedger['detachedContinuations']>[number]>();
  for(const id of ids)for(const {clip,original,slice} of fragments.get(id)??[])if(clip.anchor?.kind==='timeline'&&clip.content.kind==='telop'&&clip.continuationGroupId&&groups.has(clip.continuationGroupId)){
    const old=previous.detachedContinuations?.find(p=>p.clipId===id),mediaRate=old?.mediaRate??divideTime(original.clock.rate,previous.clock.slope);
    const origin=old?.sourceFrameOffset??divideTime(subtractTime(original.clock.offset,previous.clock.offset),previous.clock.slope);
    const sourceFrameOffset=addTime(origin,multiplyTime(rational(slice.from-original.startFrame),mediaRate));
    peers.set(clip.id,{clipId:clip.id,continuationGroupId:clip.continuationGroupId,sourceFrameOffset,mediaRate});
  }
  delete ledger.detachedContinuations;if(peers.size)ledger.detachedContinuations=[...peers.values()].sort((a,b)=>a.clipId<b.clipId?-1:1);
}
export function speedReservedIds(doc:SequenceDocument):string[]{return [...captionLedgers(doc).flatMap(l=>[l.captionId,...l.parts.flatMap(p=>[p.partId,p.reservedRenderId,...(p.continuationGroupId?[p.continuationGroupId]:[])])]),...doc.clips.flatMap(c=>timingReservedIds(c.speed?.operationBasis?.timing))];}
export const captionInputDigest=(value:unknown):string=>Array.from(sha256(new TextEncoder().encode(JSON.stringify(sort(value)))),b=>b.toString(16).padStart(2,'0')).join('');
/** Computed once per operation, never cached across mutable document versions. */
export function captionProjectionInput(doc:SequenceDocument):SpeedCaptionBaseline['input'] {
  if(!doc.speed)return fail('速度の保存基準がありません');
  return structuredClone({document:doc.speed,providers:doc.clips.filter(c=>c.speed).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(c=>{
    const {captions:_,captionBaselines:__,operationBasis:___,...basis}=c.speed!;return {id:c.id,basis};
  })});
}
export function captionDocumentDigest(doc:SequenceDocument):string {return captionInputDigest(captionProjectionInput(doc));}
/** Only explicit upgrade/structural edits can adopt a new baseline. */
function baselineCarrier(doc:SequenceDocument):SequenceClip|undefined{return doc.clips.find(c=>c.speed?.kind==='main'&&c.speed.order===0)??doc.clips.filter(c=>c.speed?.kind==='independent-audio').sort((a,b)=>a.id<b.id?-1:1)[0];}
export function refreshCaptionBaselines(doc:SequenceDocument):void {
  for(const c of doc.clips)if(c.speed)delete c.speed.captionBaselines;
  const ledgers=captionLedgers(doc);if(!ledgers.length)return;
  const input=captionProjectionInput(doc),key=captionInputDigest(input),projection=speedProjectionForDocument(doc);
  const carrier=baselineCarrier(doc);
  if(!carrier?.speed)return fail('字幕baselineの所有者がありません');
  carrier.speed.captionBaselines=[{key,input}];
  for(const ledger of ledgers)ledger.baselineProjection={snapshotKey:key,inputKey:captionProjectionKey(doc,ledger,key),parts:ledger.parts.map(p=>({partId:p.partId,...captionPartWindow(doc,p,projection)}))};
}
/** Reconstruct from saved historical inputs only. Current clips/times are not inputs.
 * The metadata validator then checks every saved basis/root/clock invariant. */
export function historicalDocument(current:SequenceDocument,input:SpeedCaptionBaseline['input']):SequenceDocument {
  object(input,['document','providers']);
  list(input.providers);if(!input.providers.length)fail('字幕baselineの所有者一覧が不正です');
  if(input.document?.version!==2||input.document.groupId!==current.speed?.groupId||!equal(input.document.fpsBasis,current.fps))fail('字幕baselineの保存版・文書所有者・fpsが不正です');
  const ids=new Set<string>();let previous='';
  for(const entry of input.providers){
    object(entry,['id','basis']);
    if(!id(entry.id)||ids.has(entry.id)||entry.id<=previous)fail('字幕baselineの所有者IDまたは順序が不正です');
    if([...current.assets,...current.tracks,...current.transitions].some(x=>x.id===entry.id))fail('字幕baselineの所有者IDが別要素と衝突しています');
    ids.add(entry.id);previous=entry.id;
    if(!entry.basis||Object.hasOwn(entry.basis,'captions')||Object.hasOwn(entry.basis,'captionBaselines')||Object.hasOwn(entry.basis,'operationBasis'))fail('字幕baselineに履歴を入れることはできません');
  }
  const doc:SequenceDocument={...current,speed:structuredClone(input.document),fps:structuredClone(input.document.fpsBasis),clips:[],transitions:[]};
  doc.clips=input.providers.map(({id,basis})=>({id,trackId:'baseline-visual',name:'baseline',startFrame:0,durationFrames:1,clock:{offset:rational(0),rate:rational(1),duration:rational(1)},speed:structuredClone(basis),content:{kind:'video',assetId:'pending',streamIndex:0,sourceIn:rational(0),rate:rational(1)}}));
  const projection=speedProjectionForDocument(doc),byId=new Map(doc.clips.map(c=>[c.id,c]));
  for(const clip of doc.clips){
    const s=clip.speed!;if(s.kind==='independent-audio'){const map=independentAudioMap(doc,clip);clip.startFrame=map.startFrame;clip.durationFrames=map.endFrame-map.startFrame;continue;}const owner=s.kind==='main'?clip.id:s.providerId,entry=projection.entries.find(e=>e.ownerId===owner);
    if(!entry||entry.endFrame<=entry.startFrame)fail('字幕baselineの表示範囲が不正です');
    clip.startFrame=entry.startFrame;clip.durationFrames=entry.endFrame-entry.startFrame;clip.linkGroupId=`baseline-link-${owner}`;
  }
  for(const clip of doc.clips){
    const s=clip.speed!,kind=s.kind==='main'?'video':'audio',owner=s.kind==='main'?clip.id:s.kind==='main-audio'?s.providerId:clip.id,rate=s.kind==='independent-audio'?s.mediaRate:projection.rate(owner);
    const asset=current.assets.find(a=>a.id===s.source.assetId);
    if(asset?.kind!=='media'||!asset.streams.some(st=>st.index===s.source.streamIndex&&st.kind===kind))fail('字幕baselineの素材streamがありません');
    const root=s.kind!=='independent-audio'&&s.evaluationOwnerId?byId.get(s.evaluationOwnerId):clip;
    if(!root?.speed)fail('字幕baselineの元所有者がありません');
    const rootOwner=root.speed.kind==='main'?root.id:root.speed.kind==='main-audio'?root.speed.providerId:root.id;
    const delta=s.kind!=='independent-audio'&&projection.evaluationDelta?projection.evaluationDelta(owner):clip.startFrame-(s.kind==='independent-audio'?independentAudioMap(doc,clip).rootStart:root.speed.evaluationSourceStart?projection.rootStart(rootOwner):root.startFrame);
    const sourceIn=addTime(root.speed.evaluationSourceStart??root.speed.source.sourceStart,divideTime(multiplyTime(rational(delta),rate),doc.fps));
    const clock=(b:SpeedClockBasis)=>({offset:addTime(b.offset,multiplyTime(rational(delta),multiplyTime(b.slope,rate))),rate:multiplyTime(b.slope,rate),duration:structuredClone(b.duration)});
    clip.clock=clock(s.clock);
    if(s.keyframeClock)clip.visual={layout:structuredClone(DEFAULT_MAIN_LAYOUT),opacity:1,keyframes:[],keyframeClock:clock(s.keyframeClock)};
    const common={assetId:s.source.assetId,streamIndex:s.source.streamIndex,sourceIn,rate};
    clip.content=kind==='video'?{kind,...common}:{kind,...common,role:'speech',loop:false,settings:{gainDb:0,muted:false,fadeInFrames:0,fadeOutFrames:0}};
  }
  const mains=projection.entries;
  for(let i=1;i<mains.length;i++){const a=mains[i-1]!,b=mains[i]!;if(b.startFrame<a.endFrame)doc.transitions.push({id:`baseline-transition-${i}`,trackId:'baseline-visual',outClipId:a.ownerId,inClipId:b.ownerId,startFrame:b.startFrame,durationFrames:a.endFrame-b.startFrame,kind:'crossfade'});}
  doc.sequenceEndFrame=projection.sequenceEndFrame;
  // No ledgers/tables in this document, so caption validation terminates here.
  validateNativeSpeedMetadata(doc,true);
  return doc;
}
function historicalBaselines(doc:SequenceDocument):Map<string,{doc:SequenceDocument;projection:NativeSpeedProjection}> {
  const result=new Map<string,{doc:SequenceDocument;projection:NativeSpeedProjection}>();
  for(const c of doc.clips)if(c.speed?.captionBaselines!==undefined){
    if(c.id!==baselineCarrier(doc)?.id||!Array.isArray(c.speed.captionBaselines)||!c.speed.captionBaselines.length)fail('字幕baselineテーブルの所有者が不正です');
    list(c.speed.captionBaselines);
    for(const snapshot of c.speed.captionBaselines){
      object(snapshot,['key','input']);
      if(typeof snapshot.key!=='string'||! /^[a-f0-9]{64}$/.test(snapshot.key)||result.has(snapshot.key)||captionInputDigest(snapshot.input)!==snapshot.key)fail('字幕baselineの入力識別が一致しません');
      const historical=historicalDocument(doc,snapshot.input);result.set(snapshot.key,{doc:historical,projection:speedProjectionForDocument(historical)});
    }
  }
  return result;
}
export function captionProjectionKey(doc:SequenceDocument,ledger:SpeedCaptionLedger,documentDigest=captionDocumentDigest(doc)):string {
  return captionInputDigest({documentDigest,...(ledger.detachedContinuations?{detachedContinuations:ledger.detachedContinuations}:{}),parts:ledger.parts.map(p=>({partId:p.partId,providerId:p.providerId,intentStart:p.intentStart,intentEnd:p.intentEnd,reservedRenderId:p.reservedRenderId}))});
}
export function captionPartWindow(doc:SequenceDocument,part:SpeedCaptionPart,projection:NativeSpeedProjection=speedProjectionForDocument(doc)):{startFrame:number;endFrame:number}{
  const provider=doc.clips.find(c=>c.id===part.providerId),s=provider?.speed;
  if(!provider||!s)return fail('字幕intentの所有者がありません',[part.providerId]);
  if(s.kind==='independent-audio'){const map=independentAudioMap(doc,provider);return {startFrame:map.point(multiplyTime(subtractTime(part.intentStart,s.evaluationSourceStart),doc.speed!.fpsBasis)),endFrame:map.point(multiplyTime(subtractTime(part.intentEnd,s.evaluationSourceStart),doc.speed!.fpsBasis))};}
  const owner=s.kind==='main'?provider:doc.clips.find(c=>c.id===s.providerId);
  if(owner?.speed?.kind!=='main')return fail('字幕intentの主所有者がありません',[part.providerId]);
  const p=projection,point=(source:Rational)=>p.point({ownerId:owner.id,kind:'clip',offset:multiplyTime(subtractTime(source,owner.speed!.source.sourceStart),doc.speed!.fpsBasis)});
  return {startFrame:point(part.intentStart),endFrame:point(part.intentEnd)};
}
/** Materialize only positive windows. No padding, clock reset, or zero-frame clip. */
export function materializeSpeedCaptions(doc:SequenceDocument):SequenceClip[]{
  const result:SequenceClip[]=[],projection=speedProjectionForDocument(doc);
  for(const ledger of captionLedgers(doc))for(const part of ledger.parts){
    const provider=doc.clips.find(c=>c.id===part.providerId)!;
    const {startFrame,endFrame}=captionPartWindow(doc,part,projection);if(startFrame===endFrame)continue;
    if(endFrame<startFrame||!isMediaContent(provider.content))fail('字幕intentの範囲が不正です');
    const sourceStart=sourceTimeAt(provider,startFrame,doc.fps),sourceEnd=sourceTimeAt(provider,endFrame,doc.fps);
    const units=multiplyTime(subtractTime(sourceStart,ledger.sourceOrigin),doc.speed!.fpsBasis);
    const current=(c:SpeedClockBasis)=>({offset:addTime(c.offset,multiplyTime(units,c.slope)),rate:multiplyTime(c.slope,provider.content.kind==='audio'||provider.content.kind==='video'?provider.content.rate:rational(1)),duration:structuredClone(c.duration)});
    const template=structuredClone(part.presentation?.template??ledger.template);
    if(template.visual&&ledger.keyframeClock)template.visual.keyframeClock=current(ledger.keyframeClock);
    result.push({...template,id:part.reservedRenderId,startFrame,durationFrames:endFrame-startFrame,clock:current(ledger.clock),
      ...(part.continuationGroupId?{continuationGroupId:part.continuationGroupId}:{}),
      anchor:{kind:'source',role:ledger.role,sourceAssetId:provider.content.assetId,clipOccurrenceId:provider.id,sourceStart,sourceEnd}});
  }
  return result;
}
/** A pre-registration cut can leave the original caption ID as the continuation
 * group on another source caption. Separate ledgers retain separate text/style
 * ownership. Only that explicit group use is shared, never a clip or link ID. */
function registeredContinuationPeer(doc:SequenceDocument,ledger:SpeedCaptionLedger,peer:SpeedCaptionLedger,clip:SequenceClip,value:string):boolean {
  if(peer===ledger||clip.anchor?.kind!=='source'||clip.content.kind!=='telop'||ledger.role!==peer.role)return false;
  const part=peer.parts.find(p=>p.reservedRenderId===clip.id&&p.continuationGroupId===value);
  const own=ledger.parts.find(p=>p.continuationGroupId===value);
  if(!part||!own||clip.continuationGroupId!==value)return false;
  const a=doc.clips.find(c=>c.id===own.providerId),b=doc.clips.find(c=>c.id===part.providerId);
  if(!a||!b||!isMediaContent(a.content)||!isMediaContent(b.content)||a.content.kind!==b.content.kind||a.content.assetId!==b.content.assetId||a.content.streamIndex!==b.content.streamIndex)return false;
  const sameClock=(x:SpeedClockBasis|undefined,y:SpeedClockBasis|undefined)=>{
    if(!x||!y)return x===y;
    if(![x.offset,x.slope,x.duration,y.offset,y.slope,y.duration,ledger.sourceOrigin,peer.sourceOrigin].every(isRational))return false;
    return compareTime(x.slope,y.slope)===0&&compareTime(x.duration,y.duration)===0&&compareTime(
      subtractTime(x.offset,multiplyTime(multiplyTime(ledger.sourceOrigin,doc.speed!.fpsBasis),x.slope)),
      subtractTime(y.offset,multiplyTime(multiplyTime(peer.sourceOrigin,doc.speed!.fpsBasis),y.slope)))===0;
  };
  return sameClock(ledger.clock,peer.clock)&&sameClock(ledger.keyframeClock,peer.keyframeClock);
}
export function validateSpeedCaptions(doc:SequenceDocument):void {
  const ledgers=captionLedgers(doc);
  if(doc.speed?.version!==2){if(ledgers.length||doc.clips.some(c=>c.speed?.captionBaselines!==undefined))fail('v1には字幕intentを保存できません');return;}
  if(!ledgers.length&&!doc.clips.some(c=>c.speed?.captionBaselines!==undefined))return;
  const baselines=historicalBaselines(doc),usedBaselines=new Set<string>();
  const documentDigest=captionDocumentDigest(doc),projection=speedProjectionForDocument(doc);
  const logical=new Set<string>(),parts=new Set<string>(),render=new Set<string>();
  const occupied=new Set([...doc.tracks,...doc.assets,...doc.transitions].map(v=>v.id));
  const objectIds=new Set([...occupied,...doc.clips.flatMap(c=>[c.id,c.linkGroupId,c.continuationGroupId].filter((x):x is string=>typeof x==='string')),...ledgers.map(l=>l.captionId),...ledgers.flatMap(l=>l.parts.map(p=>p.reservedRenderId))]);
  // Index actual identity uses once per validation. A ledger only queries its
  // own logical/render IDs; rebuilding all foreign clip IDs per ledger is O(L*C).
  // Keep the use kind: a proven continuation peer never exempts a clip/link ID.
  const identityUses=new Map<string,Array<{clip:SequenceClip;kind:'id'|'linkGroupId'|'continuationGroupId'}>>();
  const renderOwners=new Map<string,SpeedCaptionLedger[]>();
  for(const ledger of ledgers)for(const part of ledger.parts){const owners=renderOwners.get(part.reservedRenderId)??[];owners.push(ledger);renderOwners.set(part.reservedRenderId,owners);}
  for(const clip of doc.clips)for(const kind of ['id','linkGroupId','continuationGroupId'] as const){
    const value=clip[kind];if(typeof value!=='string')continue;
    const uses=identityUses.get(value)??[];uses.push({clip,kind});identityUses.set(value,uses);
  }
  for(const carrier of doc.clips)for(const ledger of carrier.speed?.captions??[]){
    object(ledger,['captionId','template','role','sourceOrigin','clock','parts','baselineProjection'],['keyframeClock','detachedContinuations']);
    if(!id(ledger.captionId)||logical.has(ledger.captionId)||!['speech','visual'].includes(ledger.role)||!Array.isArray(ledger.parts)||!ledger.parts.length)fail('字幕intentの所有関係が不正です');
    const ownRender=new Set(ledger.parts.map(p=>p.reservedRenderId));
    const peers=new Map<string,string>();
    if(ledger.detachedContinuations!==undefined){
      const list=ledger.detachedContinuations;if(!Array.isArray(list)||!list.length)fail('字幕の切離し断片参照が不正です');let previous='';
      for(const value of list){const peer=object(value,['clipId','continuationGroupId','sourceFrameOffset','mediaRate']);if(!id(peer.clipId)||!id(peer.continuationGroupId)||peer.clipId<=previous)fail('字幕の切離し断片参照が重複または不正です');previous=peer.clipId;
        const c=doc.clips.find(c=>c.id===peer.clipId);
        if(!c||c.content.kind!=='telop'||c.anchor?.kind!=='timeline'||c.continuationGroupId!==peer.continuationGroupId||c.speed||ledgers.some(l=>l.captionId===c.id||l.parts.some(p=>p.reservedRenderId===c.id))||!ledger.parts.some(p=>p.continuationGroupId===peer.continuationGroupId&&(p.reservedRenderId===peer.continuationGroupId||ledger.captionId===peer.continuationGroupId)))fail('字幕の切離し断片の所有関係が不正です');
        time(peer.sourceFrameOffset,false,true);time(peer.mediaRate,true);
        const expectedClock=(basis:SpeedClockBasis)=>({offset:addTime(basis.offset,multiplyTime(peer.sourceFrameOffset as Rational,basis.slope)),rate:multiplyTime(peer.mediaRate as Rational,basis.slope),duration:basis.duration});
        if(!equal(c.clock,expectedClock(ledger.clock))||Boolean(c.visual?.keyframeClock)!==Boolean(ledger.keyframeClock)||(ledger.keyframeClock&&!equal(c.visual?.keyframeClock,expectedClock(ledger.keyframeClock))))fail('字幕の切離し断片が元時計と一致しません');
        peers.set(c.id,peer.continuationGroupId);
      }
    }
    const isForeign=(value:string)=>occupied.has(value)||(identityUses.get(value)??[]).some(({clip,kind})=>{
      if(ownRender.has(clip.id))return false;
      if(kind!=='continuationGroupId')return true;
      if(peers.get(clip.id)===clip.continuationGroupId)return false;
      const owners=renderOwners.get(clip.id);return owners?.length!==1||!registeredContinuationPeer(doc,ledger,owners[0]!,clip,value);
    });
    if(isForeign(ledger.captionId)||ledger.parts.some(p=>isForeign(p.reservedRenderId))||ledgers.some(other=>other!==ledger&&ownRender.has(other.captionId)))fail('字幕の論理IDまたは予約IDが別要素と衝突しています');
    logical.add(ledger.captionId);time(ledger.sourceOrigin);clock(ledger.clock);if(ledger.keyframeClock)clock(ledger.keyframeClock);
    const t=object(ledger.template,['trackId','name','content'],['visual','linkGroupId','legacyCaptionContinuity']);
    if(t.legacyCaptionContinuity!==undefined&&!isLegacyCaptionPolicy(t.legacyCaptionContinuity))fail('旧字幕の時計証拠が不正です');
    if((t.content as {kind?:string})?.kind!=='telop')fail('この字幕intentにはテロップが必要です');
    if(ledger.keyframeClock&&!t.visual)fail('字幕の専用時計に対応する映像設定がありません');
    if(t.visual&&Object.hasOwn(t.visual as object,'keyframeClock'))fail('字幕の専用時計が二重に保存されています');
    const baseline=object(ledger.baselineProjection,['snapshotKey','inputKey','parts']);if(typeof baseline.inputKey!=='string'||! /^[a-f0-9]{64}$/.test(baseline.inputKey))fail('字幕baselineの識別が不正です');
    const historical=baselines.get(ledger.baselineProjection.snapshotKey);if(!historical)fail('字幕baselineの保存入力がありません');
    usedBaselines.add(ledger.baselineProjection.snapshotKey);
    if(captionProjectionKey(historical.doc,ledger,ledger.baselineProjection.snapshotKey)!==baseline.inputKey)fail('字幕baselineのpart識別が一致しません');
    if(!Array.isArray(baseline.parts)||baseline.parts.length!==ledger.parts.length)fail('字幕baselineの範囲が不正です');
    for(const part of ledger.parts){
      object(part,['partId','providerId','intentStart','intentEnd','reservedRenderId'],['continuationGroupId','presentation']);
      if(!id(part.partId)||!id(part.providerId)||!id(part.reservedRenderId)||parts.has(part.partId)||objectIds.has(part.partId)||render.has(part.reservedRenderId)||occupied.has(part.reservedRenderId)|| (part.continuationGroupId!==undefined&&!id(part.continuationGroupId)))fail('字幕の予約IDが衝突しています');
      if(part.presentation!==undefined){
        const presentation=object(part.presentation,['template']),t=object(presentation.template,['trackId','name','content'],['visual','linkGroupId','legacyCaptionContinuity']);
        if(t.legacyCaptionContinuity!==undefined&&!isLegacyCaptionPolicy(t.legacyCaptionContinuity))fail('旧字幕partの時計証拠が不正です');
        if((t.content as {kind?:string})?.kind!=='telop'||t.trackId!==ledger.template.trackId||t.linkGroupId!==ledger.template.linkGroupId)fail('字幕partの表示所有関係が不正です');
        if(ledger.keyframeClock&&!t.visual)fail('字幕partの専用時計に映像設定がありません');
        if(t.visual&&Object.hasOwn(t.visual as object,'keyframeClock'))fail('字幕partの専用時計が二重に保存されています');
      }
      parts.add(part.partId);render.add(part.reservedRenderId);time(part.intentStart);time(part.intentEnd,true);
      for(const inputDoc of [doc,historical.doc]){
        const provider=inputDoc.clips.find(c=>c.id===part.providerId),source=provider?.speed?.source;
        if(!source||!isMediaContent(provider!.content)||(ledger.role==='speech'?provider!.content.kind!=='audio'||provider!.content.role!=='speech':provider!.content.kind!=='video')||compareTime(part.intentStart,part.intentEnd)>=0||compareTime(part.intentStart,source.sourceStart)<0||compareTime(part.intentEnd,source.sourceEnd)>0)fail('字幕intentが所有者の素材範囲外です',[part.providerId]);
      }
      const b=ledger.baselineProjection.parts.find((x:unknown)=>(x as {partId?:string})?.partId===part.partId);
      if(!b)fail('字幕baselineのpartがありません');object(b,['partId','startFrame','endFrame']);if(!Number.isSafeInteger(b.startFrame)||b.startFrame<0||!Number.isSafeInteger(b.endFrame)||b.endFrame<b.startFrame)fail('字幕baselineの表示範囲が不正です');
      if(!equal(captionPartWindow(historical.doc,part,historical.projection),{startFrame:b.startFrame,endFrame:b.endFrame}))fail('字幕baselineと保存入力の投影が一致しません');
    }
    if(!ledger.parts.some(p=>p.providerId===carrier.id))fail('字幕ledgerのcarrierが所有者ではありません');
  }
  if(usedBaselines.size!==baselines.size)fail('参照されない字幕baselineがあります');
  for(const ledger of ledgers)if(ledger.parts.every(p=>{const w=captionPartWindow(doc,p,projection);return w.startFrame===w.endFrame;})&&captionProjectionKey(doc,ledger,documentDigest)!==ledger.baselineProjection.inputKey)fail('速度変更で字幕全体が表示できなくなります',[ledger.captionId]);
  const expected=materializeSpeedCaptions(doc),byId=new Map(expected.map(c=>[c.id,c]));
  for(const clip of doc.clips){
    if(render.has(clip.id)){if(!equal(clip,byId.get(clip.id)))fail('字幕intentから再生成した表示と一致しません',[clip.id]);byId.delete(clip.id);}
    else {const anchor=clip.anchor;if(anchor?.kind==='source'&&doc.clips.find(c=>c.id===anchor.clipOccurrenceId)?.speed)fail('登録所有者の字幕intentがありません',[clip.id]);}
  }
  if(byId.size)fail('字幕intentの表示クリップがありません',[...byId.keys()]);
}
/** Explicit v1 -> v2. Existing main/audio basis is copied, never resampled. */
export function upgradeNativeSpeedMetadata(doc:SequenceDocument):SequenceDocument {
  if(!doc.speed)return fail('先に速度の所有者を登録してください');
  if(doc.speed.version===2)return doc;
  if(doc.speed.version!==1)return fail('未対応の速度保存版です');
  const next=structuredClone(doc);next.speed!.version=2;
  adoptSpeedSourceCaptions(next,next.clips.map(c=>c.id));
  refreshCaptionBaselines(next);validateSpeedCaptions(next);return next;
}

/** Explicit insertion adopts only supplied source captions; existing ledgers are untouched. */
export function adoptSpeedSourceCaptions(doc:SequenceDocument,clipIds:readonly string[]):void {
  if(doc.speed?.version!==2)fail('字幕採取にはv2速度基準が必要です');
  normalizeLegacyCaptionContinuations(doc,new Set(clipIds));
  const used=new Set([...doc.clips.flatMap(c=>[c.id,c.linkGroupId,c.continuationGroupId].filter((x):x is string=>typeof x==='string')),...doc.assets.map(c=>c.id),...doc.tracks.map(c=>c.id),...doc.transitions.map(c=>c.id),...speedReservedIds(doc)]);let serial=0;
  const fresh=()=>{let value:string;do{value=`caption-part-${++serial}`;}while(used.has(value));used.add(value);return value;};
  for(const clip of doc.clips.filter(c=>clipIds.includes(c.id))){
    const anchor=clip.anchor;if(anchor?.kind!=='source')continue;
    const provider=doc.clips.find(c=>c.id===anchor.clipOccurrenceId);if(!provider?.speed)continue;
    if(clip.content.kind!=='telop'||!isMediaContent(provider.content))fail('未対応のsource字幕です',[clip.id]);
    const {id:captionId,startFrame,durationFrames,clock,anchor:_,speed:__,continuationGroupId,...template}=structuredClone(clip);
    const basis=(c:typeof clock):SpeedClockBasis=>({offset:c.offset,slope:divideTime(c.rate,provider.content.kind==='video'||provider.content.kind==='audio'?provider.content.rate:rational(1)),duration:c.duration});
    const key=template.visual?.keyframeClock;if(template.visual)delete template.visual.keyframeClock;
    // Materialized sourceIn may differ from saved intent after rounded splits.
    // Adopt the selected display endpoints through their explicit owner's inverse.
    const speed=provider.speed;
    const projection=speed.kind==='independent-audio'?undefined:speedProjectionForDocument(doc);
    const independent=speed.kind==='independent-audio'?independentAudioMap(doc,provider):undefined;
    const intentAt=(frame:number)=>addTime(speed.kind==='independent-audio'?speed.evaluationSourceStart:speed.source.sourceStart,divideTime(independent?independent.inverse(frame):projection!.inverse(speed.kind==='main'?provider.id:(speed as {providerId:string}).providerId,frame),doc.speed!.fpsBasis));
    const part:SpeedCaptionPart={partId:fresh(),providerId:provider.id,intentStart:intentAt(startFrame),intentEnd:intentAt(startFrame+durationFrames),reservedRenderId:captionId,...(continuationGroupId?{continuationGroupId}:{})};
    const ledger:SpeedCaptionLedger={captionId,template,role:anchor.role,sourceOrigin:structuredClone(anchor.sourceStart),clock:basis(clock),...(key?{keyframeClock:basis(key)}:{}),parts:[part],baselineProjection:{snapshotKey:'',inputKey:'',parts:[{partId:part.partId,startFrame,endFrame:startFrame+durationFrames}]}};
    (provider.speed.captions??=[]).push(ledger);
  }
}
