import {SequenceError} from './errors';
import {clipEnd,isMediaContent,sourceTimeAt,type SequenceClip,type SequenceDocument,type InsertOwnSpeedMetadata,type EffectClock,type SpeedClockBasis} from './model';
import {compareTime,multiplyTime,divideTime,addTime,subtractTime,isRational,type Rational} from './time';
import {nativeSpeedRate} from './speedCommandValidation';
import {registerInsertOwnSpeed,projectInsertOwnSpeed} from './speedProjection';
import {speedProjectionForDocument,refreshCaptionBaselines} from './speedCaptionLedger';
import type {SequenceCommand} from './commands';

export type InsertOwnCommand =
 | {type:'rebase-native-insert-own-keyframe-clock';clipId:string;clock:EffectClock|null}
 | {type:'register-native-insert-own-speed';clipId:string;linked:boolean}
 | {type:'set-native-insert-own-speed';clipId:string;rate:Rational;linked:boolean}
 | {type:'rebase-native-insert-own-source';clipId:string;sourceIn:Rational;linked:boolean};
const same=(a:Rational,b:Rational)=>compareTime(a,b)===0;
const fail=(text:string,ids:string[]=[]):never=>{throw new SequenceError('INVALID_DOCUMENT',text,ids);};
function shape(value:unknown,required:string[],optional:string[]=[],ids:string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('挿入速度の保存形式が不正です',ids);
 const o=value as Record<string,unknown>;
 if(required.some(k=>o[k]===undefined)||Object.keys(o).some(k=>![...required,...optional].includes(k)))return fail('挿入速度に不足または未対応の項目があります',ids);
 return o;
}
function time(value:unknown,positive=false):asserts value is Rational {
 shape(value,['num','den']);if(!isRational(value)||(positive&&value.num<=0))fail('挿入速度の時刻が不正です');
}
const clockBasis=(c:EffectClock,rate:Rational):SpeedClockBasis=>({offset:structuredClone(c.offset),slope:divideTime(c.rate,rate),duration:structuredClone(c.duration)});
const clock=(b:SpeedClockBasis,rate:Rational):EffectClock=>({offset:structuredClone(b.offset),rate:multiplyTime(b.slope,rate),duration:structuredClone(b.duration)});
function checkClock(actual:EffectClock,b:SpeedClockBasis,id:string):void {
 shape(b,['offset','slope','duration'],[],[id]);time(b.offset);time(b.slope,true);time(b.duration,true);
 if(!same(actual.offset,b.offset)||!same(actual.duration,b.duration))fail('挿入速度の時計基準が現在の時計と一致しません',[id]);
}
function capture(doc:SequenceDocument,c:SequenceClip):InsertOwnSpeedMetadata {
 if(!isMediaContent(c.content))return fail('挿入動画または音声を明示してください',[c.id]);
 return {version:1,placement:registerInsertOwnSpeed(c.startFrame,clipEnd(c),c.content.rate),rate:structuredClone(c.content.rate),
  source:{assetId:c.content.assetId,streamIndex:c.content.streamIndex,sourceStart:structuredClone(c.content.sourceIn),sourceEnd:sourceTimeAt(c,clipEnd(c),doc.fps)},
  clock:clockBasis(c.clock,c.content.rate),...(c.visual?.keyframeClock?{keyframeClock:clockBasis(c.visual.keyframeClock,c.content.rate)}:{})};
}
/** Caller makes the fixed role explicit. No asset-name, primary-asset or track inference. */
function singleRegistrationIssue(doc:SequenceDocument,c:SequenceClip):string|null {
 if(!isMediaContent(c.content))return '動画または音声を選んでください。';
 if(c.speed)return '主映像・原音・独立音声の既存速度基準は、挿入速度へ自動変換できません。';
 if(doc.legacy)return '旧案件の挿入方式は、この登録では変換できません。';
 if(c.anchor?.kind==='source')return '全体に追従する素材は固定挿入へ自動変換できません。';
 if(c.content.kind==='audio'&&c.content.loop)return 'ループ音声の個別速度は未接続です。';
 if(doc.clips.some(x=>x.anchor?.kind==='source'&&x.anchor.clipOccurrenceId===c.id))return '素材に連動する字幕がある挿入は、字幕の速度基準接続後に変更できます。';
 if(doc.transitions.some(t=>t.outClipId===c.id||t.inClipId===c.id))return '転換・単独フェードを含む挿入速度は未接続です。';
 if(clipEnd(c)>doc.sequenceEndFrame)return '完成尺の外まで続く挿入は、先に表示範囲を確認してください。';
 return null;
}
/** Inspector always edits linked media; report the same complete target set before dispatch. */
export function insertOwnRegistrationIssue(doc:SequenceDocument,c:SequenceClip):string|null {
 try {
  for(const peer of targets(doc,c.id,true)){
   const issue=singleRegistrationIssue(doc,peer);if(issue)return `${peer.name} (${peer.id}): ${issue}`;
  }
  return null;
 }catch(error){return error instanceof Error?error.message:'挿入の編集リンクを確認してください。';}
}
function targets(doc:SequenceDocument,id:string,linked:boolean):SequenceClip[]{
 const c=doc.clips.find(x=>x.id===id);if(!c)throw new SequenceError('MISSING_TARGET','挿入素材が見つかりません',[id]);
 const group=c.linkGroupId?doc.clips.filter(x=>x.linkGroupId===c.linkGroupId):[c];
 // A one-sided command still must not dissolve an unrelated main-provider group.
 if(group.some(x=>x.speed))fail('主映像や原音の編集リンクは挿入速度から変更できません',group.map(x=>x.id));
 if(!linked)return [c];
 if(group.length>2||group.filter(x=>x.content.kind==='video').length>1||group.filter(x=>x.content.kind==='audio').length>1)fail('挿入の編集リンクは映像と原音の組を明示してください',group.map(x=>x.id));
 for(const other of group){
  const a=c.content,b=other.content;
  if(!isMediaContent(a)||!isMediaContent(b)||a.assetId!==b.assetId||c.startFrame!==other.startFrame||c.durationFrames!==other.durationFrames||!same(a.sourceIn,b.sourceIn)||!same(a.rate,b.rate))fail('挿入の編集リンクで素材・配置・開始・倍率が一致しません',group.map(x=>x.id));
 }
 return group;
}
function updateMainEnd(doc:SequenceDocument):void {
 if(!doc.speed)return;
 if(doc.speed.sequenceEndBasis.kind==='empty-fixed')doc.speed.sequenceEndBasis.endFrame=doc.sequenceEndFrame;
 else doc.speed.sequenceEndBasis.offsetFrames=doc.sequenceEndFrame-speedProjectionForDocument(doc).mainEndFrame;
 if(doc.speed.version===2)refreshCaptionBaselines(doc);
}
export function applyInsertOwnCommand(before:SequenceDocument,command:InsertOwnCommand):SequenceDocument {
 if(command.type==='rebase-native-insert-own-keyframe-clock'){
  const original=before.clips.find(c=>c.id===command.clipId);
  if(!original)throw new SequenceError('MISSING_TARGET','挿入素材が見つかりません',[command.clipId]);
  if(!original.insertOwnSpeed||!original.visual)return fail('動きの設定がある登録済みの挿入素材を選んでください',[original.id]);
  const previous=original.visual.keyframeClock,value=command.clock;
  if((value===null&&!previous)||(value&&previous&&same(value.offset,previous.offset)&&same(value.rate,previous.rate)&&same(value.duration,previous.duration)))return before;
  const next=structuredClone(before),edited=next.clips.find(c=>c.id===original.id)!;
  // A presentation edit does not split an AV link or recapture rounded source exposure.
  if(value===null){delete edited.visual!.keyframeClock;delete edited.insertOwnSpeed!.keyframeClock;}
  else {edited.visual!.keyframeClock=structuredClone(value);edited.insertOwnSpeed!.keyframeClock=clockBasis(value,edited.insertOwnSpeed!.rate);}
  return next;
 }
 const chosen=targets(before,command.clipId,command.linked),ids=new Set(chosen.map(c=>c.id));
 for(const c of chosen){
  const issue=singleRegistrationIssue(before,c);if(issue)fail(issue,[c.id]);
  if(command.type==='register-native-insert-own-speed'&&c.insertOwnSpeed)fail('挿入速度は既に登録されています',[c.id]);
  if(command.type!=='register-native-insert-own-speed'&&!c.insertOwnSpeed)fail('先に固定挿入の速度を明示登録してください',[c.id]);
 }
 if(command.type==='set-native-insert-own-speed'&&chosen.every(c=>same(c.insertOwnSpeed!.rate,command.rate)))return before;
 if(command.type==='rebase-native-insert-own-source'&&chosen.every(c=>isMediaContent(c.content)&&same(c.content.sourceIn,command.sourceIn)))return before;
 const next=structuredClone(before);
 next.insertOwnSpeed??={version:1,fpsBasis:structuredClone(before.fps),endFloor:before.sequenceEndFrame};
 if(!command.linked){const link=chosen[0]!.linkGroupId;if(link)for(const c of next.clips)if(c.linkGroupId===link)delete c.linkGroupId;}
 for(const c of next.clips){if(!ids.has(c.id))continue;
  if(command.type==='register-native-insert-own-speed'){c.insertOwnSpeed=capture(next,c);continue;}
  if(!isMediaContent(c.content))return fail('挿入素材の種類が不正です',[c.id]);
  if(command.type==='rebase-native-insert-own-source'){
   c.content.sourceIn=structuredClone(command.sourceIn);c.insertOwnSpeed=capture(next,c);continue;
  }
  const b=c.insertOwnSpeed!,rate=nativeSpeedRate(command.rate),p=projectInsertOwnSpeed(b.placement,rate);
  b.rate=rate;c.startFrame=p.startFrame;c.durationFrames=p.endFrame-p.startFrame;
  c.content.rate=rate;c.content.sourceIn=structuredClone(b.source.sourceStart);c.clock=clock(b.clock,rate);
  if(c.visual&&b.keyframeClock)c.visual.keyframeClock=clock(b.keyframeClock,rate);
 }
 if(command.type!=='register-native-insert-own-speed'){
  next.sequenceEndFrame=Math.max(next.insertOwnSpeed.endFloor,...next.clips.filter(c=>c.insertOwnSpeed).map(clipEnd));updateMainEnd(next);
 }
 return next;
}
/** Ordinary trim/split explicitly creates new interval bases; pure movement only moves its anchor. */
export function rebindInsertOwnFragment(doc:SequenceDocument,original:SequenceClip,c:SequenceClip,from:number,to:number):void {
 if(!original.insertOwnSpeed)return;
 if(from===original.startFrame&&to===clipEnd(original))c.insertOwnSpeed!.placement={...c.insertOwnSpeed!.placement,startFrame:c.startFrame};
 else {
  c.insertOwnSpeed=capture(doc,c);
  if(to<=clipEnd(original)){
   const old=original.insertOwnSpeed;
   const limit=from<original.startFrame
    ?{sourceStart:c.insertOwnSpeed.source.sourceStart,exposure:multiplyTime(subtractTime(old.source.sourceEnd,c.insertOwnSpeed.source.sourceStart),doc.fps)}
    :old.sourceLimit??{sourceStart:old.source.sourceStart,exposure:multiplyTime(subtractTime(old.source.sourceEnd,old.source.sourceStart),doc.fps)};
   c.insertOwnSpeed.sourceLimit=structuredClone(limit);
   const end=addTime(limit.sourceStart,divideTime(limit.exposure,doc.fps));
   if(compareTime(c.insertOwnSpeed.source.sourceEnd,end)>0)c.insertOwnSpeed.source.sourceEnd=end;
   if(compareTime(c.insertOwnSpeed.source.sourceStart,c.insertOwnSpeed.source.sourceEnd)>=0)fail('素材範囲を持たない丸め末尾の分割は、挿入の区間再結合が未対応です',[original.id]);
  }
 }
}
/** Reconcile only the completion floor owned by ordinary editing, not media/source history. */
export function rebindInsertOwnCompletion(before:SequenceDocument,next:SequenceDocument,command:SequenceCommand):SequenceDocument {
 const type=command.type;
 if(!before.insertOwnSpeed||before===next||type==='batch'||type.includes('insert-own'))return next;
 const owned=next.clips.filter(c=>c.insertOwnSpeed);
 const b=next.insertOwnSpeed!;
 if(['set-native-global-speed','set-native-main-speed','reset-native-main-speed'].includes(type)){
  b.endFloor=Number(BigInt(before.insertOwnSpeed.endFloor)+BigInt(speedProjectionForDocument(next).mainEndFrame)-BigInt(speedProjectionForDocument(before).mainEndFrame));
  if(!Number.isSafeInteger(b.endFloor))fail('速度変更後の挿入完成尺基準が不正です');
  next.sequenceEndFrame=Math.max(b.endFloor,...owned.map(clipEnd));updateMainEnd(next);return next;
 }
 b.endFloor=before.insertOwnSpeed.endFloor;
 if(command.type==='ripple-delete'){
  b.endFloor-=Math.max(0,Math.min(b.endFloor,command.endFrame)-command.startFrame);
 }
 if(command.type==='reorder-ranges'){
  const original=b.endFloor;
  let destination=0n,mapped=0n;
  for(const part of command.ranges){
   const retained=Math.min(original,part.endFrame)-part.startFrame;
   if(retained>0){const end=destination+BigInt(retained);if(end>mapped)mapped=end;}
   destination+=BigInt(part.endFrame)-BigInt(part.startFrame);
  }
  // The ordinary prefix can move behind an own-only tail: retain its destination,
  // not merely the sum of retained prefix lengths. A signed pre-zero offset stays signed.
  b.endFloor=original<0?original:Number(mapped);
 }
 // Ordinary edits may create/move other content into the temporary tail.
 // Protect that actual content, but never re-adopt an unchanged own extension.
 const old=new Map(before.clips.map(c=>[c.id,c]));
 // A split changes neither media coverage nor ordinary completion. Its new
 // fragment IDs (and shortened first fragment) are not newly added content.
 if(command.type!=='ripple-delete'&&command.type!=='reorder-ranges'&&command.type!=='split'){
  for(const c of next.clips)if(!c.insertOwnSpeed&&(!old.has(c.id)||clipEnd(c)!==clipEnd(old.get(c.id)!)))b.endFloor=Math.max(b.endFloor,Math.min(next.sequenceEndFrame,clipEnd(c)));
 }
 if(!Number.isSafeInteger(b.endFloor))fail('編集後の挿入完成尺基準が不正です');
 const end=Math.max(b.endFloor,...owned.map(clipEnd));
 if(end<0)fail('挿入の削除後に完成尺が負になります。先に主映像の速度または完成尺を調整してください',before.clips.filter(c=>c.insertOwnSpeed).map(c=>c.id));
 if(!owned.length)delete next.insertOwnSpeed;
 if(next.sequenceEndFrame!==end){next.sequenceEndFrame=end;updateMainEnd(next);}
 return next;
}
export function validateInsertOwnSpeed(doc:SequenceDocument):void {
 const owned=doc.clips.filter(c=>c.insertOwnSpeed!==undefined);
 if(!owned.length){if(doc.insertOwnSpeed!==undefined)fail('所有素材のない挿入速度基準です');return;}
 const d=shape(doc.insertOwnSpeed,['version','fpsBasis','endFloor']);time(d.fpsBasis,true);
 if(d.version!==1||!same(d.fpsBasis as Rational,doc.fps)||!Number.isSafeInteger(d.endFloor))fail('挿入速度の文書基準が不正です');
 if(doc.sequenceEndFrame!==Math.max(d.endFloor as number,...owned.map(clipEnd)))fail('挿入速度の完成尺と保存基準が一致しません');
 for(const c of owned){
  const b=c.insertOwnSpeed!;shape(b,['version','placement','rate','source','clock'],['keyframeClock','sourceLimit'],[c.id]);
  if(!isMediaContent(c.content))return fail('固定挿入の素材種類が不正です',[c.id]);
  if(b.version!==1||c.speed||c.anchor?.kind==='source'||(c.content.kind==='audio'&&c.content.loop))fail('固定挿入の速度役割が不正です',[c.id]);
  if(doc.legacy||doc.clips.some(x=>x.anchor?.kind==='source'&&x.anchor.clipOccurrenceId===c.id)||doc.transitions.some(t=>t.outClipId===c.id||t.inClipId===c.id))fail('旧方式・素材連動字幕・転換の挿入速度は未接続です',[c.id]);
  nativeSpeedRate(b.rate);shape(b.placement,['startFrame','exposure'],[],[c.id]);time(b.placement.exposure,true);
  const p=projectInsertOwnSpeed(b.placement,b.rate);
  if(c.startFrame!==p.startFrame||clipEnd(c)!==p.endFrame||!same(c.content.rate,b.rate))fail('挿入速度の配置・倍率が基準と一致しません',[c.id]);
  shape(b.source,['assetId','streamIndex','sourceStart','sourceEnd'],[],[c.id]);time(b.source.sourceStart);time(b.source.sourceEnd,true);
  let end=addTime(b.source.sourceStart,divideTime(b.placement.exposure,doc.fps));
  if(b.sourceLimit!==undefined){shape(b.sourceLimit,['sourceStart','exposure'],[],[c.id]);time(b.sourceLimit.sourceStart);time(b.sourceLimit.exposure,true);
   if(b.sourceLimit.sourceStart.num<0||compareTime(b.sourceLimit.sourceStart,b.source.sourceStart)>0)fail('挿入素材の元区間が不正です',[c.id]);
   const limit=addTime(b.sourceLimit.sourceStart,divideTime(b.sourceLimit.exposure,doc.fps));if(compareTime(end,limit)>0)end=limit;
  }
  if(b.source.sourceStart.num<0||compareTime(b.source.sourceStart,b.source.sourceEnd)>=0||c.content.assetId!==b.source.assetId||c.content.streamIndex!==b.source.streamIndex||!same(c.content.sourceIn,b.source.sourceStart)||!same(b.source.sourceEnd,end))fail('挿入速度の素材基準が不正です',[c.id]);
  checkClock(c.clock,b.clock,c.id);if(!same(c.clock.rate,multiplyTime(b.clock.slope,b.rate)))fail('挿入の時計速度が一致しません',[c.id]);
  if(b.keyframeClock!==undefined)shape(b.keyframeClock,['offset','slope','duration'],[],[c.id]);
  if((c.visual?.keyframeClock!==undefined)!==(b.keyframeClock!==undefined))fail('挿入の独立キー時計が一致しません',[c.id]);
  if(c.visual?.keyframeClock&&b.keyframeClock){checkClock(c.visual.keyframeClock,b.keyframeClock,c.id);if(!same(c.visual.keyframeClock.rate,multiplyTime(b.keyframeClock.slope,b.rate)))fail('挿入のキー時計速度が一致しません',[c.id]);}
  const group=targets(doc,c.id,true);for(const peer of group)if(!peer.insertOwnSpeed||!same(peer.insertOwnSpeed.placement.exposure,b.placement.exposure)||!same(peer.insertOwnSpeed.source.sourceStart,b.source.sourceStart)||!same(peer.insertOwnSpeed.source.sourceEnd,b.source.sourceEnd))fail('挿入の編集リンクの保存基準が一致しません',group.map(x=>x.id));
 }
}
export function guardInsertOwnProperty(before:SequenceClip,next:SequenceClip):void {
 if(!before.insertOwnSpeed)return;
 const a=before.content,b=next.content;
 if(!isMediaContent(a)||!isMediaContent(b)||a.kind!==b.kind||a.assetId!==b.assetId||a.streamIndex!==b.streamIndex||!same(a.sourceIn,b.sourceIn)||!same(a.rate,b.rate)||(a.kind==='audio'&&b.kind==='audio'&&a.loop!==b.loop))fail('登録した挿入の素材・開始・倍率は専用コマンドで変更してください',[before.id]);
 const x=before.visual?.keyframeClock,y=next.visual?.keyframeClock;
 if(Boolean(x)!==Boolean(y)||(x&&y&&(!same(x.offset,y.offset)||!same(x.rate,y.rate)||!same(x.duration,y.duration))))fail('挿入の独立キー時計は専用の再基準化が必要です',[before.id]);
}
/** Called only after the ordinary operation has established that it changes a range. */
export function detachInsertOwnLinks(doc:SequenceDocument,selected:ReadonlySet<string>):SequenceDocument {
 const groups=new Set(doc.clips.filter(c=>selected.has(c.id)&&c.insertOwnSpeed&&c.linkGroupId).map(c=>c.linkGroupId!));
 if(!groups.size)return doc;
 const next=structuredClone(doc);for(const c of next.clips)if(c.linkGroupId&&groups.has(c.linkGroupId))delete c.linkGroupId;return next;
}
