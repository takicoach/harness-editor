import {addTime, compareTime, subtractTime, type Rational} from '../../core/sequence/time';
import type {FrameIdentity} from './mp4FrameSource';

/** STTS duration advances the decode clock. Within a continuous video edit,
 * the next CTS instead ends the displayed image, including reordered VFR.
 * Keep sample ids/decode order untouched; preroll remains available to the codec.
 * This constructs MP4 presentation intervals, not a fallback for arbitrary gaps
 * in the source-window selector's already-defined intervals. */
export function mp4Presentation(identities: readonly FrameIdentity[], leading: Rational,
  editDuration?: Rational): FrameIdentity[] {
  const ordered=[...identities].sort((a,b)=>compareTime(a.pts,b.pts));
  if(!ordered.length)return [];
  const last=ordered[ordered.length-1]!;
  const naturalEnd=addTime(last.pts,last.duration);
  const editEnd=editDuration===undefined?naturalEnd:addTime(leading,editDuration);
  const limit=compareTime(editEnd,naturalEnd)<0?editEnd:naturalEnd;
  const result:FrameIdentity[]=[];
  for(let index=0;index<ordered.length;index++){
    const identity=ordered[index]!,next=ordered[index+1];
    const pts=compareTime(identity.pts,leading)<0?leading:identity.pts;
    const boundary=next?.pts??naturalEnd;
    const end=compareTime(boundary,limit)<0?boundary:limit;
    if(compareTime(pts,end)<0)result.push({sample:identity.sample,pts,duration:subtractTime(end,pts)});
  }
  return result;
}
