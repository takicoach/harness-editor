export interface SilenceSettings {thresholdDb:number;minSilenceSeconds:number;beforeSeconds:number;afterSeconds:number}
export interface SilenceRange {startFrame:number;endFrame:number}
export const DEFAULT_SILENCE_SETTINGS:SilenceSettings={thresholdDb:-45,minSilenceSeconds:.3,beforeSeconds:.08,afterSeconds:.12};
export const MAX_SILENCE_RANGES=10_000;
export function silenceSettings(value:unknown):SilenceSettings {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('無音カットの設定が不正です');
  const v=value as Record<string,unknown>,keys=Object.keys(DEFAULT_SILENCE_SETTINGS);
  if(Object.keys(v).length!==keys.length||keys.some(k=>typeof v[k]!=='number'||!Number.isFinite(v[k])))throw new Error('無音カットの設定を数値で指定してください');
  const s=v as unknown as SilenceSettings;
  if(s.thresholdDb< -80||s.thresholdDb> -10||s.minSilenceSeconds<.05||s.minSilenceSeconds>10||s.beforeSeconds<0||s.beforeSeconds>2||s.afterSeconds<0||s.afterSeconds>2)throw new Error('無音カットの設定が範囲外です');
  return {...s};
}
export function validateSilenceRanges(ranges:readonly SilenceRange[],end:number):void {
  if(!Array.isArray(ranges)||ranges.length>MAX_SILENCE_RANGES)throw new Error('無音カットは10,000か所以内で指定してください');
  let last=0,total=0;
  for(const r of ranges){
    if(!r||Object.keys(r).some(k=>!['startFrame','endFrame'].includes(k))||!Number.isSafeInteger(r.startFrame)||!Number.isSafeInteger(r.endFrame)||r.startFrame<last||r.endFrame<=r.startFrame||r.endFrame>end)throw new Error('無音カットの範囲が不正です');
    last=r.endFrame;total+=r.endFrame-r.startFrame;
  }
  if(total>=end)throw new Error('動画全体が無音と判定されました。設定を見直してください');
}
export interface SilenceOwner {sessionId:string;expectedRevision:number}
export interface SilenceStatus {analysisId:string;phase:'analyzing'|'completed'|'failed'|'cancelled';percent:number;error?:string}
export interface SilencePlan {
  planId:string;planDigest:string;analysisId:string;sessionId:string;revision:number;
  ranges:SilenceRange[];removedFrames:number;resultFrames:number;settings:SilenceSettings;
  phase:'checking'|'ready'|'failed';error?:string;
}
