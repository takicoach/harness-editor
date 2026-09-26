import {SequenceError} from './errors';
import {clipEnd,type SequenceDocument} from './model';
import {cutBoundaryAt,readArchivedCutGraph,resolveCutBoundary} from './cutArchive';
import type {SequenceCommand} from './commands';

export type CutBoundarySelection={kind:'entry'|'group';id:string};
export type CutBoundaryTarget={kind:'archived';entryId:string;localFrame:number}|{kind:'live';clipId:string;frame:number};
export interface ResizeCutBoundaryCommand {type:'resize-cut-boundary';cut:CutBoundarySelection;edge:'start'|'end';target:CutBoundaryTarget}
function fail(message:string):never{throw new SequenceError('INVALID_RANGE',message);}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0;
export function validateResizeCutBoundaryCommand(value:unknown):asserts value is ResizeCutBoundaryCommand {
 if(!record(value)||value.type!=='resize-cut-boundary'||Object.keys(value).some(k=>!['type','cut','edge','target'].includes(k))||!['start','end'].includes(String(value.edge)))fail('カット境界の要求が不正です');
 const c=value.cut,t=value.target;
 if(!record(c)||!['entry','group'].includes(String(c.kind))||!id(c.id)||Object.keys(c).some(k=>!['kind','id'].includes(k)))fail('カット境界の対象が不正です');
 if(!record(t))fail('カット境界の座標が不正です');
 if(t.kind==='archived'){if(!id(t.entryId)||!integer(t.localFrame)||Object.keys(t).some(k=>!['kind','entryId','localFrame'].includes(k)))fail('保存帯の座標が不正です');}
 else if(t.kind==='live'){if(!id(t.clipId)||!integer(t.frame)||Object.keys(t).some(k=>!['kind','clipId','frame'].includes(k)))fail('生存片の座標が不正です');}
 else fail('カット境界の座標種別が不正です');
}

/** An entry inside a group selects that whole ordered group. Returned graphs are
 * isolated saved intent, not an inferred full-source timeline or a current-rate preview. */
export function readCutBoundaryGroup(document:SequenceDocument,selection:CutBoundarySelection){
 const archive=document.cutArchive;
 const group=selection.kind==='group'?archive?.groups?.find(g=>g.id===selection.id):archive?.groups?.find(g=>g.entryIds.includes(selection.id));
 if(selection.kind==='group'&&!group)fail('カット帯グループが見つかりません');
 const ids=group?.entryIds??[selection.id];
 const entries=ids.map(id=>{const e=archive?.entries.find(e=>e.id===id);if(!e)fail('カット帯が見つかりません');return e;});
 const resolved=entries.map(e=>resolveCutBoundary(document,e));
 const frame=resolved[0]!.frame;
 const aligned=frame!==null&&resolved.every(b=>b.frame===frame);
 return {cut:group?{kind:'group' as const,id:group.id}:{kind:'entry' as const,id:selection.id},entryIds:[...ids],frame:aligned?frame:null,
  reason:aligned?undefined:resolved.find(b=>b.reason)?.reason??'カット帯の境界が一致しません。元の位置を確認してください',
  adjacentLive:{start:aligned?document.clips.filter(c=>clipEnd(c)===frame).map(c=>c.id):[],end:aligned?document.clips.filter(c=>c.startFrame===frame).map(c=>c.id):[]},
  entries:entries.map(e=>({entry:structuredClone(e),graph:readArchivedCutGraph(document,e),owners:e.clips.flatMap(c=>c.content.kind==='audio'||c.content.kind==='video'?[{
   clipId:c.id,trackId:c.trackId,kind:c.content.kind,assetId:c.content.assetId,streamIndex:c.content.streamIndex,
   startFrame:c.startFrame,durationFrames:c.durationFrames,sourceIn:structuredClone(c.content.sourceIn),rate:structuredClone(c.content.rate),
   ...(c.linkGroupId?{linkGroupId:c.linkGroupId}:{}),...(c.speed?{speed:structuredClone(c.speed)}:{})
  }]:[])}))};
}

/** Internal subcommands are pure and committed as a single outer command. No
 * explicit restore position can authorize deleting a different live occurrence. */
export function resizeCutBoundary(document:SequenceDocument,command:ResizeCutBoundaryCommand,apply:(d:SequenceDocument,c:SequenceCommand)=>SequenceDocument,fresh:(d:SequenceDocument)=>(prefix:string)=>string):SequenceDocument {
 validateResizeCutBoundaryCommand(command);
 const selection=readCutBoundaryGroup(document,command.cut),at=selection.frame;
 if(at===null)fail(selection.reason!);
 const target=command.target;
 if(target.kind==='archived'){
  const index=selection.entryIds.indexOf(target.entryId);if(index<0)fail('選択した保存帯はこのカットに属していません');
  const member=selection.entries[index]!.entry;if(target.localFrame>member.durationFrames)fail('保存帯の座標が範囲外です');
  const ordered=command.edge==='start'?selection.entries.slice(0,index+1):selection.entries.slice(index).reverse();
  let next=document;
  for(const {entry} of ordered){
   const start=entry.id===target.entryId&&command.edge==='end'?target.localFrame:0;
   const end=entry.id===target.entryId&&command.edge==='start'?target.localFrame:entry.durationFrames;
   if(start===end)continue;
   next=apply(next,{type:'restore-cut',entryId:entry.id,range:{startFrame:start,endFrame:end}});
  }
  return next;
 }
 const clip=document.clips.find(c=>c.id===target.clipId);if(!clip)fail('境界の生存片が見つかりません');
 const left=command.edge==='start';
 if((left?clipEnd(clip)!==at:clip.startFrame!==at)||target.frame<clip.startFrame||target.frame>clipEnd(clip)||(left?target.frame>at:target.frame<at))fail('対象はカット境界に接する生存片ではありません');
 if(target.frame===at)return document;
 const start=left?target.frame:at,end=left?at:target.frame;
 // Separate historical cuts at the same seam have no known relative order.
 for(const entry of document.cutArchive!.entries)if(!selection.entryIds.includes(entry.id)){
  const b=resolveCutBoundary(document,entry).frame;
  if(b!==null&&b>=start&&b<=end)fail('別のカット帯と重なります。先にその区間の位置を確認してください');
 }
 let next=apply(document,{type:'ripple-delete',startFrame:start,endFrame:end});
 const oldIds=new Set(document.cutArchive!.entries.map(e=>e.id));
 const added=next.cutArchive!.entries.filter(e=>!oldIds.has(e.id));if(added.length!==1)fail('追加カットの記録を確認できません');
 next=structuredClone(next);
 const groupId=selection.cut.kind==='group'?selection.cut.id:next.cutArchive!.groups?.find(g=>g.entryIds.includes(selection.entryIds[0]!))?.id??fresh(next)('cut-group');
 const entryIds=left?[added[0]!.id,...selection.entryIds]:[...selection.entryIds,added[0]!.id];
 next.cutArchive!.groups=(next.cutArchive!.groups??[]).filter(g=>g.id!==groupId);
 next.cutArchive!.groups.push({id:groupId,entryIds});
 // This relocation is known from the checked adjacent deletion, unlike a guess
 // after a move/reorder. Other archives retain their normal ambiguity guards.
 for(const id of entryIds)next.cutArchive!.entries.find(e=>e.id===id)!.boundary=cutBoundaryAt(next,start);
 return next;
}

export type CutBoundaryGroup=ReturnType<typeof readCutBoundaryGroup>;
