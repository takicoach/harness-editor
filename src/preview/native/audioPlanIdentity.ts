import type { SequenceDocument } from '../../core/sequence/model';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]));
}

/** Conservative identity of the immutable inputs consumed by ScenePlan.audioGain
 * and the native PCM mixer. Visual edits may retain a running audio clock; timing,
 * source, mute/track, fade, transition and ducking changes must rebuild it.
 * Keep silent clips too: a later unmute/enabled-track change must be detected. */
export function audioPlanIdentity(document: SequenceDocument): string {
  const clips = document.clips.filter(clip => clip.content.kind === 'audio')
    .map(({ visual: _visual, ...clip }) => clip);
  const clipIds = new Set(clips.map(clip => clip.id)), trackIds = new Set(clips.map(clip => clip.trackId));
  const assetIds = new Set(clips.flatMap(clip => clip.content.kind === 'audio' ? [clip.content.assetId] : []));
  return JSON.stringify(canonical({
    fps: document.fps, sequenceEndFrame: document.sequenceEndFrame, clips,
    tracks: document.tracks.filter(track => trackIds.has(track.id)).map(({ id, kind, enabled }) => ({ id, kind, enabled })),
    assets: document.assets.filter(asset => assetIds.has(asset.id)),
    // An unspecified audioCurve also applies in ScenePlan.audioGain.
    transitions: document.transitions.filter(transition => transition.audioCurve !== 'none'
      && (clipIds.has(transition.outClipId) || (transition.inClipId !== undefined && clipIds.has(transition.inClipId)))),
    transcripts: document.transcripts, ducking: document.ducking,
  }));
}
