import { addTime, compareTime, isRational, rational, type Rational } from '../../core/sequence/time';
import type { FrameIdentity } from './mp4FrameSource';

export interface VideoSourceWindow { start: Rational; end: Rational }

/** A decoded frame is constant over its half-open presentation interval. A cut
 * through that interval can use the same frame, but a sample whose interval has
 * no positive intersection with the requested source window cannot be shown.
 * Codec reference-frame decoding outside the window is a separate concern. */
export function sampleInVideoSourceWindow(samples: readonly { identity: FrameIdentity }[], time: Rational,
  window: VideoSourceWindow, holdAtMediaEnd = false): number {
  if (!window || !isRational(window.start) || !isRational(window.end) || !isRational(time)
    || compareTime(window.start, rational(0)) < 0 || compareTime(window.start, window.end) >= 0) {
    throw new Error('映像の素材範囲が不正です');
  }
  let first: FrameIdentity | undefined, last: FrameIdentity | undefined, matching: FrameIdentity | undefined;
  let mediaEnd: Rational | undefined;
  for (const { identity } of samples) {
    const end = addTime(identity.pts, identity.duration);
    // Samples excluded by the cut still determine whether this is media EOF.
    // The last sample intersecting a cut can instead precede an internal hole.
    if (!mediaEnd || compareTime(end, mediaEnd) > 0) mediaEnd = end;
    if (compareTime(identity.pts, window.end) >= 0 || compareTime(end, window.start) <= 0) continue;
    if (!first || compareTime(identity.pts, first.pts) < 0) first = identity;
    if (!last || compareTime(identity.pts, last.pts) > 0) last = identity;
    if (!matching && compareTime(identity.pts, time) <= 0 && compareTime(time, end) < 0) matching = identity;
  }
  if (!first || !last) throw new Error('素材範囲内に表示できる映像フレームがありません');
  if (compareTime(time, window.start) < 0) return first.sample;
  if (compareTime(time, window.end) >= 0) return last.sample;
  if (matching) return matching.sample;
  if (holdAtMediaEnd && mediaEnd && compareTime(time, mediaEnd) >= 0) return last.sample;
  throw new Error('指定時刻に素材範囲内の映像フレームがありません');
}
