import {clipEnd,sourceTimeAt,type CutArchiveEntry,type SequenceDocument} from './model';
import {ceilTime,compareTime,divideTime,floorTime,multiplyTime,subtractTime} from './time';

export interface CutWord {id:string;text:string;startFrame:number;endFrame:number}
/** Each repeated source occurrence retains its own word and local band range. */
export function archivedWords(document:SequenceDocument,entry:CutArchiveEntry):CutWord[]{
  const result:CutWord[]=[];
  for(const clip of entry.clips){
    const content=clip.content;if(content.kind!=='audio'||content.role!=='speech')continue;
    const transcript=document.transcripts.find(t=>t.assetId===content.assetId&&t.streamIndex===content.streamIndex);if(!transcript)continue;
    const sourceStart=sourceTimeAt(clip,clip.startFrame,document.fps),sourceEnd=sourceTimeAt(clip,clipEnd(clip),document.fps);
    const frame=(time:typeof sourceStart)=>multiplyTime(divideTime(subtractTime(time,content.sourceIn),content.rate),document.fps);
    for(const word of transcript.words){
      if(compareTime(word.end,sourceStart)<=0||compareTime(word.start,sourceEnd)>=0)continue;
      const startFrame=Math.max(clip.startFrame,clip.startFrame+floorTime(frame(word.start)));
      const endFrame=Math.min(clipEnd(clip),clip.startFrame+ceilTime(frame(word.end)));
      if(startFrame<endFrame)result.push({id:`${clip.id}:${word.id}`,text:word.text,startFrame,endFrame});
    }
  }
  return result.sort((a,b)=>a.startFrame-b.startFrame||a.endFrame-b.endFrame||a.id.localeCompare(b.id));
}
