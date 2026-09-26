import {clipEnd,type SequenceDocument} from './model';
import {SequenceError} from './errors';
import {captionLedgers} from './speedCaptionLedger';

/** A transient placement plan. The caller owns joined and will rebuild every
 * fragment once, so no live document or saved payload is mutated here. */
export function planCutInsertion(current:SequenceDocument,joined:SequenceDocument,restored:ReadonlySet<string>,offset:number,at:number,amount:number,fresh:(prefix:string)=>string,trackAt:(trackId:string)=>number=()=>at,destinationFor:(trackId:string)=>string|undefined=()=>undefined){
 const destinations=new Map<string,string>();
 for(const track of joined.tracks){const destination=destinationFor(track.id);if(destination&&joined.tracks.some(t=>t.id===destination))destinations.set(track.id,destination);}
 for(const c of joined.clips)if(restored.has(c.id))c.trackId=destinations.get(c.trackId)??c.trackId;
 const shifts=new Map(joined.tracks.map(t=>[t.id,amount]));
 const parents=new Map(joined.tracks.map(t=>[t.id,t.id]));
 const root=(id:string):string=>{const parent=parents.get(id)!;return parent===id?id:root(parent);};
 const union=(a:string,b:string)=>{parents.set(root(a),root(b));};
 // Moving one side of a linked use or a source-following caption independently
 // would alter its timing. Track insertion space is shared by that component.
 const links=new Map<string,string>();
 for(const c of joined.clips){if(c.linkGroupId){const track=links.get(c.linkGroupId);if(track)union(track,c.trackId);else links.set(c.linkGroupId,c.trackId);}
  if(c.anchor?.kind==='source'){const providerId=c.anchor.clipOccurrenceId;const provider=joined.clips.find(p=>p.id===providerId);if(provider)union(c.trackId,provider.trackId);}}
 const captionIds=new Set(captionLedgers(joined).flatMap(l=>l.parts.map(p=>p.reservedRenderId)));
 const protectedRoots=new Set(joined.clips.filter(c=>c.speed?.kind==='main'||c.speed?.kind==='main-audio'||captionIds.has(c.id)).map(c=>root(c.trackId)));
 const points=new Map(joined.tracks.map(t=>[t.id,protectedRoots.has(root(t.id))?at:trackAt(t.id)]));
 // Saved relationships align only the fragments being restored. Existing
 // track boundaries remain the split points for live material; overwriting
 // them would put a later live sample before an earlier restored sample.
 const restoredPoints=new Map(points),savedParents=new Map(joined.tracks.map(t=>[t.id,t.id]));
 const savedRoot=(id:string):string=>{const p=savedParents.get(id)!;return p===id?id:savedRoot(p);};
 const savedUnion=(a:string,b:string)=>savedParents.set(savedRoot(a),savedRoot(b));
 const savedLinks=new Map<string,string>();
 for(const c of joined.clips.filter(c=>restored.has(c.id))){
  if(c.linkGroupId){const track=savedLinks.get(c.linkGroupId);if(track)savedUnion(track,c.trackId);else savedLinks.set(c.linkGroupId,c.trackId);}
  if(c.anchor?.kind==='source'){const providerId=c.anchor.clipOccurrenceId,provider=joined.clips.find(p=>p.id===providerId);if(provider&&restored.has(provider.id))savedUnion(c.trackId,provider.trackId);}
 }
 for(const component of new Set(joined.tracks.map(t=>savedRoot(t.id)))){
  const saved=joined.clips.filter(c=>restored.has(c.id)&&savedRoot(c.trackId)===component);
  const videoPoints=[...new Set(saved.filter(c=>c.content.kind==='video'&&c.linkGroupId).map(c=>points.get(c.trackId)!))];
  if(!videoPoints.length)continue;
  if(videoPoints.length!==1)throw new SequenceError('INVALID_RANGE','連動映像の復元位置が複数あります。復元位置を指定してください');
  // The earliest common placement after every saved owner's live prefix.
  // Linked live suffixes still receive one shared shift, preserving any
  // previously explicit one-sided move rather than silently resynchronizing it.
  // The adopted saved position itself places the new pair in the hidden
  // suffix, even if a prior trim removed the hidden prefix's live samples.
  // Keeping its later live suffix visible would require end <= pair <
  // suffix < end. Check the placement contract, not presence of old samples.
  const savedTracks=new Set(saved.map(c=>c.trackId));
  const live=joined.clips.filter(c=>!restored.has(c.id)&&savedTracks.has(c.trackId));
  const point=Math.max(...saved.map(c=>points.get(c.trackId)!));
  const visibleSuffix=live.some(c=>points.get(c.trackId)!<current.sequenceEndFrame&&Math.min(clipEnd(c),current.sequenceEndFrame)>Math.max(c.startFrame,points.get(c.trackId)!));
  if(point>current.sequenceEndFrame&&visibleSuffix)throw new SequenceError('INVALID_RANGE','連動素材の配置が復元範囲と両立しないため、先に配置を調整してください');
  for(const c of saved)restoredPoints.set(c.trackId,point);
 }
 const fixed=(id:string)=>{const c=joined.clips.find(c=>c.id===id)!;return !c.speed&&!captionIds.has(c.id)&&c.anchor?.kind!=='source';};
 const required=(track:string,shift:number)=>{
  let value=shift,changed=true;
  const point=points.get(track)!,restoredOffset=restoredPoints.get(track)!-point;
  const saved=joined.clips.filter(c=>restored.has(c.id)&&c.trackId===track);
  const live=joined.clips.filter(c=>!restored.has(c.id)&&c.trackId===track&&clipEnd(c)>point);
  // Every surviving suffix follows the saved interval, including a suffix
  // that fits before the common linked placement without overlapping it.
  while(changed){changed=false;for(const c of live){const start=Math.max(point,c.startFrame)-point;
    for(const part of saved)if(start+value<restoredOffset+clipEnd(part)-offset){
     value=restoredOffset+clipEnd(part)-offset-start;changed=true;
    }
  }}return value;
 };
 // A live main/provider component always receives exactly the AV insertion.
 // If a preserved fixed exposure conflicts with it, use an adjacent ordinary
 // track for the restored piece; never postpone surviving AV to make room.
 for(const track of [...joined.tracks]){
  if(!protectedRoots.has(root(track.id))||required(track.id,amount)===amount)continue;
  const candidates=joined.clips.filter(c=>restored.has(c.id)&&c.trackId===track.id&&fixed(c.id));
  if(!candidates.length)continue;
  const id=fresh('restored-track');joined.tracks.splice(joined.tracks.findIndex(t=>t.id===track.id)+1,0,{...track,id,name:track.name+'（復元素材）'});
  destinations.set(track.id,id);for(const c of candidates)c.trackId=id;
  shifts.set(id,amount);parents.set(id,id);points.set(id,points.get(track.id)!);restoredPoints.set(id,restoredPoints.get(track.id)!);
 }
 // Fixed-only components retain enough room for all restored exposures and all
 // existing fragments. Repeat after propagating linked-component requirements.
 let changed=true;while(changed){changed=false;for(const track of joined.tracks){
  if(protectedRoots.has(root(track.id)))continue;
  const need=required(track.id,shifts.get(track.id)!);
  for(const member of joined.tracks)if(root(member.id)===root(track.id)&&shifts.get(member.id)!<need){shifts.set(member.id,need);changed=true;}
 }}
 // Preserve previously visible tails, but do not reveal arbitrary clips that
 // were already beyond the completed timeline. New restored exposure may end
 // after the AV; it must not be silently trimmed or filled with guessed media.
 let sequenceEndFrame=current.sequenceEndFrame+amount;
 let endFloor=(current.insertOwnSpeed?.endFloor??current.sequenceEndFrame);endFloor=endFloor>at?endFloor+amount:endFloor;
 for(const c of joined.clips){if(restored.has(c.id)){if(restoredPoints.get(c.trackId)!>current.sequenceEndFrame)continue;const end=restoredPoints.get(c.trackId)!+clipEnd(c)-offset;sequenceEndFrame=Math.max(sequenceEndFrame,end);if(!c.insertOwnSpeed)endFloor=Math.max(endFloor,end);continue;}
  const visibleEnd=Math.min(clipEnd(c),current.sequenceEndFrame);
  if(c.startFrame<visibleEnd){const end=visibleEnd+(visibleEnd>points.get(c.trackId)!?shifts.get(c.trackId)!:0);sequenceEndFrame=Math.max(sequenceEndFrame,end);if(!c.insertOwnSpeed)endFloor=Math.max(endFloor,end);}
 }
 // Hidden material retains a separate suffix coordinate. Inserting into that
 // suffix cannot make it visible or reorder it behind the newly restored piece.
 const insertionPoint=(track:string)=>{const point=restoredPoints.get(track)!;return point>current.sequenceEndFrame?sequenceEndFrame+point-current.sequenceEndFrame:point;};
 const mapFrame=(frame:number,track:string)=>{const point=points.get(track)!,shift=shifts.get(track)!;
  // A common saved placement in the hidden suffix still inserts before this
  // owner's hidden live suffix, even if its own split point was visible.
  if(frame>=current.sequenceEndFrame)return sequenceEndFrame+frame-current.sequenceEndFrame+((point>current.sequenceEndFrame||restoredPoints.get(track)!>current.sequenceEndFrame)&&frame>=point?shift:0);
  return frame+(frame>=point?shift:0);
 };
 return {shifts,points,destinations,sequenceEndFrame,endFloor,insertionPoint,mapFrame};
}
