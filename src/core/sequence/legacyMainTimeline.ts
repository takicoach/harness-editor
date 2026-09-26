import type { EditorProject, CutSegment } from '../types';
import { buildPlaybackModel, type PlaybackModel } from '../../preview/playbackModel';
import { buildTransitionSeriesChildren } from '../../preview/transitionSeriesChildren';
import { SequenceError } from './errors';

type Transition = Extract<ReturnType<typeof buildTransitionSeriesChildren>[number], {type:'transition'}>;
export interface LegacyMainTimelineEntry {
  segment: CutSegment;
  startFrame: number;
  durationFrames: number;
  transition?: Transition;
}

/** The native legacy projection and save validation share this exact clock.
 * It does not use the retired project's SpeedPlayer/TransitionSeries helpers. */
export function buildLegacyMainTimeline(project:EditorProject):{model:PlaybackModel;entries:LegacyMainTimelineEntry[]} {
  const model=buildPlaybackModel(project);
  const items=buildTransitionSeriesChildren(model.keptSegments,model.sceneTransitions,model.joins);
  const entries:LegacyMainTimelineEntry[]=[];
  let cursor=0,pending:Transition|undefined;
  for(const item of items){
    if(item.type==='transition'){pending=item;cursor-=item.overlap;continue;}
    const segment=item.seg,durationFrames=Math.max(1,segment.playbackEnd-segment.playbackStart);
    const startFrame=model.overlaps.length?cursor:segment.playbackStart;
    if(!Number.isSafeInteger(startFrame)||startFrame<0||!Number.isSafeInteger(durationFrames)||!Number.isSafeInteger(startFrame+durationFrames))
      throw new SequenceError('INVALID_RANGE','主映像の完成時刻を安全な整数で表せません');
    entries.push({segment,startFrame,durationFrames,...(pending?{transition:pending}:{})});
    cursor=startFrame+durationFrames;pending=undefined;
  }
  return {model,entries};
}
