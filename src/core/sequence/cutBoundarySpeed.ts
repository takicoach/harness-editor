import {clipEnd,type SequenceDocument} from './model';
import {resolveCutBoundary} from './cutArchive';
import {speedProjectionForDocument} from './speedCaptionLedger';

/** A speed command may move a known cut seam while fixed overlays stay put.
 * Keep every witness, but bind its offset to the same explicitly owned seam.
 * Only exact main endpoints are recaptured: rounded interior times would lose
 * their original coordinate across repeated speed changes. */
export function rebindCutBoundariesForSpeed(before:SequenceDocument,next:SequenceDocument):void {
 if(!before.cutArchive||!next.cutArchive)return;
 const oldProjection=speedProjectionForDocument(before),projection=speedProjectionForDocument(next);
 const oldClips=new Map(before.clips.map(c=>[c.id,c])),clips=new Map(next.clips.map(c=>[c.id,c]));
 for(const entry of next.cutArchive.entries){
  const old=before.cutArchive.entries.find(e=>e.id===entry.id);if(!old)continue;
  const frame=resolveCutBoundary(before,old).frame;
  if(frame===null){continue;}
  const owners=new Set<string>();
  for(const ref of old.boundary.references){
   const clip=oldClips.get(ref.clipId),speed=clip?.speed;
   if(!clip||!speed||speed.kind==='independent-audio')continue;
   const ownerId=speed.kind==='main'?clip.id:speed.providerId;
   const owner=oldProjection.entries.find(e=>e.ownerId===ownerId);
   if(owner&&(frame===owner.startFrame||frame===owner.endFrame))owners.add(ownerId);
  }
  if(!owners.size)continue;
  const points=[...owners].map(ownerId=>projection.point({ownerId,kind:'clip',offset:oldProjection.inverse(ownerId,frame)}));
  const target=points[0]!;
  if(points.some(p=>p!==target)||!Number.isSafeInteger(target)||target<0||target>next.sequenceEndFrame
    ||old.boundary.references.some(ref=>!clips.has(ref.clipId))){continue;}
  entry.boundary.hintFrame=target;
  entry.boundary.references=old.boundary.references.map(ref=>{
   const clip=clips.get(ref.clipId)!;
   return {...ref,offsetFrames:target-(ref.edge==='start'?clip.startFrame:clipEnd(clip))};
  });
 }
}
