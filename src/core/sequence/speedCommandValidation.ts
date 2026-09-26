import {SequenceError} from './errors';
import {isRational,compareTime,rational,type Rational} from './time';
export const NATIVE_SPEED_COMMAND_TYPES=['register-native-speed','upgrade-native-speed','upgrade-native-speed-operations','set-native-global-speed','set-native-main-speed','reset-native-main-speed','register-native-insert-own-speed','set-native-insert-own-speed','rebase-native-insert-own-source','rebase-native-insert-own-keyframe-clock'] as const;
export function isNativeSpeedCommandType(type:unknown):boolean{return typeof type==='string'&&(NATIVE_SPEED_COMMAND_TYPES as readonly string[]).includes(type);}
function fail(message:string):never{throw new SequenceError('INVALID_DOCUMENT',message);}
function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))return fail('速度操作の形式が不正です');
 const v=value as Record<string,unknown>;if(keys.some(k=>!Object.hasOwn(v,k)||v[k]===undefined)||Object.keys(v).some(k=>!keys.includes(k)))return fail('速度操作に不足または未対応の項目があります');return v;
}
function id(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))return fail('速度操作のIDが不正です');return value;}
function list(value:unknown):unknown[]{if(!Array.isArray(value)||Object.keys(value).length!==value.length||Object.keys(value).some((k,i)=>k!==String(i)))return fail('速度操作の一覧が不正です');return value;}
export function nativeSpeedRate(value:unknown):Rational{
 object(value,['num','den']);if(!isRational(value)||compareTime(value,rational(1,10))<0||compareTime(value,rational(16))>0)throw new SequenceError('INVALID_RANGE','速度は0.1〜16の正確な有理数で指定してください');return rational(value.num,value.den);
}
/** Shared core/HTTP shape contract. Target existence, roles and saved-basis
 * relationships remain the document command's responsibility. No inference. */
export function validateNativeSpeedCommand(value:unknown):void {
 if(!value||typeof value!=='object'||!isNativeSpeedCommandType((value as Record<string,unknown>).type))return fail('未対応の速度操作です');
 const type=(value as Record<string,unknown>).type;
 if(type==='rebase-native-insert-own-keyframe-clock'){
  const c=object(value,['type','clipId','clock']);id(c.clipId);
  if(c.clock!==null){
   const clock=object(c.clock,['offset','rate','duration']);
   for(const key of ['offset','rate','duration']){
    object(clock[key],['num','den']);
    if(!isRational(clock[key])||(key!=='offset'&&(clock[key] as Rational).num<=0))fail('動きの時計設定が不正です');
   }
  }
  return;
 }
 if(type==='register-native-insert-own-speed'||type==='set-native-insert-own-speed'||type==='rebase-native-insert-own-source'){
  const c=object(value,['type','clipId','linked',...(type==='set-native-insert-own-speed'?['rate']:type==='rebase-native-insert-own-source'?['sourceIn']:[])]);
  id(c.clipId);if(typeof c.linked!=='boolean')fail('挿入速度のリンク指定が不正です');
  if(type==='set-native-insert-own-speed')nativeSpeedRate(c.rate);
  if(type==='rebase-native-insert-own-source'){object(c.sourceIn,['num','den']);if(!isRational(c.sourceIn)||c.sourceIn.num<0)fail('挿入素材の開始時刻が不正です');}
  return;
 }
 if(type==='register-native-speed'){
  const c=object(value,['type','groupId','mainClipIds','mainAudioBindings']);id(c.groupId);const mains=list(c.mainClipIds).map(id),bindings=list(c.mainAudioBindings);if(!mains.length||new Set(mains).size!==mains.length)return fail('主映像のIDが空または重複しています');
  const audio=new Set<string>();for(const binding of bindings){const b=object(binding,['audioClipId','providerId']),a=id(b.audioClipId),p=id(b.providerId);if(audio.has(a)||mains.includes(a)||!mains.includes(p))return fail('原音の明示所有関係が不正です');audio.add(a);}return;
 }
 if(type==='upgrade-native-speed'||type==='upgrade-native-speed-operations'){object(value,['type']);return;}
 const c=object(value,type==='set-native-global-speed'?['type','rate']:type==='set-native-main-speed'?['type','clipId','rate']:['type','clipId']);
 if(type!=='set-native-global-speed')id(c.clipId);if(type!=='reset-native-main-speed')nativeSpeedRate(c.rate);
}
