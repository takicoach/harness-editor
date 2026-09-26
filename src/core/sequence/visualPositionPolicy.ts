import type {MotionPositionPolicy} from '../motion';
import type {SequenceClip} from './model';
import {activeTextAppearance} from './textStyle';

/** Only the native graphic's outer placement is unbounded; inner/legacy motion stays bounded. */
export function visualPositionPolicy(clip:SequenceClip):MotionPositionPolicy {
  const content=clip.content;
  return content.kind==='shape'||content.kind==='title'||(content.kind==='telop'&&activeTextAppearance(content))?'finite':'bounded';
}
