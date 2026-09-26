import {clipEnd,sourceTimeAt,type SequenceClip,type SequenceDocument} from '../../core/sequence/model';
import {addTime,divideTime,multiplyTime,rational,subtractTime,type Rational} from '../../core/sequence/time';
import {mediaSourceReviewDocument} from '../../core/sequence/sourceReview';

export const mediaSourceReview=mediaSourceReviewDocument;

export function cutSourceOwners(document:SequenceDocument,entryId:string):SequenceClip[]{
  const entry=document.cutArchive?.entries.find(e=>e.id===entryId);
  return entry?.clips.filter(c=>c.content.kind==='video'||c.content.kind==='audio')??[];
}
/** Raw source audition, never the saved edit or an inferred restoration graph. */
export function cutSourceReview(document:SequenceDocument,entryId:string,clipId:string):SequenceDocument{
  const occurrence=cutSourceOwners(document,entryId).find(c=>c.id===clipId);
  if(!occurrence||(occurrence.content.kind!=='video'&&occurrence.content.kind!=='audio'))throw new Error('確認するカットの使用箇所を選択してください');
  return mediaSourceReview(document,occurrence);
}

export function cutSourceExtent(clip:SequenceClip,editFps:Rational):{start:Rational;end:Rational}{
  if(clip.content.kind!=='video'&&clip.content.kind!=='audio')throw new Error('映像・音声の使用箇所を選択してください');
  return {start:clip.content.sourceIn,end:sourceTimeAt(clip,clipEnd(clip),editFps)};
}
/** Exact affine source mapping for this particular occurrence; caller owns rounding. */
export function sourceToCutLocal(clip:SequenceClip,sourceTime:Rational,editFps:Rational):Rational{
  if(clip.content.kind!=='video'&&clip.content.kind!=='audio')throw new Error('映像・音声の使用箇所を選択してください');
  return addTime(rational(clip.startFrame),multiplyTime(divideTime(subtractTime(sourceTime,clip.content.sourceIn),clip.content.rate),editFps));
}
