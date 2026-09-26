import { SequenceError } from './errors';
import { clipEnd, sourceTimeAt, type SequenceDocument, type SequenceClip } from './model';
import { compareTime, rational, type Rational } from './time';

export interface AudioSourceSupport { start: Rational; end: Rational }
export type AudioSourceBinding = 'ordinary' | 'main-audio' | 'independent-audio' | 'insert-own';
export interface AudioSourceRegion extends AudioSourceSupport {
  kind: 'finite' | 'loop';
  assetId: string;
  assetFingerprint: string;
  streamIndex: number;
  rate: Rational;
  lineageId: string;
  binding: AudioSourceBinding;
  /** Requested union intersected with the stream's physical extent. */
  physical: AudioSourceSupport | null;
  clipIds: string[];
  /** Sharing identity; unlike pcmKey, this includes explicit provenance. */
  regionKey: string;
  /** Content descriptor only. The consumer must also key DSP/resampler versions/configuration. */
  pcmKey: string;
}
export interface AudioSourceClipSupport {
  clipId: string;
  regionKey: string | null;
  /** Evaluation clock origin, including loop phase; never replaces requested intent. */
  sourceIn: Rational;
  /** Requested source intent, NOT a per-clip PCM adoption gate. With rounded
   * placement, evaluation sourceIn can precede this start. Consumers use the
   * shared region's physical bounds plus the clip evaluation clock/timeline. */
  support: AudioSourceSupport;
}
export interface AudioSourceRegionPlan { regions: AudioSourceRegion[]; clips: AudioSourceClipSupport[] }

const canonical = (time: Rational): Rational => rational(time.num, time.den);
const pair = (time: Rational) => [time.num, time.den];
const max = (a: Rational, b: Rational) => compareTime(a, b) >= 0 ? a : b;
const min = (a: Rational, b: Rational) => compareTime(a, b) <= 0 ? a : b;
const tuple = (range: AudioSourceSupport) => [pair(range.start), pair(range.end)];
const textOrder = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
interface Piece {
  clip: SequenceClip;
  adoption: AudioSourceClipSupport;
  group: string;
  region: Omit<AudioSourceRegion, 'physical' | 'clipIds' | 'regionKey' | 'pcmKey'>;
  duration: Rational;
  sampleRate?: number;
  channels?: number;
  codec: string;
}

/**
 * Plans validated documents without modifying them or deriving historical lineage.
 * Timeline placement, gain, mute and fade are consumer concerns; even disabled audio
 * participates so those edits do not change the source region's processing boundary.
 */
export function planAudioSourceRegions(doc: SequenceDocument): AudioSourceRegionPlan {
  const assets = new Map(doc.assets.map(asset => [asset.id, asset]));
  const pieces: Piece[] = [];
  const clips: AudioSourceClipSupport[] = [];
  for (const clip of doc.clips) {
    const content = clip.content;
    if (content.kind !== 'audio') continue;
    const asset = assets.get(content.assetId);
    const stream = asset?.streams.find(s => s.index === content.streamIndex && s.kind === 'audio');
    if (!asset || asset.kind !== 'media' || !stream) {
      throw new SequenceError('BROKEN_REFERENCE', '音声の素材ストリームがありません', [clip.id]);
    }
    const rate = canonical(content.rate), duration = canonical(stream.duration);
    if (compareTime(rate, rational(0)) <= 0 || compareTime(duration, rational(0)) <= 0) {
      throw new SequenceError('INVALID_RANGE', '音声の速度・素材長が不正です', [clip.id]);
    }
    const metadata = clip.speed;
    if (metadata && metadata.kind !== 'main-audio' && metadata.kind !== 'independent-audio') {
      throw new SequenceError('INVALID_DOCUMENT', '音声の速度所有者が不正です', [clip.id]);
    }
    if (metadata && (metadata.source.assetId !== asset.id || metadata.source.streamIndex !== stream.index)) {
      throw new SequenceError('BROKEN_REFERENCE', '音声の保存素材基準がストリームと一致しません', [clip.id]);
    }
    const binding = clip.insertOwnSpeed?'insert-own':metadata?.kind ?? 'ordinary';
    const lineageId = clip.continuationGroupId ?? clip.id;
    let start: Rational, end: Rational;
    if (content.loop) {
      start = rational(0); end = duration;
    } else if (clip.insertOwnSpeed) {
      start=canonical(clip.insertOwnSpeed.source.sourceStart);end=canonical(clip.insertOwnSpeed.source.sourceEnd);
    } else if (metadata) {
      start = canonical(metadata.source.sourceStart); end = canonical(metadata.source.sourceEnd);
    } else {
      start = min(duration, max(rational(0), canonical(content.sourceIn)));
      end = min(duration, max(rational(0), sourceTimeAt(clip, clipEnd(clip), doc.fps)));
    }
    if (compareTime(start, end) > 0) throw new SequenceError('INVALID_RANGE', '音声の素材区間が逆転しています', [clip.id]);
    const adoption: AudioSourceClipSupport = {
      clipId: clip.id, regionKey: null, sourceIn: canonical(content.sourceIn), support: { start, end },
    };
    clips.push(adoption);
    if (compareTime(start, end) === 0) continue;
    const kind = content.loop ? 'loop' : 'finite';
    const group = JSON.stringify([lineageId, binding, asset.id, stream.index, pair(rate), kind]);
    pieces.push({ clip, adoption, group, duration, sampleRate: stream.sampleRate, channels: stream.channels, codec: stream.codec,
      region: { kind, assetId: asset.id, assetFingerprint: asset.fingerprint, streamIndex: stream.index, rate, start, end, lineageId, binding } });
  }
  // Ordering is source-based, never the live timeline order or fragment creation order.
  pieces.sort((a, b) => textOrder(a.group, b.group) || compareTime(a.region.start, b.region.start)
    || compareTime(a.region.end, b.region.end) || textOrder(a.clip.id, b.clip.id));
  const regions: AudioSourceRegion[] = [];
  let pending: Piece[] = [], end: Rational | undefined;
  const finish = () => {
    if (!pending.length) return;
    const first = pending[0]!;
    const region = { ...first.region, end: end! };
    const physicalStart = max(rational(0), region.start), physicalEnd = min(first.duration, region.end);
    const physical = compareTime(physicalStart, physicalEnd) < 0 ? { start: physicalStart, end: physicalEnd } : null;
    const pcmKey = `audio-source-pcm-v1:${JSON.stringify([region.assetFingerprint, region.streamIndex,
      first.codec, first.sampleRate ?? null, first.channels ?? null, pair(first.duration), pair(region.rate), region.kind,
      tuple(region), physical === null ? null : tuple(physical)])}`;
    const regionKey = `audio-source-sharing-v1:${JSON.stringify([first.group, tuple(region)])}`;
    regions.push({ ...region, physical, pcmKey, regionKey, clipIds: pending.map(p => p.clip.id).sort(textOrder) });
    for (const piece of pending) piece.adoption.regionKey = regionKey;
    pending = []; end = undefined;
  };
  for (const piece of pieces) {
    if (pending.length && (piece.group !== pending[0]!.group || compareTime(piece.region.start, end!) > 0)) finish();
    pending.push(piece); end = end ? max(end, piece.region.end) : piece.region.end;
  }
  finish();
  return { regions, clips };
}
