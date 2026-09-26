import {clipEnd,effectFrameAt,isMediaContent,sourceTimeAt,type SequenceDocument,type SequenceClip} from '../../core/sequence/model';
import {addTime,multiplyTime,rational} from '../../core/sequence/time';
import {validateSequenceDocument} from '../../core/sequence/validate';
import {buildFinishDisplayMap,type FinishDisplayMap} from './finishDisplayMap';

/** Disposable monitor graph on the finish timeline's saved-cut axis. Never save/export this graph. */
export function cutInclusivePreview(document:SequenceDocument):{document:SequenceDocument;map:FinishDisplayMap}{
  const map=buildFinishDisplayMap(document);
  // The map excludes unresolved bands. Keep the proven bands playable and
  // return the unresolved list so the monitor can explain what was omitted.
  const result:SequenceDocument={schemaVersion:2,id:'cut-inclusive-preview',name:document.name,revision:document.revision,
    fps:document.fps,resolution:document.resolution,background:document.background,assets:document.assets,
    transcripts:[],tracks:structuredClone(document.tracks),clips:[],transitions:[],ducking:document.ducking,sequenceEndFrame:map.displayEnd};
  const slice=(clip:SequenceClip,start:number,end:number,at:number,id:string):SequenceClip=>{
    const next=structuredClone(clip);
    next.id=id;next.startFrame=at;next.durationFrames=end-start;next.clock.offset=effectFrameAt(clip,start);
    if(next.visual?.keyframeClock)next.visual.keyframeClock.offset=addTime(next.visual.keyframeClock.offset,multiplyTime(rational(start-clip.startFrame),next.visual.keyframeClock.rate));
    if(isMediaContent(next.content))next.content.sourceIn=sourceTimeAt(clip,start,document.fps);
    next.anchor={kind:'timeline'};
    delete next.speed;delete next.insertOwnSpeed;delete next.linkGroupId;delete next.legacyCaptionContinuity;delete next.legacyAudioContinuity;delete next.legacyMainRole;
    // Explicit fragment clocks already preserve appearance; these editing references are not monitor identities.
    delete next.continuationGroupId;
    return next;
  };
  for(const [index,block] of map.blocks.entries()){
    const entry=block.kind==='archived'?document.cutArchive!.entries.find(e=>e.id===block.entryId)!:null;
    const source=entry?.clips??document.clips,start=block.kind==='live'?block.startFrame:0,end=block.kind==='live'?block.endFrame:block.localEnd;
    for(const track of entry?.tracks??[])if(!result.tracks.some(t=>t.id===track.id))result.tracks.push(structuredClone(track));
    const ids=new Map<string,string>();
    for(const [n,clip] of source.entries()){
      const from=Math.max(start,clip.startFrame),to=Math.min(end,clipEnd(clip));if(from>=to)continue;
      const id=`review-${index}-${n}`;ids.set(clip.id,id);
      result.clips.push(slice(clip,from,to,block.displayStart+from-start,id));
    }
    if(block.kind==='live')for(const transition of document.transitions){
      if(transition.startFrame>=end||transition.startFrame+transition.durationFrames<=start)continue;
      if(transition.startFrame<start||transition.startFrame+transition.durationFrames>end)throw new Error('転換とカットが重なるため通し確認できません。カットの素材確認をご利用ください。');
      const next={...structuredClone(transition),id:`review-transition-${index}-${result.transitions.length}`,startFrame:block.displayStart+transition.startFrame-start,outClipId:ids.get(transition.outClipId)!};
      if(transition.inClipId)next.inClipId=ids.get(transition.inClipId)!;
      delete next.joinKey;delete next.joinFrame;
      result.transitions.push(next);
    }
  }
  validateSequenceDocument(result);
  return {document:result,map};
}
