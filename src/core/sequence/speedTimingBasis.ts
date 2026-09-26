import {SequenceError} from './errors';
import {type SequenceDocument,type SequenceClip,type EffectClock,type SpeedTimingBasis,type SpeedTimingPoint,type SpeedTimingClip,clipEnd} from './model';
import {addTime,subtractTime,multiplyTime,divideTime,rational,isRational,type Rational} from './time';
import {captionInputDigest,captionLedgers,captionProjectionInput,historicalDocument,speedProjectionForDocument,type DocumentSpeedProjection} from './speedCaptionLedger';
import {phasePoint} from './speedTopologyProjection';
import {validateSequenceDocument} from './validate';
const fail=(message:string,ids:string[]=[]):never=>{throw new SequenceError('INVALID_DOCUMENT',message,ids);};
const same=(a:unknown,b:unknown)=>captionInputDigest(a)===captionInputDigest(b);
const object=(value:unknown,keys:string[],optional:string[]=[]):void=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)&&!optional.includes(k))||keys.some(k=>!Object.hasOwn(value,k)))fail('速度の色面時刻基準が不正です');};
const safe=(n:number)=>{if(!Number.isSafeInteger(n)||n<0)fail('色面の時刻を安全な整数で保存できません');return n;};
export function timingReservedIds(t:SpeedTimingBasis|undefined):string[]{return t?.clips.flatMap(c=>c.parts.map(p=>p.renderId))??[];}
function value(p:DocumentSpeedProjection,point:SpeedTimingPoint):number {
 if(point.kind==='fixed'){object(point,['kind','frame']);return safe(point.frame);}
 object(point,['kind','ownerId','offset']);if(!['clip','gap-before','after-main'].includes(point.kind)||typeof point.ownerId!=='string')return fail('色面の時刻ownerが不正です');
 if(!isRational(point.offset)||Object.keys(point.offset).some(k=>k!=='num'&&k!=='den'))return fail('色面の時刻offsetが不正です');
 return p.point(point);
}
function region(p:DocumentSpeedProjection,a:number,b:number,preferred?:string):{start:SpeedTimingPoint;end:SpeedTimingPoint}{
 const owners=p.entries.filter(e=>e.startFrame<=a&&e.endFrame>=b),e=owners.find(e=>e.ownerId===preferred)??owners.at(-1);
 if(e)return {start:{kind:'clip',ownerId:e.ownerId,offset:p.inverse(e.ownerId,a)},end:{kind:'clip',ownerId:e.ownerId,offset:p.inverse(e.ownerId,b)}};
 const gap=p.entries.find(e=>e.gapStartFrame<=a&&e.gapEndFrame>=b&&e.gapEndFrame>e.gapStartFrame);
 if(gap)return {start:{kind:'gap-before',ownerId:gap.ownerId,offset:p.inverse(gap.ownerId,a,'gap-before')},end:{kind:'gap-before',ownerId:gap.ownerId,offset:p.inverse(gap.ownerId,b,'gap-before')}};
 if(a>=p.mainEndFrame&&b<=p.sequenceEndFrame&&p.sequenceEndFrame>p.mainEndFrame&&p.entries.length){const ownerId=p.entries.at(-1)!.ownerId;return {start:{kind:'after-main',ownerId,offset:rational(a-p.mainEndFrame)},end:{kind:'after-main',ownerId,offset:rational(b-p.mainEndFrame)}};}
 return {start:{kind:'fixed',frame:a},end:{kind:'fixed',frame:b}};
}
function boundaries(p:DocumentSpeedProjection,start:number,end:number):number[]{return [...new Set([start,end,...p.entries.flatMap(e=>[e.startFrame,e.endFrame,e.gapStartFrame,e.gapEndFrame]),p.mainEndFrame,p.sequenceEndFrame])].filter(n=>n>=start&&n<=end).sort((a,b)=>a-b);}
/** Exact evaluation coordinates of the saved owner. Mixed child overrides use
 * that child's counterfactual original clock, not a newly sampled sourceIn. */
function coordinate(p:DocumentSpeedProjection,point:SpeedTimingPoint):{at:Rational;rate:Rational}{
 if(point.kind==='fixed')return {at:rational(point.frame),rate:rational(1)};
 if(point.kind!=='clip')return {at:point.offset,rate:rational(1)};
 const rate=p.rate(point.ownerId),offset=addTime(p.offset(point.ownerId),point.offset);
 return {at:multiplyTime(rational(phasePoint(p.phase(point.ownerId),offset,rate,p.mode)),rate),rate};
}
function snapshot(doc:SequenceDocument,t:SpeedTimingBasis):string{const input=captionProjectionInput(doc),key=captionInputDigest(input);if(!t.baselines.some(s=>s.key===key))t.baselines.push({key,input});return key;}
export function captureTimingClip(doc:SequenceDocument,clip:SequenceClip,t:SpeedTimingBasis,fresh:()=>string):SpeedTimingClip {
 const p=speedProjectionForDocument(doc),edges=boundaries(p,clip.startFrame,clipEnd(clip));
 const original=structuredClone(clip);delete original.speed;
 return {logicalId:clip.id,snapshotKey:snapshot(doc,t),original,parts:edges.slice(1).map((end,i)=>({renderId:i===0?clip.id:fresh(),...region(p,edges[i]!,end)}))};
}
export function captureSpeedTiming(doc:SequenceDocument,fresh:()=>string):SpeedTimingBasis|undefined {
 const t:SpeedTimingBasis={baselines:[],clips:[],fades:[]},p=speedProjectionForDocument(doc);
 for(const clip of doc.clips)if(clip.content.kind==='scene-fade')t.clips.push(captureTimingClip(doc,clip,t,fresh));
 for(const tr of doc.transitions)if(!tr.inClipId)t.fades.push({snapshotKey:snapshot(doc,t),original:structuredClone(tr),...region(p,tr.startFrame,tr.startFrame+tr.durationFrames,tr.outClipId)});
 return t.clips.length||t.fades.length?t:undefined;
}
function historical(doc:SequenceDocument,t:SpeedTimingBasis):Map<string,DocumentSpeedProjection>{
 const result=new Map<string,DocumentSpeedProjection>();
 if(!Array.isArray(t.baselines)||!Array.isArray(t.clips)||!Array.isArray(t.fades))return fail('色面時刻基準の一覧が不正です');
 for(const s of t.baselines){object(s,['key','input']);if(typeof s.key!=='string'||!/^[a-f0-9]{64}$/.test(s.key)||result.has(s.key)||captionInputDigest(s.input)!==s.key)fail('色面時刻の履歴識別が不正です');result.set(s.key,speedProjectionForDocument(historicalDocument(doc,s.input)));}
 return result;
}
function adjustedClock(c:EffectClock,partStart:number,originalStart:number,point:SpeedTimingPoint,old:DocumentSpeedProjection,current:DocumentSpeedProjection):EffectClock{
 const a=coordinate(old,point),b=coordinate(current,point),slope=divideTime(c.rate,a.rate);
 return {offset:addTime(addTime(c.offset,multiplyTime(rational(partStart-originalStart),c.rate)),multiplyTime(subtractTime(b.at,a.at),slope)),rate:multiplyTime(slope,b.rate),duration:structuredClone(c.duration)};
}
export interface TimingMaterialization {clips:SequenceClip[];groups:Map<string,string[]>;fades:SequenceDocument['transitions']}
export function materializeSpeedTiming(doc:SequenceDocument,t:SpeedTimingBasis):TimingMaterialization {
 const old=historical(doc,t),p=speedProjectionForDocument(doc),clips:SequenceClip[]=[],groups=new Map<string,string[]>(),positiveByLogical=new Map<string,number>();
 for(const record of t.clips){const baseline=old.get(record.snapshotKey);if(!baseline)return fail('色面の履歴がありません',[record.original.id]);let last:SequenceClip|undefined;let positives=0;
  for(const part of record.parts){const start=value(p,part.start),end=value(p,part.end);if(end<start)return fail('速度変更で色面の順序が逆転します',[part.renderId]);if(end===start)continue;positives++;
   const at=value(baseline,part.start),c:SequenceClip={...structuredClone(record.original),id:part.renderId,startFrame:start,durationFrames:end-start,clock:adjustedClock(record.original.clock,at,record.original.startFrame,part.start,baseline,p)};
   const key=record.original.visual?.keyframeClock;if(c.visual&&key)c.visual.keyframeClock=adjustedClock(key,at,record.original.startFrame,part.start,baseline,p);
   const staticFields=(v:SequenceClip)=>{const {id:_,startFrame:__,durationFrames:___,clock:____,...rest}=v;if(rest.visual)rest.visual={...rest.visual,keyframeClock:undefined};return rest;};
   const continuous=(a:EffectClock,b:EffectClock,length:number)=>same(a.rate,b.rate)&&same(a.duration,b.duration)&&same(addTime(a.offset,multiplyTime(rational(length),a.rate)),b.offset);
   if(last&&clipEnd(last)===start&&same(staticFields(last),staticFields(c))&&continuous(last.clock,c.clock,last.durationFrames)&&(!last.visual?.keyframeClock&&!c.visual?.keyframeClock||!!last.visual?.keyframeClock&&!!c.visual?.keyframeClock&&continuous(last.visual.keyframeClock,c.visual.keyframeClock,last.durationFrames))){last.durationFrames+=c.durationFrames;groups.get(last.id)!.push(part.renderId);}
   else{last=c;clips.push(c);groups.set(c.id,[part.renderId]);}
  }
  positiveByLogical.set(record.logicalId,(positiveByLogical.get(record.logicalId)??0)+positives);
 }
 for(const [logical,count] of positiveByLogical)if(!count)return fail('速度変更で色面全体が0フレームになります',[logical]);
 const fades=t.fades.map(f=>{const startFrame=value(p,f.start),end=value(p,f.end);if(end<=startFrame)return fail('速度変更でフェードが0フレームになります',[f.original.id]);return {...structuredClone(f.original),startFrame,durationFrames:end-startFrame};});
 return {clips,groups,fades};
}
/** Independently verify every historical input and every saved baseline interval,
 * even when the current speed differs. No validator recapture/update occurs. */
export function validateSpeedTiming(doc:SequenceDocument,t:SpeedTimingBasis):void {
 object(t,['baselines','clips','fades']);const history=historical(doc,t),used=new Set<string>(),ids=new Set<string>();
 const currentIds=new Set(doc.clips.filter(c=>c.content.kind!=='scene-fade').map(c=>c.id));
 const occupied=new Set([...doc.assets,...doc.tracks,...doc.transitions].map(x=>x.id));for(const l of captionLedgers(doc)){occupied.add(l.captionId);for(const p of l.parts){occupied.add(p.partId);occupied.add(p.reservedRenderId);}}for(const c of doc.clips)if(c.linkGroupId)occupied.add(c.linkGroupId);
 for(const record of t.clips){object(record,['logicalId','snapshotKey','original','parts']);if(typeof record.logicalId!=='string'||!record.logicalId)fail('色面の論理IDが不正です');const p=history.get(record.snapshotKey);if(!p)return fail('色面baselineがありません');used.add(record.snapshotKey);
  if(record.original?.content?.kind!=='scene-fade'||Object.hasOwn(record.original,'speed')||!Array.isArray(record.parts)||!record.parts.length)return fail('色面baselineの種類またはpartが不正です');
  object(record.original,['id','trackId','name','startFrame','durationFrames','clock','content'],['visual','anchor','linkGroupId','continuationGroupId']);
  const plain={...doc,speed:undefined,insertOwnSpeed:undefined,transitions:[],clips:[structuredClone(record.original)]};validateSequenceDocument(plain);
  let cursor=record.original.startFrame;
  for(const part of record.parts){object(part,['renderId','start','end']);if(typeof part.renderId!=='string'||!part.renderId||ids.has(part.renderId)||currentIds.has(part.renderId)||occupied.has(part.renderId))return fail('色面の予約IDが衝突しています',[part.renderId]);ids.add(part.renderId);
   const start=value(p,part.start),end=value(p,part.end);if(start!==cursor||end<=start||part.start.kind!==part.end.kind||part.start.kind!=='fixed'&&part.end.kind!=='fixed'&&part.start.ownerId!==part.end.ownerId)return fail('色面baselineの区間が一致しません',[part.renderId]);cursor=end;
  }
  if(cursor!==clipEnd(record.original)||record.parts[0]!.renderId!==record.original.id)return fail('色面baselineの端または元IDが一致しません');
 }
 const fadeIds=new Set<string>();for(const fade of t.fades){object(fade,['snapshotKey','original','start','end']);const p=history.get(fade.snapshotKey);if(!p)return fail('フェードbaselineがありません');used.add(fade.snapshotKey);const f=fade.original;object(f,['id','trackId','outClipId','kind','startFrame','durationFrames'],['edge','audioCurve']);
  if(f.inClipId||fadeIds.has(f.id)||value(p,fade.start)!==f.startFrame||value(p,fade.end)!==f.startFrame+f.durationFrames)return fail('フェードbaselineの範囲が一致しません',[f.id]);fadeIds.add(f.id);
 }
 if(used.size!==history.size)return fail('未参照の色面baselineがあります');
 if(doc.clips.some(c=>c.content.kind==='scene-fade'&&!ids.has(c.id))||doc.transitions.some(f=>!f.inClipId&&!fadeIds.has(f.id)))fail('色面または単独フェードの保存基準が欠けています');
 const expected=materializeSpeedTiming(doc,t),actual=doc.clips.filter(c=>ids.has(c.id));if(actual.length!==expected.clips.length||actual.some(c=>!same(c,expected.clips.find(e=>e.id===c.id))))return fail('色面の表示と保存時刻intentが一致しません');
 const actualFades=doc.transitions.filter(f=>fadeIds.has(f.id));if(!same(actualFades,expected.fades))return fail('単独フェードの表示と保存時刻intentが一致しません');
}

// Ordinary rebuild supplies actual ownership, never continuation/name heuristics.
type Fragment={clip:SequenceClip;original:SequenceClip;slice:{from:number;to:number;start:number}};
const rebuiltFragments=new WeakMap<SequenceDocument,ReadonlyMap<string,readonly Fragment[]>>();
export function rememberTimingFragments(doc:SequenceDocument,fragments:ReadonlyMap<string,readonly Fragment[]>):void{rebuiltFragments.set(doc,fragments);}
function sliceRecord(record:SpeedTimingClip,parts:SpeedTimingClip['parts'],baseline:DocumentSpeedProjection):SpeedTimingClip {
 const start=value(baseline,parts[0]!.start),end=value(baseline,parts.at(-1)!.end),original=structuredClone(record.original);
 const clock=(c:EffectClock):EffectClock=>({...c,offset:addTime(c.offset,multiplyTime(rational(start-original.startFrame),c.rate))});
 original.clock=clock(original.clock);if(original.visual?.keyframeClock)original.visual.keyframeClock=clock(original.visual.keyframeClock);
 original.id=parts[0]!.renderId;original.startFrame=start;original.durationFrames=end-start;
 return {...structuredClone(record),original,parts:structuredClone(parts)};
}
function presentation(c:SequenceClip){const {id:_,startFrame:__,durationFrames:___,clock:____,...rest}=structuredClone(c);if(rest.visual)delete rest.visual.keyframeClock;return rest;}
function copyPresentation(original:SequenceClip,actual:SequenceClip):SequenceClip {
 const {id:_,startFrame:__,durationFrames:___,clock:____,...fields}=structuredClone(actual);
 if(fields.visual){if(original.visual?.keyframeClock)fields.visual.keyframeClock=structuredClone(original.visual.keyframeClock);else delete fields.visual.keyframeClock;}
 return {...fields,id:original.id,startFrame:original.startFrame,durationFrames:original.durationFrames,clock:structuredClone(original.clock)};
}
/** Rebind only the ordinary edit's affected pieces. Unchanged latent parts retain
 * their old historical input and intent. No speed command calls this function. */
export function rebindSpeedTiming(before:SequenceDocument,next:SequenceDocument,old:SpeedTimingBasis,fresh:()=>string):SpeedTimingBasis|undefined {
 const t:SpeedTimingBasis={baselines:structuredClone(old.baselines),clips:[],fades:[]},history=historical(before,old),beforeLive=materializeSpeedTiming(before,old),fragments=rebuiltFragments.get(next);
 const actions=new Map<string,{kind:'keep'}|{kind:'presentation';clip:SequenceClip}|{kind:'replace'}>();
 const replacements:SpeedTimingClip[]=[];const accounted=new Set<string>();
 for(const [id,parts] of beforeLive.groups){const previous=beforeLive.clips.find(c=>c.id===id)!,record=old.clips.find(c=>c.parts.some(p=>p.renderId===parts[0]))!;
  const actual=fragments?.get(id)?.map(f=>f.clip).filter(c=>c.content.kind==='scene-fade')??next.clips.filter(c=>c.id===id&&c.content.kind==='scene-fade');for(const c of actual)accounted.add(c.id);
  let mappingUnchanged=false;
  try{const sub=sliceRecord(record,record.parts.filter(p=>parts.includes(p.renderId)),history.get(record.snapshotKey)!);const material=materializeSpeedTiming(next,{...old,clips:[sub],fades:[]});mappingUnchanged=material.clips.length===1&&material.clips[0]!.startFrame===previous.startFrame&&material.clips[0]!.durationFrames===previous.durationFrames&&same(material.clips[0]!.clock,previous.clock)&&same(material.clips[0]!.visual?.keyframeClock,previous.visual?.keyframeClock);}catch{mappingUnchanged=false;}
  const a=actual[0],sameTime=actual.length===1&&a!.id===id&&a!.startFrame===previous.startFrame&&a!.durationFrames===previous.durationFrames&&same(a!.clock,previous.clock)&&same(a!.visual?.keyframeClock,previous.visual?.keyframeClock);
  if(mappingUnchanged&&sameTime){for(const part of parts)actions.set(part,same(presentation(a!),presentation(previous))?{kind:'keep'}:{kind:'presentation',clip:a!});}
  else{for(const part of parts)actions.set(part,{kind:'replace'});for(const c of actual){const captured=captureTimingClip(next,c,t,fresh);captured.logicalId=record.logicalId;replacements.push(captured);}}
 }
 for(const record of old.clips){const baseline=history.get(record.snapshotKey)!;let run:SpeedTimingClip['parts']=[],action:ReturnType<typeof actions.get>;
  const finish=()=>{if(!run.length)return;let sub=sliceRecord(record,run,baseline);if(action?.kind==='presentation')sub={...sub,original:copyPresentation(sub.original,action.clip)};t.clips.push(sub);run=[];};
  for(const part of record.parts){const a=actions.get(part.renderId);if(a?.kind==='replace'){finish();action=undefined;continue;}
   const equivalent=(!a||a.kind==='keep')&&(!action||action.kind==='keep')||a?.kind==='presentation'&&action?.kind==='presentation'&&a.clip.id===action.clip.id;
   if(!equivalent)finish();action=a;run.push(part);
  }finish();
 }
 t.clips.push(...replacements);
 for(const c of next.clips)if(c.content.kind==='scene-fade'&&!accounted.has(c.id)&&!timingReservedIds(old).includes(c.id))t.clips.push(captureTimingClip(next,c,t,fresh));
 const p=speedProjectionForDocument(next);
 for(const tr of next.transitions)if(!tr.inClipId){const previous=old.fades.find(f=>f.original.id===tr.id),oldActual=before.transitions.find(f=>f.id===tr.id);let unchanged=false;
  if(previous&&same(oldActual,tr)){try{unchanged=value(p,previous.start)===tr.startFrame&&value(p,previous.end)===tr.startFrame+tr.durationFrames;}catch{unchanged=false;}}
  t.fades.push(unchanged?structuredClone(previous!):{snapshotKey:snapshot(next,t),original:structuredClone(tr),...region(p,tr.startFrame,tr.startFrame+tr.durationFrames,tr.outClipId)});
 }
 const referenced=new Set([...t.clips,...t.fades].map(c=>c.snapshotKey));t.baselines=t.baselines.filter(s=>referenced.has(s.key));
 // Preserve current live record order. Latent-only pieces retain relative order.
 const index=new Map(next.clips.map((c,i)=>[c.id,i]));t.clips.sort((a,b)=>(index.get(a.parts[0]!.renderId)??Infinity)-(index.get(b.parts[0]!.renderId)??Infinity));
 return t.clips.length||t.fades.length?t:undefined;
}
