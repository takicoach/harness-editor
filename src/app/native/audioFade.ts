import {timeNumber,type Rational} from '../../core/sequence/time';

/** フェード長の表示は秒。内部はフレームのまま（モデルは変えない）。 */
export function fadeSeconds(frames:number,fps:Rational):number {
  const rate=timeNumber(fps);
  if(!Number.isFinite(frames)||!rate)return 0;
  return Math.round((frames/rate)*100)/100;
}
export function fadeFrames(seconds:number,fps:Rational):number {
  const rate=timeNumber(fps);
  if(!Number.isFinite(seconds)||seconds<=0||!rate)return 0;
  return Math.floor(seconds*rate);
}
