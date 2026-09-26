import type {EffectClock,SequenceClip} from '../../core/sequence/model';
import {compareTime,rational,rationalFromBigInts,rationalFromDecimal,type Rational} from '../../core/sequence/time';
import {speedInputValue} from './speedSettings';

export function parseMotionTiming(text:string,positive=false):Rational {
 try {
  const raw=text.trim(),fraction=/^([+-]?\d+)\s*\/\s*(\d+)$/.exec(raw);
  if(!raw)throw new Error('empty');
  const value=fraction?rational(Number(fraction[1]),Number(fraction[2])):rationalFromDecimal(raw);
  if(positive&&value.num<=0)throw new Error('positive');
  return value;
 }catch{throw new Error(positive?'速さは0より大きい小数または分数で入力してください。桁数が多い場合は減らしてください。':'位置は小数または分数で入力してください。桁数が多い場合は減らしてください。');}
}
export const motionTimingValue=(value:Rational)=>value.num<0?`-${speedInputValue(rational(-value.num,value.den))}`:speedInputValue(value);
const parts=(value:Rational)=>[BigInt(value.num),BigInt(value.den)] as const;
export function firstMotionKey(clip:SequenceClip):Rational {
 const keys=clip.visual?.keyframes;if(!clip.insertOwnSpeed||!keys?.length)throw new Error('位置キーがある挿入動画を選んでください。');
 return keys.reduce((first,key)=>compareTime(key.frame,first)<0?key.frame:first,keys[0]!.frame);
}
export function firstMotionKeySeconds(clip:SequenceClip,fps:Rational):Rational {
 const clock=clip.visual?.keyframeClock??clip.clock;
 const [f,fd]=parts(firstMotionKey(clip)),[o,od]=parts(clock.offset),[a,ad]=parts(clock.rate),[p,pd]=parts(fps);
 return rationalFromBigInts((f*od-o*fd)*ad*pd,fd*od*a*p);
}
/** Change pace around the first key, keeping its current timeline position. */
export function motionRateClock(clip:SequenceClip,rate:Rational,expectedFirst?:Rational):EffectClock {
 const first=firstMotionKey(clip),clock=clip.visual?.keyframeClock??clip.clock;
 if(expectedFirst&&compareTime(first,expectedFirst)!==0)throw new Error('最初の点が変わりました。位置キーを確認して、もう一度入力してください。');
 if(compareTime(rate,clock.rate)===0)return clock;
 const [f,fd]=parts(first),[o,od]=parts(clock.offset),[a,ad]=parts(clock.rate),[b,bd]=parts(rate);
 return {...clock,rate,offset:rationalFromBigInts(f*od*a*bd-(f*od-o*fd)*ad*b,fd*od*a*bd)};
}
export function motionStartClock(clip:SequenceClip,fps:Rational,seconds:Rational,expectedFirst:Rational):EffectClock {
 const first=firstMotionKey(clip);if(compareTime(first,expectedFirst)!==0)throw new Error('最初の点が変わりました。位置キーを確認して、もう一度入力してください。');
 const clock=clip.visual?.keyframeClock??clip.clock;
 const [f,fd]=parts(first),[s,sd]=parts(seconds),[p,pd]=parts(fps),[a,ad]=parts(clock.rate);
 return {...clock,offset:rationalFromBigInts(f*sd*pd*ad-s*p*a*fd,fd*sd*pd*ad)};
}
