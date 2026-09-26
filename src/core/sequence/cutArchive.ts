import {inheritLegacyCaptionPolicy,planLegacyCaptionContinuation} from './legacyCaptionContinuity';
import {normalizeLegacyCaptionContinuations} from './legacyCaptionContinuations';
import {SequenceError} from './errors';
import {clipEnd,isMediaContent,sourceTimeAt,type CutArchiveEntry,type CutArchiveBoundary,type SequenceDocument,type SequenceClip} from './model';
import {compareTime,isRational} from './time';
import {refreshCaptionBaselines} from './speedCaptionLedger';
import {rebindOperationBasis,upgradeNativeSpeedOperations} from './speedOperationBasis';
import {projectCutSpeed} from './cutSpeedProjection';
import {planCutInsertion} from './cutInsertionPlan';
import {legacyAudioPolicyForRestore,planLegacyAudioContinuation} from './legacyAudioContinuity';
export interface CutSlice {from:number;to:number;start:number;trackId?:string}
export interface CutFragment {original:SequenceClip;slice:CutSlice;clip:SequenceClip}
export interface CutArchiveTools {
 rebuild(document:SequenceDocument,recipes:Map<string,CutSlice[]>,shift?:(frame:number,trackId?:string)=>number,split?:boolean,trim?:boolean,structure?:{sequenceEndFrame?:number;grow?:boolean}):SequenceDocument;
 fresh(document:SequenceDocument):(prefix:string)=>string;
 validate(document:unknown):void;
}
export interface RestoreCutCommand {type:'restore-cut';entryId:string;range?:{startFrame:number;endFrame:number};atFrame?:number}
export function previewArchivedCut(document:SequenceDocument,entryId:string,range:RestoreCutCommand['range'],tools:CutArchiveTools):{durationFrames:number}{
 const planned=projectArchivedRange(document,{type:'restore-cut',entryId,...(range?{range}:{})},tools);
 return {durationFrames:planned.insertionFrames};
}
function fail(message:string):never{throw new SequenceError('INVALID_RANGE',message);}
const clean=(document:SequenceDocument)=>{const d=structuredClone(document);delete d.cutArchive;return d;};
export function archiveReservedIds(document:SequenceDocument):string[]{
 const ids=new Set<string>((document.cutArchive?.groups??[]).map(g=>g.id));for(const e of document.cutArchive?.entries??[]){ids.add(e.id);ids.add(e.origin.cutId);for(const binding of e.trackBoundaries??[]){ids.add(binding.trackId);if(binding.destinationTrackId)ids.add(binding.destinationTrackId);for(const ref of binding.boundary.references)ids.add(ref.clipId);}for(const ref of e.boundary.references)ids.add(ref.clipId);for(const t of e.tracks)ids.add(t.id);for(const c of e.clips)visitIdentities(c,(value)=>{ids.add(value);return value;});}return [...ids];
}
export function validateRestoreCutCommand(value:unknown):asserts value is RestoreCutCommand {
 if(!value||typeof value!=='object'||Array.isArray(value))fail('カット復元の要求が不正です');
 const c=value as Record<string,unknown>;
 if(c.type!=='restore-cut'||typeof c.entryId!=='string'||!c.entryId||Object.keys(c).some(k=>!['type','entryId','range','atFrame'].includes(k)))fail('カット復元の要求が不正です');
 if(c.atFrame!==undefined&&(!Number.isSafeInteger(c.atFrame)||(c.atFrame as number)<0))fail('復元先が不正です');
 if(c.range!==undefined){if(!c.range||typeof c.range!=='object'||Array.isArray(c.range))fail('復元区間が不正です');const r=c.range as Record<string,unknown>;if(Object.keys(r).some(k=>!['startFrame','endFrame'].includes(k))||!Number.isSafeInteger(r.startFrame)||!Number.isSafeInteger(r.endFrame)||(r.startFrame as number)<0||(r.endFrame as number)<=(r.startFrame as number))fail('復元区間が不正です');}
}
/** Fixed track witnesses can remain outside the AV completion after a speed edit.
 * They identify stored placement, not permission to expose old hidden content. */
function resolveTrackBoundary(document:SequenceDocument,entry:CutArchiveEntry,boundary:CutArchiveBoundary){
 return resolveCutBoundary({...document,sequenceEndFrame:Math.max(document.sequenceEndFrame,boundary.hintFrame,...document.clips.map(clipEnd))},{...entry,boundary});
}
/** A later trim can open a gap around the saved fixed position. Retain that
 * exact position only while both explicit owners still bound it; never fall
 * back from an unresolved fixed track to the main clock. */
function restorationTrackPoint(document:SequenceDocument,entry:CutArchiveEntry,boundary:CutArchiveBoundary,trackId:string){
 const exact=resolveTrackBoundary(document,entry,boundary);if(exact.frame!==null||boundary.ambiguous)return exact;
 const left:number[]=[],right:number[]=[],projectedLeft:number[]=[],projectedRight:number[]=[];
 let sameTrack=true;
 for(const ref of boundary.references){const clip=document.clips.find(c=>c.id===ref.clipId);if(!clip)return exact;
  sameTrack&&=clip.trackId===trackId;
  // Offsets project an old seam, not the edges of the currently empty gap.
  // Distant effects may move independently while still bounding the saved position.
  (ref.edge==='end'?left:right).push(ref.edge==='end'?clipEnd(clip):clip.startFrame);
  (ref.edge==='end'?projectedLeft:projectedRight).push((ref.edge==='end'?clipEnd(clip):clip.startFrame)+ref.offsetFrames);
 }
 const bounds=(a:number[],b:number[])=>a.length&&b.length&&Math.max(...a)<=boundary.hintFrame&&boundary.hintFrame<=Math.min(...b);
 if(bounds(projectedLeft,projectedRight))return {frame:boundary.hintFrame};
 if(sameTrack&&bounds(left,right)
  &&!document.clips.some(c=>c.trackId===trackId&&c.startFrame<boundary.hintFrame&&clipEnd(c)>boundary.hintFrame))return {frame:boundary.hintFrame};
 return exact;
}
/** Every surviving reference must agree. An explicit position never guesses an owner. */
export function resolveCutBoundary(document:SequenceDocument,entry:CutArchiveEntry):{frame:number|null;reason?:string}{
 const values=entry.boundary.references.flatMap(ref=>{const c=document.clips.find(c=>c.id===ref.clipId);return c?[(ref.edge==='start'?c.startFrame:clipEnd(c))+ref.offsetFrames]:[];});
 if(entry.boundary.ambiguous)return {frame:null,reason:'境界を移動・削除したため、復元位置を指定してください'};
 if(!values.length){if(entry.boundary.references.length)return {frame:null,reason:'元の境界がありません。復元位置を指定してください'};return {frame:Math.min(document.sequenceEndFrame,entry.boundary.hintFrame)};}
 const frame=values[0]!;if(values.some(v=>v!==frame)||frame<0||frame>document.sequenceEndFrame)return {frame:null,reason:'左右の境界が一致しません。復元位置を指定してください'};
 return {frame};
}
export function cutBoundaryAt(document:SequenceDocument,frame:number):CutArchiveBoundary{
 const left=document.clips.filter(c=>clipEnd(c)<=frame),right=document.clips.filter(c=>c.startFrame>=frame);
 const a=Math.max(-Infinity,...left.map(clipEnd)),b=Math.min(Infinity,...right.map(c=>c.startFrame));
 return {hintFrame:frame,ambiguous:false,references:[...left.filter(c=>clipEnd(c)===a).map(c=>({clipId:c.id,edge:'end' as const,offsetFrames:frame-a})),...right.filter(c=>c.startFrame===b).map(c=>({clipId:c.id,edge:'start' as const,offsetFrames:frame-b}))]};
}
/** Update identities while the original-to-fragment relation is still available. */
export function rebindCutArchiveFragments(before:SequenceDocument,next:SequenceDocument,fragments:Map<string,CutFragment[]>):void{
 for(const e of next.cutArchive?.entries??[]){
  for(const c of e.clips)for(const witness of c.legacyMainRole?.witnesses??[]){
   const parts=fragments.get(witness.clipId);if(!parts?.length)continue;
   const sorted=[...parts].sort((a,b)=>a.slice.from-b.slice.from);witness.clipId=(witness.edge==='start'?sorted[0]!:sorted.at(-1)!).clip.id;
   if(witness.providerId){const providers=fragments.get(witness.providerId);if(providers?.length){const order=[...providers].sort((a,b)=>a.slice.from-b.slice.from);witness.providerId=(witness.edge==='start'?order[0]!:order.at(-1)!).clip.id;}}
  }
  const old=before.cutArchive?.entries.find(a=>a.id===e.id);if(!old)continue;
  for(const [boundary,previous] of [[e.boundary,old.boundary],...(e.trackBoundaries??[]).flatMap(t=>{const b=old.trackBoundaries?.find(o=>o.trackId===t.trackId);return b?[[t.boundary,b.boundary]]:[]})] as [CutArchiveBoundary,CutArchiveBoundary][]){
   boundary.references=previous.references.flatMap(ref=>{const parts=fragments.get(ref.clipId);if(!parts)return [ref];if(!parts.length){boundary.ambiguous=true;return [];}
    const sorted=[...parts].sort((a,b)=>a.slice.from-b.slice.from);const part=ref.edge==='start'?sorted[0]!:sorted.at(-1)!;
    return [{...ref,clipId:part.clip.id}];
   });
  }
 }
}
export function shiftCutArchiveHints(next:SequenceDocument,start:number,end:number,insert=0):void{
 for(const e of next.cutArchive?.entries??[])for(const b of [e.boundary,...(e.trackBoundaries??[]).map(t=>t.boundary)]){if(b.hintFrame>start&&b.hintFrame<end)b.ambiguous=true;b.hintFrame=b.hintFrame>=end?b.hintFrame-(end-start)+insert:b.hintFrame;}
}
export function fragmentGraph(document:SequenceDocument,start:number,end:number,tools:CutArchiveTools):SequenceDocument{
 const d=clean(document),recipes=new Map<string,CutSlice[]>();
 for(const c of d.clips){const a=Math.max(start,c.startFrame),b=Math.min(end,clipEnd(c));recipes.set(c.id,a<b?[{from:a,to:b,start:a-start}]:[]);}
 // Transitions/fades that cross the cut have already been rejected by the command.
 d.transitions=[];
 let next=tools.rebuild(d,recipes,f=>f-start,false,false,d.speed?{sequenceEndFrame:end-start}:undefined);next.sequenceEndFrame=end-start;
 if(next.insertOwnSpeed)next.insertOwnSpeed.endFloor=Math.min(end-start,Math.max(0,d.insertOwnSpeed!.endFloor-start));
 if(!next.clips.some(c=>c.insertOwnSpeed))delete next.insertOwnSpeed;
 next=rebindOperationBasis(d,next);tools.validate(next);return next;
}
function entryFromGraph(id:string,graph:SequenceDocument,origin:CutArchiveEntry['origin'],at:CutArchiveBoundary,completionFloorFrames:number,sourceRecovery?:CutArchiveEntry['sourceRecovery'],legacyRecovery?:CutArchiveEntry['legacyRecovery']):CutArchiveEntry{
 return {id,durationFrames:graph.sequenceEndFrame,completionFloorFrames,origin,boundary:at,clips:graph.clips,tracks:graph.tracks,...(graph.speed?{speed:graph.speed}:{}),...(graph.insertOwnSpeed?{insertOwnSpeed:graph.insertOwnSpeed}:{}),...(sourceRecovery?{sourceRecovery:structuredClone(sourceRecovery)}:{}),...(legacyRecovery?{legacyRecovery:structuredClone(legacyRecovery)}:{})};
}
/** Establish order only from the pre-edit graph. Existing groups already carry
 * an explicit order; independent historical records at the same seam do not. */
function adjacentArchiveBands(document:SequenceDocument,start:number,end:number){
 const archive=document.cutArchive;if(!archive)return [];
 const entries=new Map(archive.entries.map(e=>[e.id,e])),grouped=new Set(archive.groups?.flatMap(g=>g.entryIds)??[]);
 const candidates=[...(archive.groups??[]).map(g=>({groupId:g.id,entryIds:g.entryIds})),
  ...archive.entries.filter(e=>!grouped.has(e.id)).map(e=>({groupId:undefined,entryIds:[e.id]}))].flatMap(band=>{
   const frames=band.entryIds.map(id=>resolveCutBoundary(document,entries.get(id)!).frame),frame=frames[0];
   return frame!==undefined&&frame!==null&&frame>=start&&frame<=end&&frames.every(f=>f===frame)?[{...band,frame}]:[];
  });
 return candidates.filter(band=>candidates.filter(other=>other.frame===band.frame).length===1).sort((a,b)=>a.frame-b.frame);
}
export function archiveRippleCut(before:SequenceDocument,next:SequenceDocument,start:number,end:number,tools:CutArchiveTools):SequenceDocument{
 const fresh=tools.fresh(before),id=fresh('cut'),bands=adjacentArchiveBands(before,start,end);
 next.cutArchive??={version:1,entries:[]};shiftCutArchiveHints(next,start,end);
 const boundary=cutBoundaryAt(next,start),ordered:string[]=[];
 let cursor=start,first=true;
 const append=(a:number,b:number)=>{
  if(a===b)return;const pieceId=first?id:fresh('cut');first=false;
  const graph=fragmentGraph(before,a,b,tools),floor=Math.min(b-a,Math.max(0,(before.insertOwnSpeed?.endFloor??before.sequenceEndFrame)-a));
  const savedEntry=entryFromGraph(pieceId,graph,{cutId:id,startFrame:a,endFrame:b},structuredClone(boundary),floor);
  savedEntry.trackBoundaries=next.tracks.map(t=>({trackId:t.id,boundary:cutBoundaryAt({...next,clips:next.clips.filter(c=>c.trackId===t.id)},start)})).filter(t=>t.boundary.references.length>0);
  next.cutArchive!.entries.push(savedEntry);ordered.push(pieceId);
 };
 // If a known archived band lies inside the new deletion, keep the two new
 // saved-frame intervals separate and interleave the older band between them.
 for(const band of bands){append(cursor,band.frame);ordered.push(...band.entryIds);cursor=band.frame;}
 append(cursor,end);
 if(bands.length){
  const consumed=new Set(bands.flatMap(b=>b.groupId?[b.groupId]:[])),groupId=bands.find(b=>b.groupId)?.groupId??fresh('cut-group');
  next.cutArchive.groups=(next.cutArchive.groups??[]).filter(g=>!consumed.has(g.id));
  next.cutArchive.groups.push({id:groupId,entryIds:ordered});
  for(const entryId of ordered){const target=next.cutArchive.entries.find(e=>e.id===entryId)!;target.boundary=structuredClone(boundary);
   const old=before.cutArchive?.entries.find(e=>e.id===entryId);if(old)target.trackBoundaries=(old.trackBoundaries??before.tracks.map(t=>({trackId:t.id,destinationTrackId:undefined,boundary:old.boundary}))).flatMap(binding=>{
    const destination=binding.destinationTrackId??binding.trackId,point=resolveTrackBoundary(before,old,binding.boundary).frame;
    if(point===null)return [binding];
    const mapped=point<=start?point:point>=end?point-(end-start):start;
    return [{...binding,boundary:cutBoundaryAt({...next,clips:next.clips.filter(c=>c.trackId===destination)},mapped)}];
   });
  }
 }
 return next;
}
export function readArchivedCutGraph(document:SequenceDocument,entry:CutArchiveEntry):SequenceDocument{return {...clean(document),clips:structuredClone(entry.clips),tracks:structuredClone(entry.tracks),transitions:[],sequenceEndFrame:entry.durationFrames,speed:structuredClone(entry.speed),insertOwnSpeed:structuredClone(entry.insertOwnSpeed)};}
const refKeys=new Set(['id','clipId','providerId','evaluationOwnerId','clipOccurrenceId','linkGroupId','continuationGroupId','captionId','partId','reservedRenderId','renderId','ownerClipId']);
function visitIdentities(v:unknown,map:(id:string)=>string,key=''):unknown{
 if(['content','visual','name','legacyCaptionContinuity'].includes(key))return v;
 if(typeof v==='string'&&(refKeys.has(key)||key==='order'))return map(v);
 if(Array.isArray(v))return v.map(x=>visitIdentities(x,map,key));
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visitIdentities(x,map,k)]));return v;
}
/** Only explicit identity slots are remapped; text, filenames and asset identities are untouched. */
function remapGraph(graph:SequenceDocument,fresh:(prefix:string)=>string,current:SequenceDocument,preserveSourceLineage=false,restoredOrigins=new Map<string,string[]>()):SequenceDocument{
 inheritLegacyCaptionPolicy(graph,current);
 const ids=new Map<string,string>();
 const legacyWitnesses=graph.clips.map(c=>structuredClone(c.legacyMainRole?.witnesses));
 const legacyAudio=graph.clips.map(c=>structuredClone(legacyAudioPolicyForRestore(current,c)));
 const legacyCaption=graph.clips.map(c=>structuredClone(c.legacyCaptionContinuity));
 const sourceLineage=graph.clips.map(c=>preserveSourceLineage?c.continuationGroupId:undefined);
 graph.clips.forEach(c=>visitIdentities(c,value=>{if(!ids.has(value))ids.set(value,fresh('restored'));return value;}));
 for(const c of graph.clips)for(const origin of new Set([c.id,c.continuationGroupId].filter((id):id is string=>!!id))){const restored=ids.get(c.id)!;restoredOrigins.set(origin,[...(restoredOrigins.get(origin)??[]),restored]);}
 graph.clips=graph.clips.map(c=>visitIdentities(c,value=>ids.get(value)??value) as SequenceClip);
 // Raw-source recovery is another piece of an explicitly declared original usage.
 // Allocate new clip/link identities, but retain that usage so restored samples
 // cannot be proposed again as missing source, including after save/reload.
 graph.clips.forEach((c,index)=>{if(legacyCaption[index])c.legacyCaptionContinuity=legacyCaption[index];if(c.legacyMainRole&&legacyWitnesses[index])c.legacyMainRole.witnesses=legacyWitnesses[index]!;if(sourceLineage[index])c.continuationGroupId=sourceLineage[index];if(legacyAudio[index]){c.legacyAudioContinuity=legacyAudio[index];c.continuationGroupId=legacyAudio[index]!.ownerClipId;}});
 const tracks=new Map<string,string>();for(const t of graph.tracks){const existing=current.tracks.find(x=>x.id===t.id);if(existing&&existing.kind!==t.kind)tracks.set(t.id,fresh('restored-track'));}
 for(const t of graph.tracks)t.id=tracks.get(t.id)??t.id;for(const c of graph.clips)c.trackId=tracks.get(c.trackId)??c.trackId;
 return graph;
}
/** Concatenate two valid metadata graphs before using the existing topology slicer.
 * The temporary tail is never committed or rendered. */
function concatenate(current:SequenceDocument,saved:SequenceDocument,tools:CutArchiveTools,preserveSourceLineage=false):{document:SequenceDocument;offset:number;restored:Set<string>;restoredOrigins:Map<string,string[]>}{
 const offset=Math.max(current.sequenceEndFrame,...current.clips.map(clipEnd)),fresh=tools.fresh(current);
 const restoredOrigins=new Map<string,string[]>();
 let a=clean(current),b=remapGraph(saved,fresh,current,preserveSourceLineage,restoredOrigins);
 if(!!a.speed!==!!b.speed)fail('カット後に速度登録が変わっています。速度基準を揃えてから復元してください');
 if(a.speed&&b.speed){
  if(compareTime(a.speed.globalRate,b.speed.globalRate)!==0||compareTime(a.speed.fpsBasis,b.speed.fpsBasis)!==0)fail('カット時と現在の速度基準が異なります。復元する区間の速度を確認してください');
  a=tools.rebuild(a,new Map(),f=>f,false,false,{sequenceEndFrame:a.sequenceEndFrame});b=tools.rebuild(b,new Map(),f=>f,false,false,{sequenceEndFrame:b.sequenceEndFrame});
 }
 const restored=new Set(b.clips.map(c=>c.id));
 for(const c of b.clips){c.startFrame+=offset;if(c.speed?.kind==='independent-audio')c.speed.placement.startFrame+=offset;if(c.insertOwnSpeed)c.insertOwnSpeed.placement.startFrame+=offset;}
 const tracks=[...a.tracks];
 for(const [index,t] of b.tracks.entries())if(b.clips.some(c=>c.trackId===t.id)&&!tracks.some(x=>x.id===t.id)){
  const after=b.tracks.slice(index+1).find(t=>tracks.some(x=>x.id===t.id));
  tracks.splice(after?tracks.findIndex(x=>x.id===after.id):tracks.length,0,t);
 }
 const next={...a,clips:[...a.clips,...b.clips],sequenceEndFrame:offset+b.sequenceEndFrame,tracks};
 if(!next.insertOwnSpeed&&b.insertOwnSpeed)next.insertOwnSpeed=structuredClone(b.insertOwnSpeed);
 if(next.speed){
  let order=0,lastEnd=0;
  for(const c of next.clips.filter(c=>c.speed?.kind==='main').sort((a,b)=>a.startFrame-b.startFrame)){
   const s=c.speed!;if(s.kind!=='main')continue;s.groupId=next.speed.groupId;s.order=order++;
   if(s.structuralPlacement)s.structuralPlacement.gapFrames=c.startFrame-lastEnd+(next.transitions.find(t=>t.inClipId===c.id)?.durationFrames??0);
   lastEnd=clipEnd(c);
  }
  next.speed.sequenceEndBasis=order?{kind:'main-offset',offsetFrames:next.sequenceEndFrame-lastEnd}:{kind:'empty-fixed',offsetFrames:0,endFrame:next.sequenceEndFrame};
  for(const c of next.clips)if(c.speed)delete c.speed.operationBasis;
  refreshCaptionBaselines(next);
 }
 if(next.insertOwnSpeed)next.insertOwnSpeed.endFloor=next.sequenceEndFrame;
 const rebound=rebindOperationBasis(current,next);tools.validate(rebound);return {document:rebound,offset,restored,restoredOrigins};
}
/** Restore allocates fresh identities. Rebind a saved legacy role witness only
 * to its own restored fragment at the same proven seam and original endpoint. */
function rebindRestoredLegacyWitnesses(next:SequenceDocument,origins:Map<string,string[]>):void {
 for(const entry of next.cutArchive?.entries??[]){
  if(!entry.legacyRecovery||entry.legacyRecovery.sourceFingerprint!==next.legacy?.sourceFingerprint)continue;
  const seam=resolveCutBoundary(next,entry).frame;if(seam===null)continue;
  for(const saved of entry.clips){const proof=saved.legacyMainRole;if(!proof||proof.sourceFingerprint!==entry.legacyRecovery.sourceFingerprint)continue;
   const replacements=new Map<string,SequenceClip>();
   for(const w of proof.witnesses){
    const ids=origins.get(w.clipId);if(!ids)continue;
    const matches=next.clips.filter(c=>ids.includes(c.id)&&isMediaContent(c.content)
     &&c.content.kind===(w.kind==='main'?'video':'audio')&&c.content.assetId===w.assetId&&c.content.streamIndex===w.streamIndex
     &&compareTime(c.content.rate,w.rate)===0
     &&(w.edge==='start'?c.startFrame:clipEnd(c))===seam
     &&entry.boundary.references.some(ref=>ref.clipId===c.id&&ref.edge===w.edge&&ref.offsetFrames===0)
     &&compareTime(sourceTimeAt(c,w.edge==='start'?c.startFrame:clipEnd(c),next.fps),w.sourceTime)===0);
    if(matches.length===1)replacements.set(w.clipId,matches[0]!);
   }
   proof.witnesses=proof.witnesses.map(w=>{
    const c=replacements.get(w.clipId);if(!c)return w;
    if(w.kind==='main-audio'){
     const provider=replacements.get(w.providerId!)??next.clips.find(c=>c.id===w.providerId);
     if(!provider?.linkGroupId||provider.linkGroupId!==c.linkGroupId)return w;
     return {...w,clipId:c.id,providerId:provider.id};
    }
    return {...w,clipId:c.id};
   });
  }
 }
}
function projectArchivedRange(document:SequenceDocument,command:RestoreCutCommand,tools:CutArchiveTools){
 validateRestoreCutCommand(command);
 const entry=document.cutArchive?.entries.find(e=>e.id===command.entryId);if(!entry)throw new SequenceError('MISSING_TARGET','復元するカットが見つかりません',[command.entryId]);
 const start=command.range?.startFrame??0,end=command.range?.endFrame??entry.durationFrames;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end>entry.durationFrames||start>=end)fail('復元する区間がカットの範囲外です');
 const graph=readArchivedCutGraph(document,entry),saved=fragmentGraph(graph,start,end,tools);
 const projected=projectCutSpeed(document,saved,Math.min(end-start,Math.max(0,entry.completionFloorFrames-start)));
 tools.validate(projected.document);
 if(projected.insertionFrames<=0)fail('現在の速度では選択したカット帯が1フレーム未満になります。復元区間を広げてください');
 return {entry,start,end,graph,part:projected.document,completionFloorFrames:projected.completionFloorFrames,insertionFrames:projected.insertionFrames};
}
export function restoreArchivedCut(document:SequenceDocument,command:RestoreCutCommand,tools:CutArchiveTools):SequenceDocument{
 // Separate legacy render IDs from their proven continuation identity while the
 // original completed-clock relationship still exists, before insertion moves it.
 if(document.cutArchive?.entries.find(e=>e.id===command.entryId)?.legacyRecovery){
  document=structuredClone(document);
  inheritLegacyCaptionPolicy(document,document);
  normalizeLegacyCaptionContinuations(document,new Set(document.clips.filter(c=>c.content.kind==='telop').map(c=>c.id)));
 }
 // Imported historic bands can already carry the current speed schema while
 // live registration has never needed an upgrade. Upgrade on restoration, not
 // during history import, so adding history keeps every live field untouched.
 if(document.speed?.version===1&&document.cutArchive?.entries.find(e=>e.id===command.entryId)?.speed?.version===2)
  document=upgradeNativeSpeedOperations(document);
 const {entry,start,end,graph,part,completionFloorFrames,insertionFrames}=projectArchivedRange(document,command,tools);
 const resolved=resolveCutBoundary(document,entry),at=command.atFrame??resolved.frame;
 if(at===null)fail(resolved.reason!);if(!Number.isSafeInteger(at)||at<0||at>document.sequenceEndFrame)fail('復元先がシーケンスの範囲外です');
 if(document.transitions.some(t=>t.startFrame<at&&at<t.startFrame+t.durationFrames)||document.clips.some(c=>c.content.kind==='scene-fade'&&c.startFrame<at&&at<clipEnd(c)))fail('転換の途中へは復元できません。別の復元位置を指定してください');
 const joined=concatenate(document,part,tools,!!entry.sourceRecovery),recipes=new Map<string,CutSlice[]>(),amount=insertionFrames;
 joined.document.cutArchive=structuredClone(document.cutArchive);
 const relatedEntries=document.cutArchive!.groups?.find(g=>g.entryIds.includes(entry.id))?.entryIds.map(id=>document.cutArchive!.entries.find(e=>e.id===id)!)??[entry];
 const destinationFor=(track:string)=>{const choices=[...new Set(relatedEntries.flatMap(e=>e.trackBoundaries??[]).filter(t=>t.trackId===track&&t.destinationTrackId).map(t=>t.destinationTrackId!))];return choices.length===1?choices[0]:undefined;};
 const placement=planCutInsertion(document,joined.document,joined.restored,joined.offset,at,amount,tools.fresh(joined.document),track=>{
  const saved=command.atFrame===undefined?entry.trackBoundaries?.find(t=>(t.destinationTrackId??t.trackId)===track):undefined;if(!saved)return at;
  const point=restorationTrackPoint(document,entry,saved.boundary,track);if(point.frame===null)fail('固定素材の復元境界を確認してください: '+point.reason);return point.frame;
 },track=>at===resolved.frame?destinationFor(track):undefined);
 const continueCaption=entry.legacyRecovery?planLegacyCaptionContinuation(document,joined.document,joined.restored):undefined;
 const continueAudio=entry.legacyRecovery?planLegacyAudioContinuation(document,entry.id,joined.document,joined.restored,joined.offset,track=>placement.insertionPoint(track)):undefined;
 for(const c of joined.document.clips){if(joined.restored.has(c.id)){recipes.set(c.id,[{from:c.startFrame,to:clipEnd(c),start:c.startFrame-joined.offset+placement.insertionPoint(c.trackId)}]);continue;}
  const point=placement.points.get(c.trackId)!,visibleEnd=Math.min(clipEnd(c),document.sequenceEndFrame),pieces:CutSlice[]=[];
  if(c.startFrame<Math.min(point,visibleEnd))pieces.push({from:c.startFrame,to:Math.min(point,visibleEnd),start:c.startFrame});
  if(visibleEnd>Math.max(c.startFrame,point))pieces.push({from:Math.max(c.startFrame,point),to:visibleEnd,start:Math.max(c.startFrame,point)+placement.shifts.get(c.trackId)!});
  if(clipEnd(c)>document.sequenceEndFrame){const from=Math.max(c.startFrame,document.sequenceEndFrame);
   if(point>from&&point<clipEnd(c)){pieces.push({from,to:point,start:placement.mapFrame(from,c.trackId)},{from:point,to:clipEnd(c),start:placement.mapFrame(point,c.trackId)});}
   else pieces.push({from,to:clipEnd(c),start:placement.mapFrame(from,c.trackId)});
  }
  const merged:CutSlice[]=[];for(const piece of pieces){const prior=merged.at(-1);if(prior&&prior.to===piece.from&&prior.start+prior.to-prior.from===piece.start)prior.to=piece.to;else merged.push(piece);}
  recipes.set(c.id,merged);
 }
 let next=tools.rebuild(joined.document,recipes,(f,trackId)=>trackId?placement.mapFrame(f,trackId):f>=at?f+amount:f,false,false,document.speed?{sequenceEndFrame:placement.sequenceEndFrame}:undefined);next.sequenceEndFrame=placement.sequenceEndFrame;
 if(next.insertOwnSpeed){
  next.insertOwnSpeed.endFloor=Math.max(placement.endFloor,completionFloorFrames>0?at+completionFloorFrames:placement.endFloor);
 }
 continueAudio?.(next);
 continueCaption?.(next);
 next.cutArchive!.entries=next.cutArchive!.entries.filter(e=>e.id!==entry.id);shiftCutArchiveHints(next,at,at,amount);
 const trackBoundaryAt=(trackId:string,frame:number)=>cutBoundaryAt({...next,clips:next.clips.filter(c=>c.trackId===trackId)},frame);
 const remnantTracks=(right:boolean)=>{
  const targets=new Map(joined.document.tracks.map(t=>[t.id,t.id]));
  for(const [source,destination] of placement.destinations){targets.delete(destination);targets.set(source,destination);}
  return [...targets].map(([trackId,destination])=>{
   const restoredEnd=Math.max(amount,...joined.document.clips.filter(c=>joined.restored.has(c.id)&&c.trackId===destination).map(c=>clipEnd(c)-joined.offset));
   return {trackId,...(destination!==trackId?{destinationTrackId:destination}:{}),boundary:trackBoundaryAt(destination,placement.insertionPoint(destination)+(right?restoredEnd:0))};
  });
 };
 // Surviving current pieces may have been split by insertion; update their boundary IDs.
 const fresh=tools.fresh({...next,cutArchive:document.cutArchive});
 if(start>0)next.cutArchive!.entries.push(entryFromGraph(entry.id,fragmentGraph(graph,0,start,tools),{...entry.origin,endFrame:entry.origin.startFrame+start},cutBoundaryAt(next,at),Math.min(start,entry.completionFloorFrames),entry.sourceRecovery,entry.legacyRecovery));
 if(end<entry.durationFrames)next.cutArchive!.entries.push(entryFromGraph(start>0?fresh('cut'):entry.id,fragmentGraph(graph,end,entry.durationFrames,tools),{...entry.origin,startFrame:entry.origin.startFrame+end},cutBoundaryAt(next,at+amount),Math.max(0,entry.completionFloorFrames-end),entry.sourceRecovery,entry.legacyRecovery));
 for(const saved of next.cutArchive!.entries){if(saved.origin.cutId===entry.origin.cutId&&saved.origin.startFrame>=entry.origin.startFrame&&saved.origin.endFrame<=entry.origin.endFrame)saved.trackBoundaries=remnantTracks(saved.origin.startFrame>=entry.origin.startFrame+end);}
 // A restored interior opens a live gap, so it splits the ordered deleted band.
 // Other members follow only when their old boundary was exactly this insertion.
 const group=document.cutArchive?.groups?.find(g=>g.entryIds.includes(entry.id));
 if(group){
  const index=group.entryIds.indexOf(entry.id),remaining=next.cutArchive!.entries.filter(e=>e.origin.cutId===entry.origin.cutId&&e.origin.startFrame>=entry.origin.startFrame&&e.origin.endFrame<=entry.origin.endFrame);
  const left=start>0?remaining.find(e=>e.origin.startFrame===entry.origin.startFrame)?.id:undefined;
  const right=end<entry.durationFrames?remaining.find(e=>e.origin.endFrame===entry.origin.endFrame)?.id:undefined;
  const halves=[group.entryIds.slice(0,index).concat(left?[left]:[]),(right?[right]:[]).concat(group.entryIds.slice(index+1))].filter(ids=>ids.length);
  next.cutArchive!.groups=(next.cutArchive!.groups??[]).filter(g=>g.id!==group.id);
  const wasAdjacent=group.entryIds.every(id=>{const e=document.cutArchive!.entries.find(e=>e.id===id)!;return resolveCutBoundary(document,e).frame===at;});
  for(const [i,ids] of halves.entries()){
   next.cutArchive!.groups.push({id:i===0?group.id:fresh('cut-group'),entryIds:ids});
   if(wasAdjacent)for(const id of ids){const e=next.cutArchive!.entries.find(e=>e.id===id)!;const isLeft=group.entryIds.indexOf(id)<index&&group.entryIds.includes(id)||id===left;e.boundary=cutBoundaryAt(next,isLeft?at:at+amount);e.trackBoundaries=remnantTracks(!isLeft);}
  }
  if(!next.cutArchive!.groups.length)delete next.cutArchive!.groups;
 }
 // Other bands with a uniquely known pre-insertion seam retain that seam on
 // the main clock. Fixed-track exposure may shift a witness farther; keep its
 // identity and record the exact new offset rather than breaking agreement.
 for(const savedEntry of next.cutArchive!.entries){
  if(savedEntry.id===entry.id)continue;
  const old=document.cutArchive!.entries.find(e=>e.id===savedEntry.id);if(!old)continue;
  const oldFrame=resolveCutBoundary(document,old).frame;if(oldFrame===null||oldFrame===at)continue;
  const target=oldFrame<at?oldFrame:oldFrame+amount;
  if(target<0||target>next.sequenceEndFrame||savedEntry.boundary.references.some(ref=>!next.clips.some(c=>c.id===ref.clipId)))continue;
  savedEntry.trackBoundaries=(old.trackBoundaries??joined.document.tracks.map(t=>({trackId:t.id,destinationTrackId:undefined,boundary:old.boundary}))).flatMap(binding=>{
   const destination=binding.destinationTrackId??binding.trackId;
   // Use the same admitted seam as restoration, including a stored point
   // still bounded by both explicit owners after a trim/move. Unproven hints
   // remain unresolved; a known gap must move with its live frame mapping.
   const known=restorationTrackPoint(document,old,binding.boundary,destination).frame;if(known===null||!placement.points.has(destination))return [binding];
   const mapped=placement.mapFrame(known,destination);
   return [{...binding,boundary:trackBoundaryAt(destination,mapped)}];
  });
  savedEntry.boundary.hintFrame=target;
  savedEntry.boundary.references=savedEntry.boundary.references.map(ref=>{const c=next.clips.find(c=>c.id===ref.clipId)!;return {...ref,offsetFrames:target-(ref.edge==='start'?c.startFrame:clipEnd(c))};});
 }
 if(!entry.legacyRecovery&&!entry.sourceRecovery&&at===resolved.frame)rebindRestoredLegacyWitnesses(next,joined.restoredOrigins);
 if(!next.cutArchive!.entries.length)delete next.cutArchive;
 return next;
}
/** Closed saved shape; validate clip/source/speed metadata through the real graph validator. */
export function validateCutArchive(document:SequenceDocument,validate:(document:unknown)=>void):void{
 const archive=document.cutArchive;if(archive===undefined)return;
 const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v),id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v),integer=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
 if(!record(archive)||archive.version!==1||Object.keys(archive).some(k=>!['version','entries','groups'].includes(k))||!Array.isArray(archive.entries)||archive.entries.length>10000)fail('カット復元記録の形式が不正です');
 if(new TextEncoder().encode(JSON.stringify(archive)).byteLength>8*1024*1024)fail('カット復元記録が8MBを超えます。案件を分けて編集してください');
 const ids=new Set<string>();for(const e of archive.entries){
  if(!record(e)||Object.keys(e).some(k=>!['id','durationFrames','completionFloorFrames','origin','boundary','clips','tracks','speed','insertOwnSpeed','sourceRecovery','legacyRecovery','trackBoundaries'].includes(k))||!id(e.id)||ids.has(e.id)||!integer(e.durationFrames)||e.durationFrames===0||!integer(e.completionFloorFrames)||e.completionFloorFrames>e.durationFrames||!Array.isArray(e.clips)||!Array.isArray(e.tracks))fail('カット復元帯の形式が不正です');ids.add(e.id);
  if(e.legacyRecovery!==undefined){
   const p=e.legacyRecovery;
   if(!record(p)||Object.keys(p).some(k=>!['version','sourceFingerprint','originalStart','originalEnd','fps','mainRate'].includes(k))||p.version!==1
     ||typeof p.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(p.sourceFingerprint)||!integer(p.originalStart)||!integer(p.originalEnd)||(p.originalEnd as number)<=(p.originalStart as number)
     ||!isRational(p.fps)||p.fps.num<=0||!isRational(p.mainRate)||p.mainRate.num<=0||e.sourceRecovery!==undefined)fail('旧カットの出典が不正です');
  }
  if(e.sourceRecovery!==undefined){
   const p=e.sourceRecovery;
   if(!record(p)||Object.keys(p).some(k=>!['version','documentId','revision','ownerClipIds','sources'].includes(k))||p.version!==1||!id(p.documentId)||!integer(p.revision)
     ||!Array.isArray(p.ownerClipIds)||!p.ownerClipIds.length||p.ownerClipIds.some(v=>!id(v))||new Set(p.ownerClipIds).size!==p.ownerClipIds.length
     ||!Array.isArray(p.sources)||p.sources.length!==p.ownerClipIds.length)fail('元映像の補完記録が不正です');
   for(const s of p.sources){
    if(!record(s)||Object.keys(s).some(k=>!['assetId','streamIndex','start','end'].includes(k))||!id(s.assetId)||!integer(s.streamIndex)||!isRational(s.start)||!isRational(s.end)||s.start.num<0||compareTime(s.start,s.end)>=0)fail('元映像の補完範囲が不正です');
    const asset=document.assets.find(a=>a.id===s.assetId),stream=asset?.streams.find(stream=>stream.index===s.streamIndex);
    if(asset?.kind!=='media'||!stream||!['video','audio'].includes(stream.kind)||compareTime(s.end,stream.duration)>0)fail('補完元の映像・原音がありません');
   }
  }
  if(!record(e.origin)||Object.keys(e.origin).some(k=>!['cutId','startFrame','endFrame'].includes(k))||!id(e.origin.cutId)||!integer(e.origin.startFrame)||!integer(e.origin.endFrame)||e.origin.endFrame-e.origin.startFrame!==e.durationFrames)fail('カット復元帯の元区間が不正です');
  if(e.trackBoundaries!==undefined&&(!Array.isArray(e.trackBoundaries)||e.trackBoundaries.length>10000||e.trackBoundaries.some(t=>!record(t)||!id(t.trackId)||(t.destinationTrackId!==undefined&&!id(t.destinationTrackId))||Object.keys(t).some(k=>!['trackId','destinationTrackId','boundary'].includes(k)))||new Set(e.trackBoundaries.map(t=>t.trackId)).size!==e.trackBoundaries.length))fail('トラック別カット境界が不正です');
  for(const b of [e.boundary,...(e.trackBoundaries??[]).map(t=>t.boundary)]){
   if(!record(b)||Object.keys(b).some(k=>!['hintFrame','ambiguous','references'].includes(k))||!integer(b.hintFrame)||typeof b.ambiguous!=='boolean'||!Array.isArray(b.references)||b.references.some(ref=>!record(ref)||Object.keys(ref).some(k=>!['clipId','edge','offsetFrames'].includes(k))||!id(ref.clipId)||!['start','end'].includes(ref.edge)||!Number.isSafeInteger(ref.offsetFrames)))fail('カット復元境界が不正です');
  }
  if(e.clips.some(c=>!record(c)||!integer(c.startFrame)||!integer(c.durationFrames)||clipEnd(c)>e.durationFrames))fail('カット復元片が帯の外にあります');
  // Validation is read-only: reuse common assets/transcripts instead of cloning
  // the entire document (including every other archived band) for each entry.
  validate({...document,cutArchive:undefined,clips:e.clips,tracks:e.tracks,transitions:[],sequenceEndFrame:e.durationFrames,speed:e.speed,insertOwnSpeed:e.insertOwnSpeed});
 }
 if(archive.groups!==undefined){
  if(!Array.isArray(archive.groups)||archive.groups.length>10000)fail('カット帯グループの形式が不正です');
  const groupIds=new Set<string>(),members=new Set<string>();
  const reserved=new Set([...archiveReservedIds({...document,cutArchive:{...archive,groups:undefined}}),...document.clips.flatMap(c=>[c.id,c.linkGroupId,c.continuationGroupId]),...document.tracks.map(t=>t.id),...document.assets.map(a=>a.id),...document.transitions.map(t=>t.id)]);
  for(const g of archive.groups){
   if(!record(g)||Object.keys(g).some(k=>!['id','entryIds'].includes(k))||!id(g.id)||groupIds.has(g.id)||reserved.has(g.id)||!Array.isArray(g.entryIds)||!g.entryIds.length)fail('カット帯グループの形式が不正です');
   groupIds.add(g.id);for(const member of g.entryIds){if(!id(member)||!ids.has(member)||members.has(member))fail('カット帯グループの参照が不正です');members.add(member);}
  }
 }
}
