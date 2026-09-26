import {validateOperationBasis} from './speedOperationBasis';
import {independentAudioMap} from './speedTopologyProjection';
import {type DocumentSpeedProjection,speedProjectionForDocument,validateSpeedCaptions} from './speedCaptionLedger';
import {SequenceError} from './errors';
import {clipEnd,isMediaContent,sourceTimeAt,type EffectClock,type NativeClipSpeedMetadata,type SequenceClip,type SequenceDocument,type SpeedClockBasis,type SpeedSourceBasis} from './model';
import {buildNativeSpeedProjection,type NativeSpeedProjection} from './speedProjection';
import {addTime,subtractTime,compareTime,divideTime,isRational,multiplyTime,rational,type Rational} from './time';

/** Private core command only. Public exposure follows structural-command/ledger rebinding. */
export interface RegisterNativeSpeedCommand {
  type:'register-native-speed';
  groupId:string;
  mainClipIds:string[];
  mainAudioBindings:{audioClipId:string;providerId:string}[];
}
type MainMetadata=Extract<NativeClipSpeedMetadata,{kind:'main'}>;
type MainClip=SequenceClip & {speed:MainMetadata};
function fail(message:string,targets:string[]=[]):never {throw new SequenceError('INVALID_DOCUMENT',message,targets);}
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const integer=(v:unknown,min=0):v is number=>Number.isSafeInteger(v)&&(v as number)>=min;
function object(value:unknown,required:string[],optional:string[]=[],targets:string[]=[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))fail('速度の保存基準の形式が不正です',targets);
  const result=value as Record<string,unknown>,allowed=new Set([...required,...optional]);
  if(required.some(key=>result[key]===undefined)||Object.keys(result).some(key=>!allowed.has(key)))fail('速度の保存基準に不足または未対応の項目があります',targets);
  return result;
}
function list(value:unknown):asserts value is unknown[] {
  if(!Array.isArray(value)||Object.keys(value).length!==value.length||Object.keys(value).some((key,index)=>key!==String(index)))fail('速度登録の一覧に未定義の要素または余分な項目があります');
}
function owned<T>(id:string,operation:()=>T):T {
  try{return operation();}catch(error){
    if(error instanceof SequenceError&&!error.targets.length)throw new SequenceError(error.code,error.message,[id]);
    throw error;
  }
}
function signedTime(value:unknown,targets:string[]=[]):asserts value is Rational {
  object(value,['num','den'],[],targets);
  if(!isRational(value))fail('速度の保存時刻が不正です',targets);
}
function time(value:unknown,positive=false,targets:string[]=[]):asserts value is Rational {
  signedTime(value,targets);
  if(positive?value.num<=0:value.num<0)fail('速度の保存時刻が不正です',targets);
}
function same(a:Rational,b:Rational,label:string,id?:string):void {
  if(compareTime(a,b)!==0)fail(`速度基準から再生成した${label}が現在の文書と一致しません`,id?[id]:[]);
}
function validateClock(value:unknown,id:string):asserts value is SpeedClockBasis {
  const v=object(value,['offset','slope','duration'],[],[id]);
  // Existing effect and key clocks can start before zero. Preserve that origin;
  // only slope and duration are required to be positive in the v2 contract.
  signedTime(v.offset,[id]);time(v.slope,true,[id]);time(v.duration,true,[id]);
}
function validateSource(value:unknown,id:string):asserts value is SpeedSourceBasis {
  const v=object(value,['assetId','streamIndex','sourceStart','sourceEnd'],[],[id]);
  if(!validId(v.assetId)||!integer(v.streamIndex))fail('速度基準の素材参照が不正です',[id]);
  time(v.sourceStart,false,[id]);time(v.sourceEnd,true,[id]);
  if(compareTime(v.sourceStart,v.sourceEnd)>=0)fail('速度基準の素材範囲が不正です',[id]);
}
function clockBasis(clock:EffectClock,rate:Rational):SpeedClockBasis {
  return {offset:structuredClone(clock.offset),slope:divideTime(clock.rate,rate),duration:structuredClone(clock.duration)};
}
function compareClock(current:EffectClock,basis:SpeedClockBasis,rate:Rational,id:string,delta=0):void {
  same(current.offset,addTime(basis.offset,multiplyTime(rational(delta),multiplyTime(basis.slope,rate))),'時計の原点',id);same(current.rate,multiplyTime(basis.slope,rate),'時計の勾配',id);same(current.duration,basis.duration,'時計の全長',id);
}
function compareClocks(clip:SequenceClip,basis:NativeClipSpeedMetadata,rate:Rational,delta=0):void {
  compareClock(clip.clock,basis.clock,rate,clip.id,delta);
  const key=clip.visual?.keyframeClock;
  if(Boolean(key)!==Boolean(basis.keyframeClock))fail('専用キー時計の有無が速度基準と一致しません',[clip.id]);
  if(key&&basis.keyframeClock)compareClock(key,basis.keyframeClock,rate,clip.id,delta);
}
function sourceBasis(clip:SequenceClip,doc:SequenceDocument):SpeedSourceBasis {
  if(!isMediaContent(clip.content))fail('主映像と原音の対象を明示してください',[clip.id]);
  return {assetId:clip.content.assetId,streamIndex:clip.content.streamIndex,sourceStart:structuredClone(clip.content.sourceIn),sourceEnd:sourceTimeAt(clip,clipEnd(clip),doc.fps)};
}
function compareSource(clip:SequenceClip,source:SpeedSourceBasis,coverageStart=source.sourceStart):void {
  if(!isMediaContent(clip.content)||clip.content.assetId!==source.assetId||clip.content.streamIndex!==source.streamIndex)fail('速度基準の素材と現在の素材が一致しません',[clip.id]);
  same(clip.content.sourceIn,coverageStart,'素材開始',clip.id);
}
function binding(audio:SequenceClip,provider:SequenceClip):void {
  if(audio.content.kind!=='audio'||provider.content.kind!=='video'||audio.startFrame!==provider.startFrame||audio.durationFrames!==provider.durationFrames
    ||audio.content.assetId!==provider.content.assetId||!audio.linkGroupId||audio.linkGroupId!==provider.linkGroupId)
    fail('明示した主映像と原音の使用箇所・編集リンクが一致しません',[audio.id,provider.id]);
  same(audio.content.sourceIn,provider.content.sourceIn,'原音の素材開始',audio.id);same(audio.content.rate,provider.content.rate,'原音の速度',audio.id);
}
/** Every member of an existing editing link must have an explicit compatible role. */
function linkedRoles(doc:SequenceDocument,mains:MainClip[]):void {
  for(const main of mains){
    if(!main.linkGroupId)continue;
    for(const member of doc.clips){
      if(member.id===main.id||member.linkGroupId!==main.linkGroupId)continue;
      if(member.speed?.kind!=='main-audio'||member.speed.providerId!==main.id)fail('編集リンクの原音を明示してから速度登録してください',[main.id,member.id]);
    }
  }
}
function projection(doc:SequenceDocument,mains:MainClip[]):NativeSpeedProjection {
  const speed=doc.speed!;
  if(speed.version===2)return speedProjectionForDocument(doc);
  // Only saved metadata is an input. In particular live starts, gaps and rates
  // must never be used here to make a stale basis appear self-consistent.
  return buildNativeSpeedProjection({family:speed.family,globalRate:speed.globalRate,originFrame:speed.originFrame,tailOffsetFrames:speed.sequenceEndBasis.offsetFrames,
    clips:mains.map(({id,speed:s})=>({ownerId:id,span:s.span,...(s.override===undefined?{}:{override:s.override}),
      ...(s.runHead===undefined?{}:{runHead:s.runHead}),...(s.overlapBefore===undefined?{}:{overlapBefore:s.overlapBefore})}))});
}

/** Called after ordinary document validation; no recursive validate/serialize calls. */
export function validateNativeSpeedMetadata(doc:SequenceDocument,projectionOnly=false):void {
  if(!projectionOnly)validateOperationBasis(doc);
  const registered=doc.clips.filter(c=>c.speed!==undefined);
  if(doc.speed===undefined){if(registered.length)fail('文書の速度基準がないクリップがあります',registered.map(c=>c.id));return;}
  const d=object(doc.speed,['version','family','groupId','originFrame','fpsBasis','globalRate','sequenceEndBasis'],['projectionPolicy']);
  if((d.version!==1&&d.version!==2)||d.family!=='native-exact-v1'||!validId(d.groupId)||!integer(d.originFrame))fail('文書の速度基準が不正です');
  if(d.projectionPolicy!==undefined&&(d.version!==2||d.projectionPolicy!=='split-rate-v1'))fail('未対応の速度投影policyです');
  time(d.fpsBasis,true);time(d.globalRate,true);if(compareTime(doc.speed.globalRate,rational(1,10))<0||compareTime(doc.speed.globalRate,rational(16))>0)fail('速度が範囲外です');same(doc.fps,doc.speed.fpsBasis,'fps');
  const end=object(d.sequenceEndBasis,['kind','offsetFrames'],['endFrame']);
  if(end.kind==='empty-fixed'){if(d.version!==2||end.offsetFrames!==0||!integer(end.endFrame))fail('空の主系列の完成尺が不正です');}
  else if(end.kind!=='main-offset'||Object.hasOwn(end,'endFrame')||!Number.isSafeInteger(end.offsetFrames))fail('速度基準の完成尺が不正です');
  const mains:MainClip[]=[];
  for(const clip of registered){
    const raw=clip.speed as unknown;
    if(!raw||typeof raw!=='object')fail('クリップの速度基準が不正です',[clip.id]);
    const kind=(raw as {kind?:unknown}).kind;
    if(kind==='main'){
      const s=object(raw,['kind','groupId','order','span','source','clock'],['override','runHead','overlapBefore','keyframeClock',...(d.version===2?['operationBasis','captions','captionBaselines','evaluationOwnerId','evaluationSourceStart','projectionExtent','projectionOffset','structuralPlacement']:[])],[clip.id]);
      if(clip.content.kind!=='video'||s.groupId!==doc.speed.groupId||!integer(s.order))fail('主映像の速度基準の所有関係が不正です',[clip.id]);
      time(s.span,true,[clip.id]);if(s.override!==undefined){time(s.override,true,[clip.id]);if(compareTime(s.override as Rational,rational(1,10))<0||compareTime(s.override as Rational,rational(16))>0)fail('個別速度が範囲外です',[clip.id]);}
      if(s.overlapBefore!==undefined)time(s.overlapBefore,true,[clip.id]);
      if(s.runHead!==undefined){const h=object(s.runHead,['phase','gapFrames'],[],[clip.id]);time(h.phase,false,[clip.id]);if(!integer(h.gapFrames))fail('速度基準の空白が不正です',[clip.id]);}
      mains.push(clip as MainClip);
    }else if(kind==='main-audio'){
      const s=object(raw,['kind','providerId','source','clock'],['keyframeClock',...(d.version===2?['operationBasis','captions','captionBaselines','evaluationOwnerId','evaluationSourceStart']:[])],[clip.id]);
      if(clip.content.kind!=='audio'||!validId(s.providerId))fail('原音の速度基準が不正です',[clip.id]);
    }else if(kind==='independent-audio'&&d.version===2){const s=object(raw,['kind','placement','mediaRate','projection','evaluationSourceStart','source','clock'],['keyframeClock','captions','captionBaselines','operationBasis'],[clip.id]);if(clip.content.kind!=='audio')fail('独立音声の種類が不正です',[clip.id]);const placement=object(s.placement,['startFrame']);if(!integer(placement.startFrame))fail('独立音声の配置が不正です',[clip.id]);time(s.mediaRate,true,[clip.id]);if(compareTime(s.mediaRate as Rational,rational(1,10))<0||compareTime(s.mediaRate as Rational,rational(16))>0)fail('独立音声の速度が範囲外です',[clip.id]);const p=object(s.projection,['mode','phase','offset']);if(p.mode!=='absolute'&&p.mode!=='cumulative')fail('独立音声の丸め方式が不正です',[clip.id]);signedTime(p.phase,[clip.id]);if(p.mode==='cumulative'&&compareTime(p.phase as Rational,rational(0))!==0)fail('独立音声の累積位相は0です',[clip.id]);signedTime(p.offset,[clip.id]);time(s.evaluationSourceStart,false,[clip.id]);
    }else fail('未対応の速度基準です',[clip.id]);
    const metadata=clip.speed!;
    if(metadata.kind!=='independent-audio'&&metadata.evaluationSourceStart!==undefined){time(metadata.evaluationSourceStart,false,[clip.id]);if(metadata.evaluationOwnerId!==clip.id)fail('仮想時計の原点は先頭ownerだけが所有します',[clip.id]);if(metadata.kind==='main'&&metadata.projectionExtent===undefined)fail('仮想時計には元投影全長が必要です',[clip.id]);}
    if(metadata.kind==='main'&&(metadata.projectionOffset!==undefined||metadata.projectionExtent!==undefined)){
      signedTime(metadata.projectionOffset,[clip.id]);
      if(!metadata.evaluationOwnerId)fail('trim窓には元ownerが必要です',[clip.id]);
      if(metadata.evaluationOwnerId===clip.id){time(metadata.projectionExtent,true,[clip.id]);if(metadata.evaluationSourceStart===undefined)fail('trim窓の元source時計がありません',[clip.id]);same(metadata.evaluationSourceStart,subtractTime(metadata.source.sourceStart,divideTime(metadata.projectionOffset!,doc.speed.fpsBasis)),'trim元source原点',clip.id);}
      else if(metadata.projectionExtent!==undefined)fail('投影全長は先頭ownerだけが所有します',[clip.id]);
    }
    if(metadata.kind==='main'&&metadata.structuralPlacement!==undefined){const a=object(metadata.structuralPlacement,['phase','gapFrames','anchorStart','anchorEnd'],[],[clip.id]);signedTime(a.phase,[clip.id]);signedTime(a.anchorStart,[clip.id]);signedTime(a.anchorEnd,[clip.id]);if(!integer(a.gapFrames)||compareTime(a.anchorStart as Rational,a.anchorEnd as Rational)>=0||metadata.evaluationOwnerId!==clip.id||metadata.projectionExtent===undefined||metadata.runHead!==undefined)fail('構造配置の保存基準が不正です',[clip.id]);}
    validateSource(clip.speed!.source,clip.id);validateClock(clip.speed!.clock,clip.id);
    if(clip.speed!.keyframeClock!==undefined)validateClock(clip.speed!.keyframeClock,clip.id);
  }
  mains.sort((a,b)=>a.speed.order-b.speed.order);
  if((!mains.length&&end.kind!=='empty-fixed')||(mains.length&&end.kind==='empty-fixed')||mains.some((c,index)=>c.speed.order!==index))fail('主映像の速度基準の順序が不正です',mains.map(c=>c.id));
  const p=projection(doc,mains);
  const byId=new Map(mains.map(c=>[c.id,c]));
  const allById=new Map(doc.clips.map(c=>[c.id,c]));
  const evaluation=(clip:SequenceClip,rate:Rational)=>{
    const s=clip.speed!;
    if(s.kind==='independent-audio')return fail('主時計の所有者が独立音声です',[clip.id]);
    if(s.evaluationOwnerId===undefined)return {delta:0,sourceStart:s.source.sourceStart};
    if(doc.speed!.version!==2||!validId(s.evaluationOwnerId))fail('元時計の所有者が不正です',[clip.id]);
    const origin=allById.get(s.evaluationOwnerId),o=origin?.speed;
    if(!origin||!o||o.kind==='independent-audio'||o.kind!==s.kind||o.evaluationOwnerId!==origin.id||origin.startFrame>clip.startFrame||o.source.assetId!==s.source.assetId||o.source.streamIndex!==s.source.streamIndex)fail('元時計の所有関係が不正です',[clip.id]);
    same(s.clock.offset,o.clock.offset,'元時計の原点',clip.id);same(s.clock.slope,o.clock.slope,'元時計の勾配',clip.id);same(s.clock.duration,o.clock.duration,'元時計の全長',clip.id);
    if(Boolean(s.keyframeClock)!==Boolean(o.keyframeClock))fail('元キー時計の有無が不正です',[clip.id]);
    if(s.keyframeClock&&o.keyframeClock){same(s.keyframeClock.offset,o.keyframeClock.offset,'元キー時計原点',clip.id);same(s.keyframeClock.slope,o.keyframeClock.slope,'元キー時計勾配',clip.id);same(s.keyframeClock.duration,o.keyframeClock.duration,'元キー時計全長',clip.id);}
    if(s.kind==='main'&&s.projectionOffset!==undefined&&(o.kind!=='main'||o.projectionExtent===undefined))fail('trim片の元投影全長がありません',[clip.id]);
    const originRate=o.kind==='main'?p.rate(origin.id):p.rate(o.providerId);
    if(compareTime(originRate,rate)!==0&&doc.speed!.projectionPolicy!=='split-rate-v1')fail('元時計を共有する分割片の異なる速度は再結合が必要です',[origin.id,clip.id]);
    const rootId=o.kind==='main'?origin.id:o.providerId;
    const ownerId=s.kind==='main'?clip.id:s.providerId;
    const delta=(p as DocumentSpeedProjection).evaluationDelta?.(ownerId)??(clip.startFrame-(o.evaluationSourceStart===undefined?origin.startFrame:(p as DocumentSpeedProjection).rootStart(rootId)));
    return {delta,sourceStart:addTime(o.evaluationSourceStart??o.source.sourceStart,divideTime(multiplyTime(rational(delta),rate),doc.speed!.fpsBasis))};
  };
  // Split descendants form a contiguous intent chain owned by the surviving first
  // fragment. This is saved ownership, not a lookup by asset or live sourceIn.
  for(const root of mains.filter(c=>c.speed.evaluationOwnerId===c.id)){
    const family=mains.filter(c=>c.speed.evaluationOwnerId===root.id);let source=root.speed.source.sourceStart;
    for(const [i,c] of family.entries()){
      if(c.speed.order!==root.speed.order+i)fail('元時計の分割片が連続していません',[c.id]);
      if(root.speed.projectionExtent===undefined)same(c.speed.source.sourceStart,source,'分割intentの接続',c.id);
      else {if(c.speed.projectionOffset===undefined)fail('trim片のoffsetがありません',[c.id]);const origin=subtractTime(root.speed.source.sourceStart,divideTime(root.speed.projectionOffset!,doc.speed!.fpsBasis));same(c.speed.source.sourceStart,addTime(origin,divideTime(c.speed.projectionOffset,doc.speed!.fpsBasis)),'trim片のintent',c.id);if(i>0&&compareTime(c.speed.source.sourceStart,source)<0)fail('同じ元ownerのtrim窓が重なっています',[c.id]);}
      source=c.speed.source.sourceEnd;
    }
  }
  for(const [index,main] of mains.entries()){
    const entry=p.entries[index]!,s=main.speed,rate=p.rate(main.id);
    if(main.startFrame!==entry.startFrame||clipEnd(main)!==entry.endFrame)fail('速度基準から再生成した配置が現在の文書と一致しません',[main.id]);
    if(main.content.kind!=='video')fail('主映像が映像ではありません',[main.id]);
    same(main.content.rate,rate,'素材速度',main.id);const e=evaluation(main,rate);compareSource(main,s.source,e.sourceStart);compareClocks(main,s,rate,e.delta);
    same(s.source.sourceEnd,addTime(s.source.sourceStart,divideTime(s.span,doc.speed.fpsBasis)),'素材終了intent',main.id);
    const previous=mains[index-1];
    if(previous&&main.startFrame<clipEnd(previous)){
      const transitions=doc.transitions.filter(t=>t.outClipId===previous.id&&t.inClipId===main.id);
      if(transitions.length!==1||previous.trackId!==main.trackId)fail('主映像の重なりに対応する転換を明示してください',[previous.id,main.id]);
    }
  }
  if(p.sequenceEndFrame!==doc.sequenceEndFrame)fail('速度基準から再生成した完成尺が現在の文書と一致しません',mains.length?[mains.at(-1)!.id]:[]);
  for(const clip of registered){
    const s=clip.speed!;if(s.kind==='independent-audio'){const map=independentAudioMap(doc,clip);if(clip.startFrame!==map.startFrame||clipEnd(clip)!==map.endFrame||clip.content.kind!=='audio')fail('独立音声の配置が保存基準と一致しません',[clip.id]);same(clip.content.rate,s.mediaRate,'独立音声速度',clip.id);same(s.source.sourceStart,addTime(s.evaluationSourceStart,divideTime(s.projection.offset,doc.speed!.fpsBasis)),'独立音声intent原点',clip.id);const delta=clip.startFrame-map.rootStart;compareSource(clip,s.source,addTime(s.evaluationSourceStart,divideTime(multiplyTime(rational(delta),s.mediaRate),doc.speed!.fpsBasis)));compareClocks(clip,s,s.mediaRate,delta);continue;}if(s.kind!=='main-audio')continue;
    const main=byId.get(s.providerId);if(!main)fail('原音の主映像所有者がありません',[clip.id,s.providerId]);
    binding(clip,main);const e=evaluation(clip,p.rate(main.id));compareSource(clip,s.source,e.sourceStart);
    if(s.evaluationSourceStart!==undefined){const m=main.speed;if(m.projectionExtent===undefined)fail('原音仮想時計の主投影全長がありません',[clip.id]);same(s.evaluationSourceStart,m.evaluationSourceStart??m.source.sourceStart,'原音trim元source原点',clip.id);}
    if(s.evaluationOwnerId){const root=allById.get(s.evaluationOwnerId)!;if(root.speed?.kind!=='main-audio'||root.speed.providerId!==(main.speed.evaluationOwnerId??main.id))fail('原音の元時計と主映像所有者が不一致です',[clip.id]);}
    same(s.source.sourceStart,main.speed.source.sourceStart,'原音の開始intent',clip.id);same(s.source.sourceEnd,main.speed.source.sourceEnd,'原音の終了intent',clip.id);
    compareClocks(clip,s,p.rate(main.id),e.delta);
  }
  linkedRoles(doc,mains);
  validateSpeedCaptions(doc);
}

/** The caller validates the existing v2 first. No existing field is rewritten. */
export function registerNativeSpeedMetadata(doc:SequenceDocument,command:RegisterNativeSpeedCommand):SequenceDocument {
  const input=object(command,['type','groupId','mainClipIds','mainAudioBindings']);
  if(input.type!=='register-native-speed'||!validId(input.groupId)||!Array.isArray(input.mainClipIds)||!input.mainClipIds.length||!Array.isArray(input.mainAudioBindings))fail('主映像と原音の登録対象を明示してください');
  list(input.mainClipIds);list(input.mainAudioBindings);
  if(doc.speed!==undefined||doc.clips.some(c=>c.speed!==undefined))fail('この文書は速度基準に登録済みです。元の基準を再採取できません');
  const byId=new Map(doc.clips.map(c=>[c.id,c])),ids=new Set<string>();
  const selected=Array.from(command.mainClipIds,id=>{
    if(!validId(id)||ids.has(id))fail('主映像のIDが不正または重複しています');ids.add(id);
    const clip=byId.get(id);if(!clip)throw new SequenceError('MISSING_TARGET','主映像が見つかりません',[id]);
    if(clip.content.kind!=='video')fail('主映像には映像クリップを明示してください',[id]);return clip;
  });
  const rates=selected.map(c=>{if(c.content.kind!=='video')fail('主映像の種類が不正です',[c.id]);return c.content.rate;});
  const uniform=rates.every(rate=>compareTime(rate,rates[0]!)===0),global=uniform?rational(rates[0]!.num,rates[0]!.den):rational(1);
  const next=structuredClone(doc),nextById=new Map(next.clips.map(c=>[c.id,c]));let phase=rational(0);
  next.speed={version:1,family:'native-exact-v1',groupId:command.groupId,originFrame:selected[0]!.startFrame,fpsBasis:structuredClone(doc.fps),globalRate:global,
    sequenceEndBasis:{kind:'main-offset',offsetFrames:doc.sequenceEndFrame-clipEnd(selected.at(-1)!)} };
  for(const [order,original] of selected.entries()){
    const previous=selected[order-1],rate=rates[order]!,span=owned(original.id,()=>multiplyTime(rational(original.durationFrames),rate));
    if(previous&&(original.startFrame<previous.startFrame||clipEnd(original)<clipEnd(previous)))fail('主映像の明示順序と現在の配置が一致しません',[previous.id,original.id]);
    const gap=previous?original.startFrame-clipEnd(previous):0;
    const speed:MainMetadata=owned(original.id,()=>({kind:'main',groupId:command.groupId,order,span,source:sourceBasis(original,doc),clock:clockBasis(original.clock,rate),
      ...(!uniform?{override:structuredClone(rate)}:{}),...(gap>0?{runHead:{phase:structuredClone(phase),gapFrames:gap}}:{}),
      ...(gap<0?{overlapBefore:multiplyTime(rational(-gap),rate)}:{}),
      ...(original.visual?.keyframeClock?{keyframeClock:clockBasis(original.visual.keyframeClock,rate)}:{})}));
    nextById.get(original.id)!.speed=speed;
    if(order<selected.length-1)phase=owned(original.id,()=>addTime(phase,span));
  }
  const audioIds=new Set<string>();
  for(const value of command.mainAudioBindings){
    const a=object(value,['audioClipId','providerId']);
    if(!validId(a.audioClipId)||!validId(a.providerId)||audioIds.has(a.audioClipId)||ids.has(a.audioClipId)||!ids.has(a.providerId))fail('原音の明示所有関係が不正です');
    audioIds.add(a.audioClipId);const audio=byId.get(a.audioClipId),provider=byId.get(a.providerId);
    if(!audio||!provider)throw new SequenceError('MISSING_TARGET','原音または主映像が見つかりません',[a.audioClipId,a.providerId]);
    binding(audio,provider);if(audio.content.kind!=='audio')fail('原音の種類が不正です',[audio.id]);
    const audioRate=audio.content.rate;
    nextById.get(audio.id)!.speed=owned(audio.id,()=>({kind:'main-audio',providerId:provider.id,source:sourceBasis(audio,doc),clock:clockBasis(audio.clock,audioRate),
      ...(audio.visual?.keyframeClock?{keyframeClock:clockBasis(audio.visual.keyframeClock,audioRate)}:{})}));
  }
  validateNativeSpeedMetadata(next);
  return next;
}
