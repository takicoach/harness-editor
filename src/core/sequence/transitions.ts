import { SequenceError } from './errors';
import { clipEnd, sourceTimeAt, type SequenceClip, type SequenceDocument, type SequenceTransition, type TransitionKind } from './model';
import { compareTime, divideTime, multiplyTime, subtractTime, timeNumber } from './time';

/** Color fades cover one clip; they need no overlap and stay on the scene-fade path. */
export type OverlapTransitionKind = Exclude<TransitionKind, 'fadeBlack' | 'fadeWhite'>;

export function transitionJoinKey(trackId: string, outClipId: string, inClipId: string): string {
  return `join:${encodeURIComponent(trackId)}:${encodeURIComponent(outClipId)}:${encodeURIComponent(inClipId)}`;
}

/** Every gap-free video boundary, keyed exactly as sceneFadeTargetKey keys it. */
export function transitionJoins(doc: SequenceDocument): Array<{ joinKey: string; trackId: string; outClipId: string; inClipId: string; frame: number; label: string }> {
  return doc.tracks.filter(t => t.kind === 'visual').flatMap(track => {
    const videos = doc.clips.filter(c => c.trackId === track.id && c.content.kind === 'video').sort((a, b) => a.startFrame - b.startFrame);
    return videos.slice(1).flatMap((incoming, index) => {
      const out = videos[index]!;
      return clipEnd(out) === incoming.startFrame
        ? [{ joinKey: transitionJoinKey(track.id, out.id, incoming.id), trackId: track.id, outClipId: out.id, inClipId: incoming.id,
             frame: incoming.startFrame, label: `${out.name} → ${incoming.name}（${incoming.startFrame}fr）` }]
        : [];
    });
  });
}

export interface TransitionJoin { joinKey: string; trackId: string; outClipId: string; inClipId: string; frame: number; label: string }
/**
 * Every join a transition can be applied to or already sits on. `transitionJoins` only reports
 * gap-free boundaries, so a join that already carries an overlap disappears from it; add those
 * back (keyed the same way) so the UI can still offer to remove them.
 */
export function transitionJoinsForUi(doc: SequenceDocument): TransitionJoin[] {
  const open: TransitionJoin[] = transitionJoins(doc).map(item => ({ joinKey: item.joinKey, trackId: item.trackId, outClipId: item.outClipId,
    inClipId: item.inClipId, frame: item.frame, label: item.label }));
  const applied = doc.transitions.flatMap<TransitionJoin>(item => {
    if (item.joinKey === undefined || item.joinFrame === undefined || item.inClipId === undefined) return [];
    if (open.some(join => join.joinKey === item.joinKey)) return [];
    const out = doc.clips.find(clip => clip.id === item.outClipId), incoming = doc.clips.find(clip => clip.id === item.inClipId);
    if (!out || !incoming) return [];
    return [{ joinKey: item.joinKey, trackId: item.trackId, outClipId: item.outClipId, inClipId: item.inClipId, frame: item.joinFrame,
      label: `${out.name} → ${incoming.name}（${item.joinFrame}fr）` }];
  });
  const lane = (join: TransitionJoin) => { const index = doc.tracks.findIndex(track => track.id === join.trackId); return index < 0 ? doc.tracks.length : index; };
  return [...open, ...applied].sort((a, b) => lane(a) - lane(b) || a.frame - b.frame);
}

function resolve(doc: SequenceDocument, joinKey: string): { out: SequenceClip; incoming: SequenceClip; trackId: string; frame: number } {
  const join = transitionJoins(doc).find(item => item.joinKey === joinKey);
  const overlapped = doc.transitions.find(t => t.joinKey === joinKey);
  if (join) return { out: doc.clips.find(c => c.id === join.outClipId)!, incoming: doc.clips.find(c => c.id === join.inClipId)!, trackId: join.trackId, frame: join.frame };
  if (overlapped && overlapped.inClipId !== undefined && overlapped.joinFrame !== undefined) {
    const out = doc.clips.find(c => c.id === overlapped.outClipId), incoming = doc.clips.find(c => c.id === overlapped.inClipId);
    if (out && incoming) return { out, incoming, trackId: overlapped.trackId, frame: overlapped.joinFrame };
  }
  throw new SequenceError('MISSING_TARGET', '対象のつなぎ目が見つかりません', [joinKey]);
}

/** Frames of untouched source beyond each side of the join. */
export function transitionHandles(doc: SequenceDocument, joinKey: string): { outHandle: number; inHandle: number } {
  const { out, incoming } = resolve(doc, joinKey);
  const fps = doc.fps;
  const available = (clip: SequenceClip, edge: 'tail' | 'head'): number => {
    const content = clip.content;
    if (content.kind !== 'video') return 0;
    const stream = doc.assets.find(a => a.id === content.assetId)?.streams.find(s => s.index === content.streamIndex);
    if (edge === 'head') return Math.max(0, Math.floor(timeNumber(divideTime(multiplyTime(content.sourceIn, fps), content.rate))));
    if (!stream?.duration) return 0;
    const used = sourceTimeAt(clip, clipEnd(clip), fps);
    if (compareTime(used, stream.duration) >= 0) return 0;
    return Math.max(0, Math.floor(timeNumber(divideTime(multiplyTime(subtractTime(stream.duration, used), fps), content.rate))));
  };
  return { outHandle: available(out, 'tail'), inHandle: available(incoming, 'head') };
}

/**
 * Untouched-source room for display: `transitionHandles` plus whatever an existing overlap on
 * this join already holds (frames it borrowed from each clip get their own edge back, so a
 * replacement shows the same room `planTransition` would compute for it, not one shrunk by
 * double-counting the current overlap).
 */
export function transitionRoom(doc: SequenceDocument, joinKey: string): { outHandle: number; inHandle: number } {
  const { heldAfter, heldBefore } = heldByOverlap(doc, joinKey);
  const handles = transitionHandles(doc, joinKey);
  return { outHandle: handles.outHandle + heldAfter, inHandle: handles.inHandle + heldBefore };
}

/**
 * T27 Minor: 既存の重なりが両クリップから借りている尺（置き換え時に戻ってくる分）。
 * transitionRoom（表示用）と planTransition（計画）が同じ式を 2 本持っていて、しかも
 * 「どれを既存の重なりとみなすか」の条件だけが違っていた。重なりを持つのは inClipId を
 * 持つ転換だけ（シーンフェードは尺を借りていない）なので、そちらに揃えて 1 本にする。
 */
function heldByOverlap(doc: SequenceDocument, joinKey: string): { heldAfter: number; heldBefore: number } {
  const { out, incoming, frame } = resolve(doc, joinKey);
  const current = doc.transitions.find(t => t.joinKey === joinKey && t.inClipId !== undefined);
  return { heldAfter: current ? clipEnd(out) - frame : 0, heldBefore: current ? frame - incoming.startFrame : 0 };
}

/**
 * Split the requested overlap across the join. The sequence length never changes:
 * the outgoing clip grows forward into its tail handle, the incoming clip grows
 * backward into its head handle, and nothing else moves.
 */
export function planTransition(doc: SequenceDocument, joinKey: string, kind: OverlapTransitionKind, durationFrames: number):
  { transition: Omit<SequenceTransition, 'id'>; clamped: boolean; before: number; after: number }
  | { error: 'NO_HANDLES' | 'CLIPS_TOO_SHORT' } {
  if (!Number.isSafeInteger(durationFrames) || durationFrames < 2) throw new SequenceError('INVALID_RANGE', '転換の長さは2フレーム以上で指定してください');
  const { out, incoming, trackId, frame } = resolve(doc, joinKey);
  const current = doc.transitions.find(t => t.joinKey === joinKey);
  // Replacing: measure the released shape. The overlap already in place shortened
  // both handles and both durations, so counting it twice shrinks the new plan.
  const { heldAfter, heldBefore } = heldByOverlap(doc, joinKey);
  const handles = transitionHandles(doc, joinKey);
  const outHandle = handles.outHandle + heldAfter, inHandle = handles.inHandle + heldBefore;
  const outDuration = frame - out.startFrame, inDuration = clipEnd(incoming) - frame;
  /** Overlap a neighbouring transition already spends at the far edge of this clip. */
  const spent = (clipId: string, edge: 'head' | 'tail'): number => doc.transitions
    .filter(t => t.id !== current?.id && t.inClipId !== undefined && (edge === 'head' ? t.inClipId === clipId : t.outClipId === clipId))
    .reduce((most, t) => Math.max(most, t.durationFrames), 0);
  // validate.ts requires the incoming clip to start no earlier than the outgoing
  // one and to end no earlier; each side is capped on its own, never by the sum.
  const beforeCap = Math.max(0, Math.min(inHandle, outDuration - 1 - spent(out.id, 'head')));
  const afterCap = Math.max(0, Math.min(outHandle, inDuration - 1 - spent(incoming.id, 'tail')));
  const capacity = beforeCap + afterCap;
  if (capacity <= 0) return { error: outHandle + inHandle <= 0 ? 'NO_HANDLES' : 'CLIPS_TOO_SHORT' };
  const total = Math.min(durationFrames, capacity);
  let after = Math.min(afterCap, Math.ceil(total / 2));
  const before = Math.min(beforeCap, total - after);
  after = Math.min(afterCap, total - before);
  return { clamped: total < durationFrames, before, after,
    transition: { trackId, outClipId: out.id, inClipId: incoming.id, kind,
      startFrame: frame - before, durationFrames: before + after, audioCurve: 'linear', joinKey, joinFrame: frame } };
}
