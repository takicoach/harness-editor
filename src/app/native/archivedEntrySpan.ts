import {clipEnd,type SequenceClip} from '../../core/sequence/model';
import {waveformViewport,type WaveformViewport} from './waveformViewport';

/** Saved clips plus the band length, the only parts of an archive entry needed
 * to decide what a track shows. */
export interface ArchivedEntryLike {durationFrames:number;clips:SequenceClip[]}
/** One saved clip clipped to its own band, still in the entry's local frames. */
export interface ArchivedEntrySpan {clip:SequenceClip;from:number;duration:number}

/** Saved video/audio of one archived cut on one track. Reads the stored clips
 * directly, so a caller can tell whether anything is on screen before paying
 * for a restored graph. */
export function archivedEntrySpans(entry:ArchivedEntryLike,trackId:string):ArchivedEntrySpan[]{
  return entry.clips.filter(clip=>clip.trackId===trackId&&(clip.content.kind==='video'||clip.content.kind==='audio'))
    .map(clip=>{
      const from=Math.max(0,clip.startFrame),to=Math.min(entry.durationFrames,clipEnd(clip));
      return {clip,from,duration:to-from};
    });
}

/** The visible slice of each span, with the band placed at `start` on the
 * display axis. Empty means this track draws nothing for this entry. */
export function visibleArchivedSpans(spans:readonly ArchivedEntrySpan[],start:number,pixels:number,scrollLeft:number,viewportWidth:number):Array<ArchivedEntrySpan&{viewport:WaveformViewport}>{
  return spans.flatMap(span=>{
    const viewport=waveformViewport(start+span.from,span.duration,pixels,scrollLeft,viewportWidth);
    return viewport?[{...span,viewport}]:[];
  });
}
