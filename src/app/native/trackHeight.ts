import {waveformCanvasHeight,waveformTrackHeight,type WaveformPref} from '../layout/waveformPref';

export const MIN_TRACK_HEIGHT=28;
export const DEFAULT_TRACK_HEIGHT=46;
export const MAX_TRACK_HEIGHT=72;
export const CAPTION_TRACK_HEIGHT=28;
const KEY='harness-native-track-height';
export function loadTrackHeight():number {
  try {
    const raw=localStorage.getItem(KEY),value=Number(raw);
    if(raw!==null&&Number.isFinite(value)&&value>=MIN_TRACK_HEIGHT&&value<=MAX_TRACK_HEIGHT)return Math.round(value);
  } catch { /* Layout remains usable when storage is unavailable. */ }
  return DEFAULT_TRACK_HEIGHT;
}
export function saveTrackHeight(value:number):void {
  try {localStorage.setItem(KEY,String(value));} catch { /* Optional display preference. */ }
}
/** Rendering and vertical viewport culling must use exactly the same row sizes. */
export function trackHeights(height:number,waveform:WaveformPref){
  const visual=Math.max(MIN_TRACK_HEIGHT,Math.min(MAX_TRACK_HEIGHT,height));
  const ratio=visual/DEFAULT_TRACK_HEIGHT;
  const audio=Math.max(MIN_TRACK_HEIGHT,Math.round(waveformTrackHeight(waveform)*ratio));
  const cut=Math.max(MIN_TRACK_HEIGHT,Math.round(58*ratio));
  return {visual,audio,cut,waveform:Math.max(8,Math.min(audio-18,Math.round(waveformCanvasHeight(waveform)*ratio)))};
}

export const MAX_INDIVIDUAL_TRACK_HEIGHT=180;
export type TrackHeightScales=Record<string,number>;
const scalesKey=(projectId:string,documentId:string)=>`harness-native-track-scales:${JSON.stringify([projectId,documentId])}`;
export function loadTrackHeightScales(projectId:string,documentId:string):TrackHeightScales {
  try {
    const raw=localStorage.getItem(scalesKey(projectId,documentId));
    if(!raw||raw.length>65536)return {};
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=='object'||Array.isArray(value))return {};
    return Object.fromEntries(Object.entries(value).filter(([,scale])=>typeof scale==='number'&&Number.isFinite(scale)&&scale>=.1&&scale<=7));
  } catch {return {};}
}
export function saveTrackHeightScales(projectId:string,documentId:string,scales:TrackHeightScales):void {
  try {localStorage.setItem(scalesKey(projectId,documentId),JSON.stringify(scales));} catch { /* Optional layout preference. */ }
}
export function individualTrackHeight(base:number,scale=1):number {
  return Math.max(MIN_TRACK_HEIGHT,Math.min(MAX_INDIVIDUAL_TRACK_HEIGHT,Math.round(base*(Number.isFinite(scale)?scale:1))));
}
