import { SequenceError } from './errors';
import {clipEnd,type EffectClock,type SequenceClip,type SequenceDocument,type SpeedClockBasis,type NativeSpeedDocumentMetadata} from './model';
import { speedProjectionForDocument, type DocumentSpeedProjection } from './speedCaptionLedger';
import { addTime, compareTime, divideTime, isRational, multiplyTime, rational, type Rational } from './time';
import { validateSequenceDocument } from './validate';

export interface NativeSpeedMediaProjection {
  speed: NativeSpeedDocumentMetadata;
  projection: DocumentSpeedProjection;
  /** Registered main video, its bound audio, and independent audio only.
   * This is not a complete document: captions, fades and other followers must
   * be coordinated before a caller may save or render the result. */
  mediaClips: SequenceClip[];
}

function clockAt(basis: SpeedClockBasis, rate: Rational, delta: number): EffectClock {
  const slope = multiplyTime(basis.slope, rate);
  return { offset: addTime(basis.offset, multiplyTime(rational(delta), slope)), rate: slope,
    duration: structuredClone(basis.duration) };
}

/** Derive media fields from saved intent, never from the last rounded coverage.
 * The command coordinator owns captions, transitions and the final validation.
 * Nothing here changes the input or adopts a new speed/source/clock basis. */
export function projectNativeSpeedMedia(document: SequenceDocument, globalRate: Rational, override?:{clipId:string;rate:Rational|null}): NativeSpeedMediaProjection {
  validateSequenceDocument(document);
  if (!isRational(globalRate) || Object.keys(globalRate).some(key => key !== 'num' && key !== 'den')
    || compareTime(globalRate, rational(1, 10)) < 0 || compareTime(globalRate, rational(16)) > 0) {
    throw new SequenceError('INVALID_RANGE', '全体速度は0.1〜16の範囲で指定してください');
  }
  if (!document.speed || !document.clips.some(clip => clip.speed?.kind === 'main')) {
    throw new SequenceError('MISSING_TARGET', '速度を変更する主映像の保存基準がありません');
  }
  const draft = structuredClone(document);
  draft.speed!.globalRate = rational(globalRate.num, globalRate.den);
  if(override){const clip=draft.clips.find(c=>c.id===override.clipId);if(clip?.speed?.kind!=='main')throw new SequenceError('MISSING_TARGET','個別速度の主映像がありません',[override.clipId]);if(override.rate===null)delete clip.speed.override;else clip.speed.override=rational(override.rate.num,override.rate.den);}
  if(draft.insertOwnSpeed&&draft.speed!.sequenceEndBasis.kind==='main-offset'){
    // Establish the actual completion before the normal projection validates
    // its nonnegative end. An own interval can cover a negative native tail.
    const oldMainEnd=speedProjectionForDocument(document).mainEndFrame;
    draft.speed!.sequenceEndBasis.offsetFrames=0;
    const mainEnd=speedProjectionForDocument(draft).mainEndFrame;
    const floor=Number(BigInt(draft.insertOwnSpeed.endFloor)+BigInt(mainEnd)-BigInt(oldMainEnd));
    if(!Number.isSafeInteger(floor))throw new SequenceError('INVALID_RANGE','挿入完成尺の基準が安全整数を超えます');
    const end=Math.max(floor,...draft.clips.filter(c=>c.insertOwnSpeed).map(clipEnd));
    draft.speed!.sequenceEndBasis.offsetFrames=end-mainEnd;
  }
  const projection = speedProjectionForDocument(draft);
  const byId = new Map(draft.clips.map(clip => [clip.id, clip]));
  const entries = new Map(projection.entries.map(entry => [entry.ownerId, entry]));
  const mediaClips = draft.clips.filter(clip => clip.speed !== undefined);

  // All new placements must exist before evaluating shared roots. Audio roots
  // can appear after their descendants in the document's storage order.
  for (const clip of mediaClips) {
    const basis = clip.speed!;
    if (basis.kind === 'independent-audio') continue;
    const ownerId = basis.kind === 'main' ? clip.id : basis.providerId;
    const entry = entries.get(ownerId)!;
    clip.startFrame = entry.startFrame;
    clip.durationFrames = entry.endFrame - entry.startFrame;
    if (clip.durationFrames <= 0) {
      throw new SequenceError('INVALID_RANGE', '速度変更で主映像または原音の表示区間がなくなります', [clip.id]);
    }
  }
  for (const clip of mediaClips) {
    const basis = clip.speed!;
    if (basis.kind === 'independent-audio') continue;
    if (clip.content.kind !== 'video' && clip.content.kind !== 'audio') {
      throw new SequenceError('INVALID_DOCUMENT', '主映像または原音の種類が不正です', [clip.id]);
    }
    const ownerId = basis.kind === 'main' ? clip.id : basis.providerId;
    const rate = projection.rate(ownerId);
    let delta = 0, sourceStart = basis.source.sourceStart;
    if (basis.evaluationOwnerId) {
      const origin = byId.get(basis.evaluationOwnerId)!;
      const original = origin.speed!;
      if (original.kind === 'independent-audio') {
        throw new SequenceError('INVALID_DOCUMENT', '元時計の所有者が不正です', [clip.id]);
      }
      const rootId = original.kind === 'main' ? origin.id : original.providerId;
      delta = projection.evaluationDelta?.(ownerId) ?? (clip.startFrame - (original.evaluationSourceStart === undefined
        ? origin.startFrame : projection.rootStart(rootId)));
      sourceStart = addTime(original.evaluationSourceStart ?? original.source.sourceStart,
        divideTime(multiplyTime(rational(delta), rate), draft.speed!.fpsBasis));
    }
    clip.content.sourceIn = structuredClone(sourceStart);
    clip.content.rate = structuredClone(rate);
    clip.clock = clockAt(basis.clock, rate, delta);
    if (basis.keyframeClock && clip.visual) clip.visual.keyframeClock = clockAt(basis.keyframeClock, rate, delta);
  }
  return { speed: draft.speed!, projection, mediaClips };
}
