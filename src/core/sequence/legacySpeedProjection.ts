import {SequenceError} from './errors';

/** Already cut/reordered, PRE-speed playback coordinates. Array order is editing order. */
export interface LegacySpeedClip {
  readonly ownerId:string;
  readonly segmentId:number;
  readonly playbackStart:number;
  readonly playbackEnd:number;
}
export interface LegacySpeedOverlap {
  readonly afterOwnerId:string;
  /** Original requested duration, not the result of either half-length cap. */
  readonly durationFrames:number;
}
export interface LegacySpeedProjectionInput {
  readonly family:'legacy-js-v1';
  readonly evaluator:'legacy-preview-migration-v1';
  readonly mainSpeed:number;
  /** Keep ALL entries, including unused IDs and redundant values. Raw binary64, not Rational. */
  readonly segmentSpeeds:Readonly<Record<number,number>>;
  readonly clips:readonly LegacySpeedClip[];
  readonly overlaps:readonly LegacySpeedOverlap[];
  readonly playbackDurationFrames:number;
  readonly tailExtensionFrames:number;
}
export interface LegacySpeedMainEntry {
  readonly ownerId:string;readonly segmentId:number;readonly rate:number;
  readonly startFrame:number;readonly endFrame:number;readonly durationFrames:number;
  readonly scaledPlaybackStart:number;readonly scaledPlaybackEnd:number;readonly overlapBeforeFrames:number;
}
export interface LegacySpeedProjection {
  readonly family:'legacy-js-v1';readonly evaluator:'legacy-preview-migration-v1';
  /** Canonical binary64 input content, NOT a cryptographic digest or proof of legacy provenance. */
  readonly inputKey:string;
  readonly mode:'uniform'|'piecewise';readonly mainOverlapPath:boolean;
  readonly main:readonly LegacySpeedMainEntry[];
  readonly playbackOverlaps:readonly Readonly<{boundary:number;overlap:number}>[];
  readonly mainEndFrame:number;readonly sequenceEndFrame:number;
  /** Cut/reordered playback -> original overlap collapse -> speed. May collapse a positive range. */
  followFrame(playbackFrame:number):number;
  followRange(startFrame:number,endFrame:number):Readonly<{startFrame:number;endFrame:number}>;
  /** Speed ownership is half-open in PRE-speed segments, with last-segment fallback outside. */
  rateAtCollapsedFrame(frame:number):number;
  /** Global-follow insert rate only; does not change or adopt its stable own basis. */
  insertRateAt(playbackStart:number,ownRate:number):number;
}

const invalid=(message:string,owners:string[]=[]):never=>{throw new SequenceError('INVALID_RANGE',message,owners);};
function record(value:unknown,keys:readonly string[],label:string):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))invalid(`${label}の形式が不正です`);
  const object=value as Record<string,unknown>,prototype=Object.getPrototypeOf(object);
  if(prototype!==null&&prototype!==Object.prototype)invalid(`${label}には単純なデータが必要です`);
  if(Object.keys(object).some(k=>!keys.includes(k)))invalid(`${label}に未対応の項目があります`);
  return object;
}
function integer(value:number,label:string,negative=false):number {
  if(!Number.isSafeInteger(value)||(!negative&&value<0))invalid(`${label}には安全な整数が必要です`);
  return value;
}
function finite(value:number,label:string):number {
  if(typeof value!=='number'||!Number.isFinite(value))invalid(`${label}には有限の数値が必要です`);
  return value;
}
function saved(value:number):number {
  if(!Number.isSafeInteger(value))throw new SequenceError('TIME_OVERFLOW','旧速度計算の結果を安全な整数で保存できません');
  return value;
}
const clamp=(value:number)=>Math.min(16,Math.max(.1,value));
// Versioned speedEngine/applyMainSpeed order: do not rationalize the division.
const scale=(frame:number,rate:number)=>rate===1?frame:Math.round(frame/rate);
function bits(value:number):string {
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);
  return view.getUint32(0,false).toString(16).padStart(8,'0')+view.getUint32(4,false).toString(16).padStart(8,'0');
}

/**
 * Versioned subset of buildPlaybackModel + EditorComposition, used by existing v2 migration.
 * Old server/speedPayload has a DIFFERENT unused-ID branch. This function does not certify it.
 * No legacy-family registration, v2 equality check, media boundary, or metadata mutation occurs.
 */
export function buildLegacySpeedProjection(input:LegacySpeedProjectionInput):LegacySpeedProjection {
  record(input,['family','evaluator','mainSpeed','segmentSpeeds','clips','overlaps','playbackDurationFrames','tailExtensionFrames'],'旧速度入力');
  if(input.family!=='legacy-js-v1'||input.evaluator!=='legacy-preview-migration-v1')invalid('対応する旧プレビュー速度評価器を指定してください');
  const global=finite(input.mainSpeed,'全体速度');
  if(global<.1||global>16)invalid('全体速度は0.1倍から16倍で指定してください');
  const total=integer(input.playbackDurationFrames,'元の完成尺'),tail=integer(input.tailExtensionFrames,'追加した末尾尺');
  const overrides=input.segmentSpeeds;
  if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))invalid('個別速度の辞書が必要です');
  record(overrides,Object.keys(overrides),'個別速度');
  const speedValues=new Map<number,number>(),rawEntries=Object.entries(overrides).map(([id,value])=>{
    if(!/^(0|[1-9]\d*)$/.test(id)||!Number.isSafeInteger(Number(id)))invalid('個別速度の旧IDが不正です');
    finite(value,'個別速度');speedValues.set(Number(id),value);return [id,bits(value)] as const;
  }).sort(([a],[b])=>a<b?-1:a>b?1:0);
  if(!Array.isArray(input.clips)||!input.clips.length)invalid('評価する主映像がありません');
  const ownerIds=new Set<string>(),segmentIds=new Set<number>();let previousEnd=0;
  const clips=Array.from(input.clips,c=>{
    record(c,['ownerId','segmentId','playbackStart','playbackEnd'],'主映像区間');
    if(typeof c.ownerId!=='string'||!c.ownerId.trim()||ownerIds.has(c.ownerId))invalid('主映像の所有IDが空または重複しています');
    integer(c.segmentId,'旧区間ID');integer(c.playbackStart,'区間開始');integer(c.playbackEnd,'区間終了');
    if(segmentIds.has(c.segmentId)||c.playbackStart<previousEnd||c.playbackEnd<=c.playbackStart||c.playbackEnd>total)
      invalid('旧主映像のID・順序・配置範囲が不正です',[c.ownerId]);
    ownerIds.add(c.ownerId);segmentIds.add(c.segmentId);previousEnd=c.playbackEnd;
    return Object.freeze({...c});
  });
  if(!Array.isArray(input.overlaps))invalid('重なり要求の配列が必要です');
  const requestedOwners=new Set<string>();
  const requests=Array.from(input.overlaps,t=>{
    record(t,['afterOwnerId','durationFrames'],'重なり要求');
    const index=clips.findIndex(c=>c.ownerId===t.afterOwnerId);
    if(index<0||index===clips.length-1||requestedOwners.has(t.afterOwnerId))invalid('重なり境界の所有IDが不明・末尾・重複です',[t.afterOwnerId]);
    finite(t.durationFrames,'重なりの要求尺');
    if(t.durationFrames<0||t.durationFrames>Number.MAX_SAFE_INTEGER)invalid('重なりの要求尺が範囲外です',[t.afterOwnerId]);
    requestedOwners.add(t.afterOwnerId);
    return {afterOwnerId:t.afterOwnerId,boundary:clips[index]!.playbackEnd,durationFrames:t.durationFrames};
  });
  const mode=[...speedValues.values()].some(r=>clamp(r)!==clamp(global))?'piecewise':'uniform';
  // Approximate piecewise+overlap editing is outside this evaluator's first supported unit.
  if(mode==='piecewise'&&requests.some(t=>t.durationFrames>0))invalid('個別速度と重なる転換の組合せはまだ厳密に評価できません',requests.map(t=>t.afterOwnerId));
  const rates=clips.map(c=>mode==='uniform'?global:clamp(speedValues.get(c.segmentId)??global));
  const piecewise=(frame:number):number=>{
    let offset=0;
    for(const [i,c] of clips.entries()){
      if(frame<=c.playbackStart)return offset;
      const length=c.playbackEnd-c.playbackStart,scaledLength=Math.round(length/rates[i]!);
      if(frame<c.playbackEnd)return saved(offset+Math.round((frame-c.playbackStart)/rates[i]!));
      offset=saved(offset+scaledLength);
    }
    return offset;
  };
  const speed=(frame:number)=>mode==='uniform'?saved(scale(frame,global)):piecewise(frame);
  const scaled=clips.map(c=>({start:speed(c.playbackStart),end:speed(c.playbackEnd)}));
  // buildOverlaps runs twice: original cap for follow/total, then scaled requests for main.
  const capped=(windows:readonly {start:number;end:number}[],transitions:readonly {boundary:number;durationFrames:number}[])=>
    transitions.flatMap(t=>{
      const i=windows.findIndex(c=>c.end===t.boundary);
      if(i<0||i+1>=windows.length)return [];
      const cap=Math.floor(Math.min(windows[i]!.end-windows[i]!.start,windows[i+1]!.end-windows[i+1]!.start)/2);
      const overlap=Math.min(Math.max(0,Math.round(t.durationFrames)),cap);
      return overlap>0?[Object.freeze({boundary:t.boundary,overlap})]:[];
    }).sort((a,b)=>a.boundary-b.boundary);
  const originalOverlaps=capped(clips.map(c=>({start:c.playbackStart,end:c.playbackEnd})),requests);
  const mainOverlapPath=originalOverlaps.length>0;
  // At rate=1 the old speedScale is identity, including fractional requests.
  // This unsaved intermediate must reach buildOverlaps' Math.round unchanged.
  const renderOverlapMap=new Map(capped(scaled,requests.map(t=>({boundary:speed(t.boundary),durationFrames:mode==='uniform'?scale(t.durationFrames,global):piecewise(t.durationFrames)}))).map(o=>[o.boundary,o.overlap]));
  let cursor=0;
  const main=clips.map((c,i)=>{
    let overlap=0;
    if(mainOverlapPath&&i>0){
      // transitionSeriesChildren first resolves the join at the scaled previous boundary.
      // Keep first-match semantics even if short clips collapse multiple join coordinates.
      const joinIndex=scaled.slice(0,-1).findIndex(s=>s.end===scaled[i-1]!.end);
      if(joinIndex>=0&&requestedOwners.has(clips[joinIndex]!.ownerId))overlap=renderOverlapMap.get(scaled[i-1]!.end)??0;
    }
    const duration=Math.max(1,scaled[i]!.end-scaled[i]!.start);
    const start=mainOverlapPath?saved(cursor-overlap):scaled[i]!.start,end=saved(start+duration);
    cursor=end;
    return Object.freeze({ownerId:c.ownerId,segmentId:c.segmentId,rate:rates[i]!,startFrame:start,endFrame:end,durationFrames:duration,
      scaledPlaybackStart:scaled[i]!.start,scaledPlaybackEnd:scaled[i]!.end,overlapBeforeFrames:overlap});
  });
  const mainEnd=main.reduce((end,c)=>Math.max(end,c.endFrame),0);
  const initialDuration=Math.max(1,Math.max(0,total-originalOverlaps.reduce((sum,o)=>sum+o.overlap,0)));
  // applySpeed ignores model.duration for piecewise. Do not replace this with mainEnd.
  const duration=mode==='uniform'?Math.max(1,speed(initialDuration))
    :Math.max(1,clips.reduce((sum,c,i)=>saved(sum+Math.round((c.playbackEnd-c.playbackStart)/rates[i]!)),0));
  const sequenceEnd=saved(duration+tail);
  const collapse=(frame:number)=>frame-originalOverlaps.reduce((shift,o)=>frame>=o.boundary?shift+o.overlap:shift,0);
  const rateAt=(frame:number)=>{
    if(mode==='uniform')return global;
    const index=clips.findIndex(c=>frame>=c.playbackStart&&frame<c.playbackEnd);
    return rates[index<0?rates.length-1:index]!;
  };
  const follow=(frame:number)=>speed(collapse(integer(frame,'追従する時刻',true)));
  const inputKey=JSON.stringify([input.family,input.evaluator,bits(global),rawEntries,
    clips.map(c=>[c.ownerId,bits(c.segmentId),bits(c.playbackStart),bits(c.playbackEnd)]),
    requests.map(t=>[t.afterOwnerId,bits(t.durationFrames)]),bits(total),bits(tail)]);
  return Object.freeze({family:'legacy-js-v1',evaluator:'legacy-preview-migration-v1',inputKey,mode,mainOverlapPath,
    main:Object.freeze(main),playbackOverlaps:Object.freeze(originalOverlaps),mainEndFrame:mainEnd,sequenceEndFrame:sequenceEnd,
    followFrame:follow,
    followRange(start:number,end:number){integer(start,'追従範囲の開始',true);integer(end,'追従範囲の終了',true);if(end<start)invalid('追従範囲の順序が逆です');return Object.freeze({startFrame:follow(start),endFrame:follow(end)});},
    rateAtCollapsedFrame(frame:number){return rateAt(integer(frame,'速度所属の時刻',true));},
    insertRateAt(frame:number,ownRate:number){finite(ownRate,'挿入自身の速度');if(ownRate<=0)invalid('挿入自身の速度は正の値が必要です');const value=ownRate*rateAt(collapse(integer(frame,'挿入の開始',true)));return finite(value,'挿入の合成速度');},
  });
}
