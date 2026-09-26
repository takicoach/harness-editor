import {sampleVisualTransform} from './visualTransform';
import {planVideoSourceRegions,type VideoSourceRegion} from './videoSourceRegions';
import { ATTACK_SECONDS, DUCK_GAIN, GAP_MERGE_SECONDS, RELEASE_SECONDS } from '../ducking';
import { SequenceError } from './errors';
import { clipEnd, effectFrameAt, sourceTimeAt, type SequenceClip, type SequenceDocument, type SequenceTransition } from './model';
import { addTime, compareTime, divideTime, multiplyTime, rational, subtractTime, timeNumber, type Rational } from './time';
import { parseSequence, serializeSequence } from './validate';

export interface PlannedVisual {
  clip: SequenceClip;
  sourceTime?: Rational;
  effectFrame: number;
  effectDuration: number;
  transform: { x: number; y: number; scale: number; rotation: number; opacity: number; flipH: boolean; flipV: boolean };
}
export interface PlannedTransition { transition: SequenceTransition; progress: number }
export interface PlannedFrame {
  frame: number;
  revision: number;
  visuals: PlannedVisual[];
  transitions: PlannedTransition[];
}
export interface SpeechRegion { startFrame: Rational; endFrame: Rational }

/** An immutable snapshot shared by UI, transport and an export job, without filesystem rereads. */
export class ScenePlan {
  readonly document: SequenceDocument;
  readonly speechRegions: readonly SpeechRegion[];
  readonly missingTranscripts: readonly string[];
  private readonly enabled: Set<string>;
  private readonly order: Map<string, number>;
  readonly audibleClips: readonly SequenceClip[];
  private readonly videoSourceWindows:ReadonlyMap<string,VideoSourceRegion>;

  constructor(document: SequenceDocument) {
    this.document = freeze(parseSequence(serializeSequence(document)));
    this.videoSourceWindows=planVideoSourceRegions(this.document);
    this.enabled = new Set(this.document.tracks.filter(t => t.enabled).map(t => t.id));
    this.order = new Map(this.document.tracks.map((t, i) => [t.id, i]));
    this.audibleClips = this.document.clips.filter(c => c.content.kind === 'audio' && !c.content.settings.muted && this.enabled.has(c.trackId));
    const regions: SpeechRegion[] = [], missing: string[] = [];
    for (const clip of this.audibleClips) {
      const content = clip.content;
      if (content.kind !== 'audio' || content.role !== 'speech') continue;
      const transcript = this.document.transcripts.find(t => t.assetId === content.assetId && t.streamIndex === content.streamIndex);
      if (!transcript) { missing.push(clip.id); continue; }
      const sourceEnd = sourceTimeAt(clip, clipEnd(clip), this.document.fps);
      for (const word of transcript.words) {
        const start = compareTime(word.start, content.sourceIn) < 0 ? content.sourceIn : word.start;
        const end = compareTime(word.end, sourceEnd) > 0 ? sourceEnd : word.end;
        if (compareTime(start, end) >= 0) continue;
        const map = (time: Rational) => addTime(rational(clip.startFrame), multiplyTime(divideTime(subtractTime(time, content.sourceIn), content.rate), this.document.fps));
        regions.push({ startFrame: map(start), endFrame: map(end) });
      }
    }
    regions.sort((a, b) => compareTime(a.startFrame, b.startFrame));
    const merged: SpeechRegion[] = [], maxGap = multiplyTime(this.document.fps, rational(Math.round(GAP_MERGE_SECONDS * 1000), 1000));
    for (const region of regions) {
      const last = merged.at(-1);
      if (last && compareTime(subtractTime(region.startFrame, last.endFrame), maxGap) <= 0) {
        if (compareTime(region.endFrame, last.endFrame) > 0) last.endFrame = region.endFrame;
      } else merged.push({ ...region });
    }
    this.speechRegions = freeze(merged); this.missingTranscripts = Object.freeze(missing);
  }

  frame(frame: number): PlannedFrame {
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= this.document.sequenceEndFrame) {
      throw new SequenceError('INVALID_TIME', 'フレームが出力範囲外です');
    }
    const active = this.document.clips.filter(c => c.content.kind !== 'audio' && this.enabled.has(c.trackId)
      && c.startFrame <= frame && frame < clipEnd(c));
    active.sort((a, b) => this.order.get(a.trackId)! - this.order.get(b.trackId)! || a.startFrame - b.startFrame);
    const visuals: PlannedVisual[] = active.map(clip => {
      const effectFrame = timeNumber(effectFrameAt(clip, frame));
      const effectDuration = timeNumber(clip.clock.duration);
      return { clip, effectFrame, effectDuration,
        ...(clip.content.kind === 'video' ? { sourceTime: sourceTimeAt(clip, frame, this.document.fps) } : {}),
        transform: sampleVisualTransform(clip,frame) };
    });
    return { frame, revision: this.document.revision, visuals,
      transitions: this.document.transitions.filter(t => this.enabled.has(t.trackId) && t.startFrame <= frame && frame < t.startFrame + t.durationFrames)
        .map(transition => ({ transition, progress: (frame - transition.startFrame) / transition.durationFrames })) };
  }

  videoSourceWindow(clipId:string):VideoSourceRegion|undefined {return this.videoSourceWindows.get(clipId);}

  /** Continuous frame time is used here so audio gains are evaluated at each PCM sample. */
  audioGain(clip: SequenceClip, frame: number, sequenceEndFrame = this.document.sequenceEndFrame): number {
    const content = clip.content;
    if (content.kind !== 'audio' || content.settings.muted || !this.enabled.has(clip.trackId)
      || frame < clip.startFrame || frame >= clipEnd(clip) || frame < 0 || frame >= sequenceEndFrame) return 0;
    const settings = content.settings;
    const clock = timeNumber(clip.clock.offset) + (frame - clip.startFrame) * timeNumber(clip.clock.rate);
    const duration = timeNumber(clip.clock.duration);
    const fadeIn = settings.fadeInFrames ? Math.max(0, Math.min(1, clock / Math.min(settings.fadeInFrames, duration))) : 1;
    const fadeOut = settings.fadeOutFrames ? Math.max(0, Math.min(1, (duration - 1 - clock) / Math.min(settings.fadeOutFrames, duration))) : 1;
    let gain = 10 ** (settings.gainDb / 20) * Math.min(fadeIn, fadeOut);
    for (const transition of this.document.transitions) {
      if (transition.audioCurve === 'none') continue;
      if (frame < transition.startFrame || frame >= transition.startFrame + transition.durationFrames) continue;
      const progress = (frame - transition.startFrame) / transition.durationFrames;
      if (transition.outClipId === clip.id) gain *= transition.edge === 'in' ? progress : 1 - progress;
      else if (transition.inClipId === clip.id) gain *= progress;
    }
    if (content.role === 'music' && this.document.ducking.enabled) {
      const fps = timeNumber(this.document.fps), minimum = DUCK_GAIN[this.document.ducking.strength];
      let duck = 1;
      for (const region of this.speechRegions) {
        const start = timeNumber(region.startFrame), end = timeNumber(region.endFrame);
        if (frame >= start && frame < end) duck = Math.min(duck, minimum);
        else if (frame >= start - ATTACK_SECONDS * fps && frame < start) duck = Math.min(duck, 1 + (minimum - 1) * ((frame - start) / (ATTACK_SECONDS * fps) + 1));
        else if (frame >= end && frame < end + RELEASE_SECONDS * fps) duck = Math.min(duck, minimum + (1 - minimum) * (frame - end) / (RELEASE_SECONDS * fps));
      }
      gain *= duck;
    }
    return gain;
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
