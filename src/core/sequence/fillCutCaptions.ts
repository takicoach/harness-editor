import {archivedWords,type CutWord} from './archivedCaptionWords';
import {clipEnd,type SequenceDocument,type SequenceClip} from './model';
import {rational,timeNumber} from './time';
import {SequenceError} from './errors';

/** Fill only uncovered speech in saved cuts. Existing captions and the live edit are immutable. */
export function fillCutCaptions(document:SequenceDocument,templateClipId:string,fresh:(prefix:string)=>string):SequenceDocument {
  const template=document.clips.find(c=>c.id===templateClipId);
  if(!template||template.content.kind!=='telop'||template.content.data.manual===true)
    throw new SequenceError('INVALID_RANGE','書式の基準にする字幕を選択してください');
  const content=template.content;
  const track=document.tracks.find(t=>t.id===template.trackId)!;
  const next=structuredClone(document),fps=timeNumber(document.fps);
  for(const entry of next.cutArchive?.entries??[]){
    const occupied=entry.clips.filter(c=>c.content.kind==='telop'&&c.content.data.manual!==true);
    // Multiple simultaneous speech owners need an explicit choice; never merge their words.
    const owners=entry.clips.filter(c=>c.content.kind==='audio'&&c.content.role==='speech');
    if(owners.length!==1)continue;
    const words=archivedWords(document,entry).filter(w=>!occupied.some(c=>c.startFrame<w.endFrame&&clipEnd(c)>w.startFrame));
    let group:CutWord[]=[];
    const append=()=>{
      if(!group.length)return;
      const start=group[0]!.startFrame,end=Math.max(...group.map(w=>w.endFrame)),text=group.map(w=>w.text).join('');
      const clip:SequenceClip={id:fresh('cut-caption'),trackId:track.id,name:text,startFrame:start,durationFrames:end-start,
        clock:{offset:rational(0),rate:rational(1),duration:rational(end-start)},
        content:{...structuredClone(content),data:{...structuredClone(content.data),text}},
        ...(template.visual?{visual:structuredClone(template.visual)}:{})};
      // A new caption starts its own animation/keyframe clock.
      if(clip.visual?.keyframeClock)clip.visual.keyframeClock={...clip.visual.keyframeClock,offset:rational(0)};
      entry.clips.push(clip);group=[];
    };
    for(const word of words){
      const previous=group.at(-1);
      if(previous&&word.startFrame>=Math.max(...group.map(w=>w.endFrame))&&(word.startFrame-previous.endFrame>fps*.7||word.endFrame-group[0]!.startFrame>fps*4||group.map(w=>w.text).join('').length+word.text.length>24
        ||occupied.some(c=>previous.endFrame<=c.startFrame&&clipEnd(c)<=word.startFrame)))append();
      group.push(word);
    }
    append();
    if(entry.clips.some(c=>c.trackId===track.id)&&!entry.tracks.some(t=>t.id===track.id))entry.tracks.push(structuredClone(track));
  }
  return next;
}
