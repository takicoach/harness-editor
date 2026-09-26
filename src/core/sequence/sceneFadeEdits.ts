import {SequenceError} from './errors';
import {clipEnd,type SequenceClip,type SequenceDocument,type SequenceTrack} from './model';
import {addTime,subtractTime,divideTime,compareTime,rational as r,ceilTime,timeNumber,type Rational} from './time';
import {DEFAULT_MAIN_LAYOUT} from '../mainLayout';

export type SceneFadeTarget={kind:'head'|'tail'}|{kind:'join';trackId:string;outClipId:string;inClipId:string}|{kind:'clip';clipId:string};
export interface SceneFadeChange {enabled?:boolean;color?:string;durationFrames?:number;moveFromClipId?:string;newAtTarget?:boolean}
// A bounded single transaction, independent of the generic API's 50-command batch.
export const MAX_SCENE_FADE_TARGETS=1000;
/** Add above general visuals and below only the uppermost pure fade lanes. Do not undo manual track ordering. */
export function sceneFadeInsertionIndex(doc:SequenceDocument):number{
  let index=doc.tracks.length;
  for(let i=doc.tracks.length-1;i>=0;i--){
    const track=doc.tracks[i]!;if(track.kind!=='visual')continue;
    const clips=doc.clips.filter(c=>c.trackId===track.id);
    if(!clips.length||clips.some(c=>c.content.kind!=='scene-fade'))break;
    index=i;
  }
  return index;
}
export function hasSceneFade(doc:SequenceDocument,trackId:string):boolean{return doc.clips.some(c=>c.trackId===trackId&&c.content.kind==='scene-fade');}
const fail=(message:string):never=>{throw new SequenceError('INVALID_RANGE',message);};
export function validateSceneFadeEdit(targets:unknown,change:unknown):asserts targets is SceneFadeTarget[]{
  if(!Array.isArray(targets)||!targets.length||targets.length>MAX_SCENE_FADE_TARGETS)fail(`フェードの対象は1〜${MAX_SCENE_FADE_TARGETS}件で指定してください`);
  const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
  for(const t of targets as Array<Record<string,unknown>>){
    if(!t||typeof t!=='object'||Array.isArray(t))fail('フェードの対象が不正です');
    const fields=t.kind==='head'||t.kind==='tail'?['kind']:t.kind==='join'?['kind','trackId','outClipId','inClipId']:t.kind==='clip'?['kind','clipId']:[];
    if(!fields.length||Object.keys(t).some(k=>!fields.includes(k))||fields.some(k=>k!=='kind'&&!id(t[k])))fail('フェードの対象が不正です');
  }
  if(!change||typeof change!=='object'||Array.isArray(change))fail('フェードの変更が不正です');
  const c=change as Record<string,unknown>;
  if(!Object.keys(c).length||Object.keys(c).some(k=>!['enabled','color','durationFrames','moveFromClipId','newAtTarget'].includes(k))
    ||(c.moveFromClipId!==undefined&&!id(c.moveFromClipId))||(c.newAtTarget!==undefined&&typeof c.newAtTarget!=='boolean')
    ||((c.moveFromClipId!==undefined||c.newAtTarget===true)&&(c.enabled!==true||c.moveFromClipId!==undefined&&c.newAtTarget===true))
    ||(c.enabled!==undefined&&typeof c.enabled!=='boolean')||(c.color!==undefined&&(typeof c.color!=='string'||!/^#[a-fA-F0-9]{6}$/.test(c.color)))
    ||(c.durationFrames!==undefined&&(!Number.isSafeInteger(c.durationFrames)||(c.durationFrames as number)<2)))fail('フェードの種類・色・長さが不正です');
}
export function sceneFadeTargetKey(t:SceneFadeTarget):string{
  return t.kind==='join'?`join:${encodeURIComponent(t.trackId)}:${encodeURIComponent(t.outClipId)}:${encodeURIComponent(t.inClipId)}`:t.kind==='clip'?`clip:${encodeURIComponent(t.clipId)}`:t.kind;
}
export function sceneFadeJoins(doc:SequenceDocument):Array<{target:Extract<SceneFadeTarget,{kind:'join'}>;frame:number;label:string}>{
  return doc.tracks.filter(t=>t.kind==='visual').flatMap(track=>{
    const videos=doc.clips.filter(c=>c.trackId===track.id&&c.content.kind==='video').sort((a,b)=>a.startFrame-b.startFrame);
    return videos.slice(1).flatMap((incoming,i)=>{const out=videos[i]!;
      return clipEnd(out)===incoming.startFrame?[{target:{kind:'join' as const,trackId:track.id,outClipId:out.id,inClipId:incoming.id},frame:incoming.startFrame,label:`${track.name} · ${out.name} → ${incoming.name}（${incoming.startFrame}fr）`}]:[];
    });
  });
}
function endpoint(clip:SequenceClip):Rational{
  if(clip.content.kind!=='scene-fade')return fail('場面フェードを選択してください');
  const position=clip.content.phase==='head'?r(0):clip.content.phase==='tail'?clip.clock.duration:divideTime(clip.clock.duration,r(2));
  return addTime(r(clip.startFrame),divideTime(subtractTime(position,clip.clock.offset),clip.clock.rate));
}
export function sceneFadeIssue(clip:SequenceClip):string|null{
  if(clip.content.kind!=='scene-fade')return '場面フェードを選択してください';
  const v=clip.visual;
  if(compareTime(clip.clock.rate,r(1))!==0||!Number.isSafeInteger(timeNumber(clip.clock.duration)))return '標準外の時計を持つフェードです。色の変更と解除ができます。';
  try{endpoint(clip);}catch{return '時計の計算範囲を超えるフェードです。色の変更と解除ができます。';}
  const layout=v?.layout,base=DEFAULT_MAIN_LAYOUT;
  if(v&&(v.opacity!==1||v.keyframes.length||v.motion||v.enter||v.exit||layout!.scale!==base.scale||layout!.position.x!==0||layout!.position.y!==0||layout!.rotation!==0||layout!.flipH||layout!.flipV))return '標準外の動きを持つフェードです。色の変更と解除ができます。';
  return null;
}
export function resolveSceneFade(doc:SequenceDocument,target:SceneFadeTarget):{clip?:SequenceClip;phase:'head'|'tail'|'join';frame:Rational;displaced?:SequenceClip[]}{
  if(target.kind==='clip'){
    const clip=doc.clips.find(c=>c.id===target.clipId);if(!clip||clip.content.kind!=='scene-fade')return fail('対象の場面フェードが見つかりません');
    // Color-only edits must remain available even if the derived endpoint overflows.
    let frame:Rational;try{frame=endpoint(clip);}catch{frame=r(clip.startFrame);}
    return {clip,phase:clip.content.phase,frame};
  }
  let frame=target.kind==='head'?r(0):r(doc.sequenceEndFrame);
  if(target.kind==='join'){
    const out=doc.clips.find(c=>c.id===target.outClipId),incoming=doc.clips.find(c=>c.id===target.inClipId);
    if(!out||!incoming||out.content.kind!=='video'||incoming.content.kind!=='video'||out.trackId!==target.trackId||incoming.trackId!==target.trackId||out.id===incoming.id||clipEnd(out)!==incoming.startFrame)fail('映像のつなぎ目が変わりました。接続している映像を選び直してください');
    frame=r(incoming!.startFrame);
  }
  const matches=doc.clips.filter(c=>{if(c.content.kind!=='scene-fade'||c.content.phase!==target.kind)return false;try{return compareTime(endpoint(c),frame)===0;}catch{return false;}});
  if(matches.length>1)fail('同じ位置に複数のフェードがあります。既存の場面フェードを選択してください');
  const joins=!matches.length&&target.kind==='join'&&doc.clips.some(c=>c.content.kind==='scene-fade'&&c.content.phase==='join')?sceneFadeJoins(doc):[];
  const displaced=matches.length?[]:doc.clips.filter(c=>{
    if(c.content.kind!=='scene-fade'||c.content.phase!==target.kind)return false;
    try{return target.kind!=='join'||!joins.some(j=>compareTime(endpoint(c),r(j.frame))===0);}catch{return true;}
  });
  return {clip:matches[0],phase:target.kind,frame,displaced};
}
/** One atomic edit. Existing clip IDs, clocks and nonstandard effects are retained unless explicitly edited. */
export function editSceneFades(doc:SequenceDocument,targets:SceneFadeTarget[],change:SceneFadeChange):SequenceDocument{
  validateSceneFadeEdit(targets,change);
  const resolved=targets.map(target=>resolveSceneFade(doc,target)),seen=new Set<string>();
  const ids=new Set([...doc.clips,...doc.tracks,...doc.assets,...doc.transitions].map(v=>v.id));let serial=0;
  const allocate=(prefix:string)=>{let id:string;do{id=`${prefix}-${++serial}`;}while(ids.has(id));ids.add(id);return id;};
  const replacements=new Map<string,SequenceClip|null>(),created:SequenceClip[]=[];
  for(const value of resolved){
    let {clip}=value;const {phase,frame,displaced}=value;
    if(change.moveFromClipId){
      if(targets.length!==1||clip||!displaced?.some(c=>c.id===change.moveFromClipId))fail('移動するフェードを選び直してください');
      clip=displaced!.find(c=>c.id===change.moveFromClipId)!;
      if(sceneFadeIssue(clip))fail('標準外の時計・動きを持つフェードはこの位置へ移動できません。個別に選択してください');
    }else if(displaced?.length&&!change.newAtTarget)fail('位置がずれた既存フェードがあります。既存フェードの移動・解除または新規追加を選んでください');
    if(change.newAtTarget&&clip)fail('この位置にはすでにフェードがあります');
    if(targets.length>1&&clip&&sceneFadeIssue(clip))fail('標準外のフェードを含むため一括変更できません。個別に選択してください');
    const key=clip?.id??`${phase}:${frame.num}/${frame.den}`;
    if(seen.has(key))continue;seen.add(key);
    if(change.enabled===false){if(clip)replacements.set(clip.id,null);continue;}
    if(!clip&&change.enabled!==true)fail('フェードが解除されています。種類を選び直してください');
    if(clip&&change.durationFrames!==undefined&&sceneFadeIssue(clip))fail(sceneFadeIssue(clip)!);
    const next:SequenceClip=clip?structuredClone(clip):{id:allocate('scene-fade'),trackId:'',name:'場面フェード',startFrame:0,durationFrames:1,clock:{offset:r(0),rate:r(1),duration:r(15)},content:{kind:'scene-fade',phase,color:'#000000'}};
    if(next.content.kind!=='scene-fade')return fail('場面フェードを選択してください');
    if(change.color!==undefined)next.content.color=change.color;
    if(!clip||change.durationFrames!==undefined||change.moveFromClipId){
      const duration=change.durationFrames??(clip?timeNumber(clip.clock.duration):15);
      const origin=phase==='head'?frame:subtractTime(frame,phase==='tail'?r(duration):divideTime(r(duration),r(2)));
      const start=Math.max(0,ceilTime(origin)),end=Math.min(doc.sequenceEndFrame,ceilTime(addTime(origin,r(duration))));
      if(end<=start)fail('フェードを表示できる範囲がありません');
      next.startFrame=start;next.durationFrames=end-start;next.clock={offset:subtractTime(r(start),origin),rate:r(1),duration:r(duration)};
    }
    if(clip)replacements.set(clip.id,next);else created.push(next);
  }
  const clips=doc.clips.flatMap(c=>replacements.has(c.id)?replacements.get(c.id)??[]:[c]).concat(created);
  if(JSON.stringify(clips)===JSON.stringify(doc.clips))return doc;
  const fades=clips.filter(c=>c.content.kind==='scene-fade').sort((a,b)=>{
    const ai=doc.tracks.findIndex(t=>t.id===a.trackId),bi=doc.tracks.findIndex(t=>t.id===b.trackId);
    return (ai<0?doc.tracks.length:ai)-(bi<0?doc.tracks.length:bi);
  });
  // Preserve the existing color-plane stacking order; overlapping planes need
  // distinct lanes, just like migrateLegacy.appendGroup, never fake transitions.
  const oldFadeTracks=doc.tracks.filter(t=>doc.clips.some(c=>c.trackId===t.id&&c.content.kind==='scene-fade')&&!doc.clips.some(c=>c.trackId===t.id&&c.content.kind!=='scene-fade'));
  const reusable=[...oldFadeTracks],lanes:Array<{track:SequenceTrack;clips:SequenceClip[]}>=[],moved=new Map<string,SequenceClip>();
  for(const fade of fades){
    const enabled=doc.tracks.find(t=>t.id===fade.trackId)?.enabled??true;
    let minimum=0;for(const [i,lane] of lanes.entries())if(lane.clips.some(c=>c.startFrame<clipEnd(fade)&&fade.startFrame<clipEnd(c)))minimum=i+1;
    let index=minimum;while(lanes[index]&&lanes[index]!.track.enabled!==enabled)index++;
    if(!lanes[index]){
      // Fill any skipped lane slots without changing the previous planes' order.
      index=lanes.length;
      const reuseIndex=reusable.findIndex(t=>t.enabled===enabled),prior=reuseIndex<0?undefined:reusable.splice(reuseIndex,1)[0];
      lanes.push({track:prior??{id:allocate('scene-fade-track'),name:'場面フェード',kind:'visual',enabled},clips:[]});
    }
    const placed={...fade,trackId:lanes[index]!.track.id};lanes[index]!.clips.push(placed);moved.set(fade.id,placed);
  }
  return {...doc,clips:clips.map(c=>moved.get(c.id)??c),tracks:[...doc.tracks.filter(t=>!oldFadeTracks.some(f=>f.id===t.id)),...lanes.map(l=>l.track)]};
}
/** The join/head/tail frame a fade is centred on. Shared so other commands match fades the same way. */
export {endpoint as sceneFadeEndpoint};
