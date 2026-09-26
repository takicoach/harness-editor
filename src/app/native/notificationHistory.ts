import type {SequenceDocument,SequenceClip} from '../../core/sequence/model';
import {sourceTimeAt} from '../../core/sequence/model';
import {timeNumber} from '../../core/sequence/time';

export interface EditorNotification {
  id:string;severity:'error'|'warning'|'info';source:string;message:string;
  firstAt:number;lastAt:number;count:number;revision?:number;frame?:number;
}
export interface NotificationHistory {version:1;seenAt:number;records:EditorNotification[]}
export const emptyNotificationHistory=():NotificationHistory=>({version:1,seenAt:0,records:[]});
export const notificationStorageKey=(project:string)=>`harness:notifications:v1:${project}`;
export function readNotificationHistory(raw:string|null):NotificationHistory {
  try{
    const value=JSON.parse(raw??'null');
    if(value?.version!==1||!Number.isFinite(value.seenAt)||!Array.isArray(value.records))return emptyNotificationHistory();
    return {version:1,seenAt:value.seenAt,records:value.records.filter((r:EditorNotification)=>r&&typeof r.id==='string'
      &&['error','warning','info'].includes(r.severity)&&typeof r.source==='string'&&typeof r.message==='string'
      &&Number.isFinite(r.firstAt)&&Number.isFinite(r.lastAt)&&Number.isSafeInteger(r.count)&&r.count>0).slice(0,200)};
  }catch{return emptyNotificationHistory();}
}
export function appendNotification(history:NotificationHistory,input:Pick<EditorNotification,'severity'|'source'|'message'|'revision'|'frame'>,now=Date.now()):NotificationHistory {
  const message=input.message.slice(0,4000),source=input.source.slice(0,100);
  const previous=history.records.find(record=>record.source===source&&record.message===message&&record.severity===input.severity);
  const record:EditorNotification={...input,source,message,id:previous?.id??crypto.randomUUID(),firstAt:previous?.firstAt??now,lastAt:now,count:(previous?.count??0)+1};
  return {...history,records:[record,...history.records.filter(item=>item.id!==record.id)].slice(0,200)};
}
function ranges(clips:SequenceClip[],fps:SequenceDocument['fps']):Map<string,Array<[number,number]>>{
  const result=new Map<string,Array<[number,number]>>();
  for(const clip of clips){
    if(clip.content.kind!=='video')continue;
    const key=`${clip.content.assetId}:${clip.content.streamIndex}`;
    const list=result.get(key)??[];
    list.push([timeNumber(clip.content.sourceIn),timeNumber(sourceTimeAt(clip,clip.startFrame+clip.durationFrames,fps))]);result.set(key,list);
  }
  return result;
}
function unionLength(ranges:Array<[number,number]>):number {
  let total=0,end=-Infinity;
  for(const [a,b] of [...ranges].sort((a,b)=>a[0]-b[0])){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
  return total;
}
/** Compare known source ranges, so speed edits and duplicated AV/overlays do not inflate cut rate. */
export function nativeCutRateWarning(doc:SequenceDocument):string|null {
  const live=ranges(doc.clips.filter(clip=>doc.tracks.some(track=>track.id===clip.trackId&&track.enabled)),doc.fps);
  const archived=ranges((doc.cutArchive?.entries??[]).filter(entry=>!entry.sourceRecovery).flatMap(entry=>entry.clips.filter(clip=>entry.tracks.some(track=>track.id===clip.trackId&&track.enabled))),doc.fps);
  let kept=0,original=0;
  for(const key of new Set([...live.keys(),...archived.keys()])){kept+=unionLength(live.get(key)??[]);original+=unionLength([...(live.get(key)??[]),...(archived.get(key)??[])]);}
  if(original===0||kept>=original*.5)return null;
  return `カット率の警告: 記録のある映像範囲の ${Math.round((1-kept/original)*100)}% がカットされています。必要な場面が残っているか確認してください。`;
}

export function reportEditorError(projectId:string,source:string,message:string):void {
  window.dispatchEvent(new CustomEvent('harness-editor-notification',{detail:{projectId,source,message,severity:'error'}}));
}
