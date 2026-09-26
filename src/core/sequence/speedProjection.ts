import {SequenceError} from './errors';
import {buildSpeedTimeMap, roundSpeedTime, type SpeedMapEntry, type SpeedMapPart, type SpeedTimeMap} from './speedTimeMap';
import {compareTime, isRational, multiplyTime, rational, type Rational} from './time';

/** Clip-owned native basis. Order is the supplied editing order, not an ID sort. */
export interface NativeSpeedBasisClip {
  readonly ownerId:string;
  readonly span:Rational;
  readonly override?:Rational;
  /** An explicit boundary remains a separate rounding run even when gapFrames is zero. */
  readonly runHead?:{readonly phase:Rational;readonly gapFrames:number};
  readonly overlapBefore?:Rational;
}
export interface NativeSpeedBasis {
  readonly family:'native-exact-v1';
  readonly globalRate:Rational;
  readonly clips:readonly NativeSpeedBasisClip[];
  readonly originFrame?:number;
  /** Signed difference from main end. A shorter sequence does not trim its retained clips. */
  readonly tailOffsetFrames:number;
}
export type SpeedProjectionPart=SpeedMapPart|'after-main';
export interface SpeedProjectionPoint {readonly ownerId:string;readonly kind:SpeedProjectionPart;readonly offset:Rational}
export interface NativeSpeedProjection {
  readonly family:'native-exact-v1';readonly mode:'absolute'|'cumulative';
  readonly entries:readonly SpeedMapEntry[];
  readonly originFrame:number;readonly mainEndFrame:number;readonly sequenceEndFrame:number;
  point(point:SpeedProjectionPoint):number;
  inverse(ownerId:string,frame:number,kind?:SpeedProjectionPart):Rational;
  rate(ownerId:string):Rational;
}

const invalid=(message:string,targets:string[]=[]):never=>{throw new SequenceError('INVALID_RANGE',message,targets);};
function frames(value:number,label:string,signed=false):number {
  if(!Number.isSafeInteger(value)||(!signed&&value<0))invalid(`${label}には${signed?'':'0以上の'}安全な整数が必要です`);
  return value;
}
function rate(value:Rational,id?:string):Rational {
  if(!isRational(value)||compareTime(value,{num:1,den:10})<0||compareTime(value,{num:16,den:1})>0)
    invalid('速度は0.1倍から16倍の正確な値で指定してください',id?[id]:[]);
  return Object.freeze(rational(value.num,value.den));
}
function sumFrames(a:number,b:number):number {
  const result=a+b;
  if(!Number.isSafeInteger(result))throw new SequenceError('TIME_OVERFLOW','速度変更後の配置を安全な整数で保存できません');
  return result;
}

/** Native family only. Legacy binary64/collapse evaluation has a different contract. */
export function buildNativeSpeedProjection(basis:NativeSpeedBasis):NativeSpeedProjection {
  if(!basis||basis.family!=='native-exact-v1')invalid('この速度計算にはnativeの編集基準が必要です');
  const global=rate(basis.globalRate),origin=frames(basis.originFrame===undefined?0:basis.originFrame,'開始時刻'),tail=frames(basis.tailOffsetFrames,'主映像末尾からの差',true);
  if(!Array.isArray(basis.clips)||!basis.clips.length)invalid('速度を変更する主映像がありません');
  const ids=new Set<string>(),rates=new Map<string,Rational>();
  for(const clip of basis.clips){
    if(!clip||typeof clip.ownerId!=='string'||!clip.ownerId.trim()||ids.has(clip.ownerId))invalid('主映像の所有IDが空または重複しています');
    ids.add(clip.ownerId);rates.set(clip.ownerId,clip.override===undefined?global:rate(clip.override,clip.ownerId));
    if(clip.runHead!==undefined){
      if(!clip.runHead||typeof clip.runHead!=='object')invalid('丸め区間の先頭情報が不正です',[clip.ownerId]);
      frames(clip.runHead.gapFrames,'空白の長さ');
      if(!isRational(clip.runHead.phase))invalid('丸めの基準位置が不正です',[clip.ownerId]);
    }
  }
  // One branch for the whole document, including separated runs.
  const mode=[...rates.values()].some(value=>compareTime(value,global)!==0)?'cumulative':'absolute';
  const maps=new Map<string,SpeedTimeMap>(),entries:SpeedMapEntry[]=[];
  let cursor=origin;
  for(let first=0;first<basis.clips.length;){
    let end=first+1;
    while(end<basis.clips.length&&!basis.clips[end]!.runHead)end++;
    const run=basis.clips.slice(first,end),head=run[0]!.runHead;
    const map=buildSpeedTimeMap(run.map((clip,index)=>({
      ownerId:clip.ownerId,span:clip.span,rate:rates.get(clip.ownerId)!,mode,
      gapBefore:index===0?(head?.gapFrames??0):0,
      ...(index===0&&mode==='absolute'&&head?{runBasisOffset:head.phase}:{}),
      ...(clip.overlapBefore===undefined?{}:{overlapBefore:clip.overlapBefore}),
    })),{originFrame:cursor});
    for(const entry of map.entries){entries.push(entry);maps.set(entry.ownerId,map);}
    cursor=map.endFrame;first=end;
  }
  const mainEnd=cursor,sequenceEnd=frames(sumFrames(mainEnd,tail),'完成尺'),lastId=entries.at(-1)!.ownerId;
  const mapFor=(id:string):SpeedTimeMap=>{
    const map=maps.get(id);
    if(!map)throw new SequenceError('MISSING_TARGET','速度区間の所有IDが見つかりません',[id]);
    return map;
  };
  const tailOwner=(id:string)=>{mapFor(id);if(id!==lastId||tail<=0)invalid('この所有区間には末尾の領域がありません',[id]);};
  return Object.freeze({family:'native-exact-v1' as const,mode,entries:Object.freeze(entries),originFrame:origin,mainEndFrame:mainEnd,sequenceEndFrame:sequenceEnd,
    point(point:SpeedProjectionPoint):number {
      if(!point)invalid('所有区間と時刻を指定してください');
      if(point.kind!=='after-main')return mapFor(point.ownerId).point({...point,kind:point.kind});
      tailOwner(point.ownerId);
      if(!isRational(point.offset)||compareTime(point.offset,{num:0,den:1})<0||compareTime(point.offset,rational(tail))>0)
        invalid('時刻が末尾の領域外にあります',[point.ownerId]);
      return sumFrames(mainEnd,roundSpeedTime(point.offset));
    },
    inverse(ownerId:string,frame:number,kind:SpeedProjectionPart='clip'):Rational {
      if(kind!=='after-main')return mapFor(ownerId).inverse(ownerId,frame,kind);
      tailOwner(ownerId);frames(frame,'編集時刻');
      if(frame<mainEnd||frame>sequenceEnd)invalid('編集時刻が末尾の領域外にあります',[ownerId]);
      return rational(frame-mainEnd);
    },
    rate(ownerId:string):Rational {mapFor(ownerId);return rates.get(ownerId)!;},
  });
}

export interface InsertOwnSpeedBasis {readonly startFrame:number;readonly exposure:Rational}
/** Adopt only at registration or an explicit trim; changing speed must reuse this basis. */
export function registerInsertOwnSpeed(startFrame:number,endFrame:number,ownRate:Rational):InsertOwnSpeedBasis {
  frames(startFrame,'挿入開始');frames(endFrame,'挿入終了');
  if(endFrame<=startFrame)invalid('挿入区間には正の長さが必要です');
  const exposure=multiplyTime(rational(endFrame-startFrame),rate(ownRate));
  return Object.freeze({startFrame,exposure:Object.freeze(exposure)});
}
export function projectInsertOwnSpeed(basis:InsertOwnSpeedBasis,ownRate:Rational):Readonly<{startFrame:number;endFrame:number;rate:Rational}> {
  if(!basis)invalid('挿入速度の編集基準がありません');
  frames(basis.startFrame,'挿入開始');
  if(!isRational(basis.exposure)||basis.exposure.num<=0)invalid('挿入速度の基準長が不正です');
  const own=rate(ownRate);
  // Only the final integer is saved. A legal decimal rate can have an exact
  // intermediate quotient whose numerator exceeds stored Rational limits.
  const numerator=BigInt(basis.exposure.num)*BigInt(own.den),denominator=BigInt(basis.exposure.den)*BigInt(own.num);
  const rounded=(2n*numerator+denominator)/(2n*denominator); // positive half-up
  if(rounded>BigInt(Number.MAX_SAFE_INTEGER))throw new SequenceError('TIME_OVERFLOW','速度変更後の挿入尺を安全な整数で保存できません');
  const duration=Math.max(1,Number(rounded));
  return Object.freeze({startFrame:basis.startFrame,endFrame:sumFrames(basis.startFrame,duration),rate:own});
}
