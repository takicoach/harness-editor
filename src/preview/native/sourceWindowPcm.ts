import type {SequenceClip} from '../../core/sequence/model';
import {isRational,type Rational} from '../../core/sequence/time';

/** Explicit bounds supplied by the source-window preparation, never inferred from a clip. */
export interface PcmSourceWindow {start:Rational;end:Rational;sampleOrigin:Rational}
type Q={n:bigint;d:bigint};
const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a<0n?-a:a;
const q=(n:bigint,d=1n):Q=>{const g=gcd(n,d);return {n:n/g,d:d/g};};
const add=(a:Q,b:Q)=>q(a.n*b.d+b.n*a.d,a.d*b.d);
const sub=(a:Q,b:Q)=>q(a.n*b.d-b.n*a.d,a.d*b.d);
const mul=(a:Q,b:Q)=>q(a.n*b.n,a.d*b.d);
const div=(a:Q,b:Q)=>q(a.n*b.d,a.d*b.n);
const less=(a:Q,b:Q)=>a.n*b.d<b.n*a.d;
const floor=(a:Q)=>a.n>=0n?a.n/a.d:-((-a.n+a.d-1n)/a.d);
const ceil=(a:Q)=>-floor({n:-a.n,d:a.d});
const integer=(n:bigint)=>{const v=Number(n);if(!Number.isSafeInteger(v))throw new Error('音声窓の座標が保存範囲を超えています');return v;};
function exact(value:Rational):Q {
  if(!isRational(value)||Object.keys(value).some(k=>k!=='num'&&k!=='den'))throw new Error('音声窓の時刻が不正です');
  return q(BigInt(value.num),BigInt(value.den));
}

/** Exact output lattice and nominal PCM coordinates; no acoustic correspondence claim. */
export function sourceWindowCoordinates(clip:SequenceClip,fps:Rational,pcm:{sourceWindow:PcmSourceWindow;sampleRate:number;rate:Rational},from:number,to:number,outputSampleRate:number) {
  const c=clip.content,w=pcm.sourceWindow;
  if(c.kind!=='audio'||c.loop)throw new Error('区間限定PCMのループ再生には別の周期指定が必要です');
  if(!w||Object.keys(w).length!==3||Object.keys(w).some(k=>!['start','end','sampleOrigin'].includes(k)))throw new Error('音声窓の形式が不正です');
  if(!Number.isSafeInteger(pcm.sampleRate)||pcm.sampleRate<=0||!Number.isSafeInteger(outputSampleRate)||outputSampleRate<=0)throw new Error('音声窓のサンプルレートが不正です');
  const start=exact(w.start),end=exact(w.end),origin=exact(w.sampleOrigin),rate=exact(pcm.rate),zero=q(0n);
  if(less(start,zero)||!less(start,end)||less(origin,start)||!less(origin,end)||!less(zero,rate))throw new Error('音声窓の範囲が不正です');
  const sourceIn=exact(c.sourceIn),frameRate=exact(fps),pcmRate=q(BigInt(pcm.sampleRate)),outputRate=q(BigInt(outputSampleRate));
  if(!less(zero,frameRate))throw new Error('音声窓のfpsが不正です');
  const clipStart=div(q(BigInt(clip.startFrame)),frameRate);
  const outputAt=(source:Q)=>mul(add(clipStart,div(sub(source,sourceIn),rate)),outputRate);
  // Gate at the requested bounds. Before raw index zero, the left interpolation
  // tap is zero and the first allowed sample can still contribute on the right.
  const lower=integer(ceil(outputAt(start))),upper=integer(ceil(outputAt(end)));
  const offset=mul(sub(div(sub(sourceIn,origin),rate),clipStart),pcmRate),step=div(pcmRate,outputRate);
  const den=offset.d*step.d,base=offset.n*step.d,stride=step.n*offset.d;
  return {from:Math.max(from,lower),to:Math.min(to,upper),supportCount:integer(ceil(mul(div(sub(end,origin),rate),pcmRate))),
    position(sample:number){const numerator=base+BigInt(sample)*stride,index=floor({n:numerator,d:den}),remainder=numerator-index*den;return {index:integer(index),fraction:Number(remainder)/Number(den)};}};
}
