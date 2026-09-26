import type { ScenePlan } from '../../core/sequence/scenePlan';
import type {SequenceClip} from '../../core/sequence/model';
import { addTime,subtractTime,floorTime,ceilTime, compareTime, divideTime, frameSeconds, multiplyTime, rational, timeNumber, type Rational } from '../../core/sequence/time';
import {sourceWindowCoordinates,type PcmSourceWindow} from './sourceWindowPcm';

/** Read-only mixing view; a shuttle changes its clock without changing the
 * stored document or the visual ScenePlan. */
export interface AudioMixPlan {
  document: Pick<ScenePlan['document'], 'fps' | 'sequenceEndFrame'>;
  audibleClips: readonly SequenceClip[];
  audioGain(clip: SequenceClip, frame: number): number;
}

/** PCM has already been decoded and, where needed, pitch-preserving time-stretched. */
export interface PreparedPcm {
  sampleRate: number;
  channels: readonly Float32Array<ArrayBuffer>[];
  assetId: string;
  streamIndex: number;
  rate: Rational;
}
/** A preloaded window exposes the same samples without retaining an entire source. */
export interface WindowedPcm extends Omit<PreparedPcm, 'channels'> {
  sampleCount: number;
  sample(channel: number, index: number): number;
}
export type SourceWindowPcm = (PreparedPcm | WindowedPcm) & {kind:'source-window-pcm';sourceWindow:PcmSourceWindow};
export type PcmSource = PreparedPcm | WindowedPcm | SourceWindowPcm;
export const pcmClipKey=(clipId:string)=>`@clip:${clipId}`;
const bounded=(pcm:PcmSource):pcm is SourceWindowPcm=>'kind' in pcm&&pcm.kind==='source-window-pcm';
function sourceForClip(sources:ReadonlyMap<string,PcmSource>,clip:SequenceClip) {
  const c=clip.content;if(c.kind!=='audio')throw new Error('音声クリップではありません');
  const explicit=sources.has(pcmClipKey(clip.id)),key=explicit?pcmClipKey(clip.id):pcmKey(c.assetId,c.streamIndex,c.rate),pcm=sources.get(key);
  if(pcm&&bounded(pcm)!==explicit)throw new Error(`区間限定PCMはクリップごとに指定してください: ${clip.id}`);
  return {key,pcm};
}
export function pcmLength(pcm: PcmSource): number { return 'sample' in pcm ? pcm.sampleCount : pcm.channels[0]?.length ?? 0; }
export interface PcmRange { from: number; to: number }

/** Adoption bound for the existing whole-asset PCM path. This does not claim
 * that the underlying DSP was processed with isolated source context. */
function ownBounds(clip:SequenceClip,fps:Rational,pcm:PcmSource,outputRate:number){
  const own=clip.insertOwnSpeed;if(!own||bounded(pcm))return undefined;
  const {sourceStart,sourceEnd}=own.source;
  // The whole-asset PCM coordinate may have a fractional first position. Keep
  // its left interpolation tap so registration alone leaves the audio intact.
  return {first:floorTime(multiplyTime(divideTime(sourceStart,own.rate),rational(pcm.sampleRate))),
    last:ceilTime(multiplyTime(divideTime(sourceEnd,own.rate),rational(pcm.sampleRate))),
    timelineEnd:ceilTime(multiplyTime(addTime(frameSeconds(clip.startFrame,fps),divideTime(subtractTime(sourceEnd,sourceStart),own.rate)),rational(outputRate)))};
}

/** Source windows needed for a block, including interpolation at loop boundaries. */
export function pcmReadRanges(plan: AudioMixPlan, sources: ReadonlyMap<string, PcmSource>, start: number, count: number, sampleRate = 48000): Map<string, PcmRange[]> {
  const result = new Map<string, PcmRange[]>(), fps = timeNumber(plan.document.fps), end = sequenceSampleCount(plan, sampleRate);
  for (const clip of plan.audibleClips) {
    const content = clip.content; if (content.kind !== 'audio') continue;
    const {key,pcm}=sourceForClip(sources,clip);
    const from = Math.max(start, ceilTime(multiplyTime(frameSeconds(clip.startFrame, plan.document.fps), rational(sampleRate))));
    const own=pcm?ownBounds(clip,plan.document.fps,pcm,sampleRate):undefined;
    const to = Math.min(start + count, end, own?.timelineEnd??Infinity,ceilTime(multiplyTime(frameSeconds(clip.startFrame + clip.durationFrames, plan.document.fps), rational(sampleRate))));
    if (from >= to) continue;
    if (!pcm) throw new Error(`音声の準備ができていません: ${clip.id}`);
    const length = pcmLength(pcm); if (!length) throw new Error('音声PCMが空です');
    if(bounded(pcm)) {
      if(pcm.assetId!==content.assetId||pcm.streamIndex!==content.streamIndex||compareTime(pcm.rate,content.rate)!==0)throw new Error(`音声PCMの形式が不正です: ${clip.id}`);
      const window=sourceWindowCoordinates(clip,plan.document.fps,pcm,from,to,sampleRate);
      if(!Number.isSafeInteger(length)||length<window.supportCount)throw new Error(`音声PCMが素材区間に対して不足しています: ${clip.id}`);
      const spans=result.get(key)??[];
      if(window.from<window.to) {
        const first=Math.max(0,window.position(window.from).index);
        const last=Math.min(window.supportCount,window.position(window.to-1).index+2);
        // A fractional source origin can leave both taps before raw sample zero.
        // Only the intersection with physical support needs a read; the mixer
        // supplies zero outside it, while retaining the first valid right tap.
        if(first<last)spans.push({from:first,to:last});
      }
      result.set(key,spans);continue;
    }
    const position = (sample: number) => (timeNumber(content.sourceIn) / timeNumber(content.rate) + sample / sampleRate - clip.startFrame / fps) * pcm.sampleRate;
    // Modular normalization can round a value immediately next to an integer in
    // either direction. One guard sample on each side covers that FP boundary.
    const first = Math.floor(position(from)) - 1, last = Math.floor(position(to - 1)) + 3, spans = result.get(key) ?? [];
    if (content.loop) {
      const at = ((first % length) + length) % length, size = last - first;
      if (size >= length) spans.push({ from: 0, to: length });
      else { spans.push({ from: at, to: Math.min(length, at + size) }); if (at + size > length) spans.push({ from: 0, to: at + size - length }); }
    } else if (last > 0 && first < length) {
      const lo=Math.max(0,first,own?.first??0),hi=Math.min(length,last,own?.last??length);
      if(lo<hi)spans.push({from:lo,to:hi});
    }
    result.set(key, spans);
  }
  for (const [key, ranges] of result) {
    const merged: PcmRange[] = [];
    for (const range of ranges.sort((a,b) => a.from - b.from)) {
      const previous = merged.at(-1);
      if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to); else merged.push({ ...range });
    }
    result.set(key, merged);
  }
  return result;
}
export function pcmKey(assetId: string, streamIndex: number, rate: Rational): string {
  const normalized = rational(rate.num, rate.den);
  return `${assetId}:${streamIndex}:${normalized.num}/${normalized.den}`;
}
export function sequenceSampleCount(plan: Pick<AudioMixPlan, 'document'>, sampleRate: number): number {
  return ceilTime(multiplyTime(divideTime(rational(plan.document.sequenceEndFrame), plan.document.fps), rational(sampleRate)));
}

/** Stateless block mixer: offline export and the audio transport request the same sample indices. */
export function mixAudioBlock(plan: AudioMixPlan, sources: ReadonlyMap<string, PcmSource>, startSample: number, sampleCount: number, sampleRate = 48000): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  if (![startSample, sampleCount, sampleRate].every(Number.isSafeInteger) || startSample < 0 || sampleCount < 0 || sampleRate <= 0) throw new Error('音声サンプル範囲が不正です');
  const left = new Float32Array(sampleCount), right = new Float32Array(sampleCount);
  const fps = timeNumber(plan.document.fps), sequenceEnd = sequenceSampleCount(plan, sampleRate);
  for (const clip of plan.audibleClips) {
    const content = clip.content;
    if (content.kind !== 'audio') continue;
    const {pcm}=sourceForClip(sources,clip);
    const clipStart = ceilTime(multiplyTime(frameSeconds(clip.startFrame, plan.document.fps), rational(sampleRate)));
    const clipEnd = ceilTime(multiplyTime(frameSeconds(clip.startFrame + clip.durationFrames, plan.document.fps), rational(sampleRate)));
    const own=pcm?ownBounds(clip,plan.document.fps,pcm,sampleRate):undefined;
    const from = Math.max(startSample, clipStart), to = Math.min(startSample + sampleCount, clipEnd, sequenceEnd,own?.timelineEnd??Infinity);
    if (from >= to) continue;
    if (!pcm) throw new Error(`音声の準備ができていません: ${clip.id}`);
    const length = pcmLength(pcm);
    if (!Number.isSafeInteger(length) || !length || !Number.isSafeInteger(pcm.sampleRate) || pcm.sampleRate <= 0
      || (!('sample' in pcm) && (pcm.channels.length > 2 || pcm.channels.some(channel => channel.length !== length)))
      || pcm.assetId !== content.assetId || pcm.streamIndex !== content.streamIndex || compareTime(pcm.rate, content.rate) !== 0) throw new Error(`音声PCMの形式が不正です: ${clip.id}`);
    const offset = timeNumber(content.sourceIn) / timeNumber(content.rate), startSeconds = clip.startFrame / fps;
    const window=bounded(pcm)?sourceWindowCoordinates(clip,plan.document.fps,pcm,from,to,sampleRate):undefined;
    if(window&&length<window.supportCount)throw new Error(`音声PCMが素材区間に対して不足しています: ${clip.id}`);
    for (let sample = window?window.from:from; sample < (window?window.to:to); sample++) {
      let position = (offset + sample / sampleRate - startSeconds) * pcm.sampleRate;
      if (content.loop) position = ((position % length) + length) % length;
      const point=window?.position(sample),index = point?point.index:Math.floor(position), fraction = point?point.fraction:position-index;
      // The exact sample gate above already proves this sample is at/after
      // clip.startFrame. Floating conversion can round an NTSC join just below
      // that frame and incorrectly mute its first sample; preserve that bound.
      const gain = plan.audioGain(clip, Math.max(clip.startFrame, sample / sampleRate * fps)), destination = sample - startSample;
      for (let channel = 0; channel < 2; channel++) {
        const read = (at: number) => 'sample' in pcm ? pcm.sample(channel, at) : (pcm.channels[channel] ?? pcm.channels[0]!)[at]!;
        const support=window?window.supportCount:Math.min(length,own?.last??length),supportStart=own?.first??0;
        const a = index >= supportStart && index < support ? read(index) : 0;
        const nextIndex = content.loop ? (index + 1) % length : index + 1;
        const b = nextIndex >= supportStart && nextIndex < support ? read(nextIndex) : 0;
        (channel === 0 ? left : right)[destination]! += (a + (b - a) * fraction) * gain;
      }
    }
  }
  return [left, right];
}
