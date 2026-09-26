import { normalizeCutRegions } from '../../core/cutEngine';
import { buildCutOrdering, cutOrderingOf } from '../../core/cutOrder';
import { computeJoins, resolveSceneTransitions } from '../../core/joinEngine';
import { hasPerSegmentSpeed, playbackToSpeed, resolveSpeedSegments, speedScale, speedTotalFrames } from '../../core/speedEngine';
import { buildOverlaps, isOverlapKind } from '../../core/transitionEngine';
import type { PlaybackOverlap } from '../../core/transitionEngine';
import type { CutOrderAnchor, CutOrdering, CutRegion, CutSegment, SceneTransition } from '../../core/types';
import type { EditState } from './editState';

const DELETE_ALL_REASON = '動画をすべて削除することはできません。少なくとも1つの映像区間を残してください。';
const SPLIT_TRANSITION_REASON = 'この位置で分割すると場面転換の長さが変わります。転換から離れた位置で分割するか、仕上げで転換を調整してください。';
const SPLIT_SPEED_REASON = 'この位置で分割すると速度の丸めにより動画の長さが変わります。1フレームずらして分割してください。';

function anchorsOf(segments: readonly CutSegment[]): CutOrderAnchor[] {
  return segments.map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd }));
}

function contains(container: CutSegment, child: CutSegment): boolean {
  return child.originalStart >= container.originalStart && child.originalEnd <= container.originalEnd;
}

function remapBySource<T>(
  values: Record<number, T>,
  before: readonly CutSegment[],
  after: readonly CutSegment[],
): Record<number, T> {
  const result: Record<number, T> = {};
  for (const target of after) {
    const source = before.find(segment => contains(segment, target));
    if (source === undefined) continue;
    const value = values[source.id];
    if (value !== undefined) result[target.id] = value;
  }
  return result;
}

interface SegmentJoin {
  left: CutSegment;
  right: CutSegment;
}

function joinsOf(segments: readonly CutSegment[]): SegmentJoin[] {
  return segments.slice(0, -1).map((left, index) => ({ left, right: segments[index + 1]! }));
}

/** Numeric transitions follow the same directed pair of source clips, never just a reused frame number. */
function remapTransitions(
  transitions: readonly SceneTransition[],
  before: readonly CutSegment[],
  after: readonly CutSegment[],
): SceneTransition[] {
  const oldJoins = joinsOf(before);
  const newJoins = joinsOf(after);
  const result: SceneTransition[] = [];
  const used = new Set<number>();
  for (const transition of transitions) {
    if (typeof transition.at !== 'number') {
      result.push(transition);
      continue;
    }
    const old = oldJoins.find(join => join.left.originalEnd === transition.at);
    if (old === undefined) continue;
    const matches = newJoins.filter(join => contains(old.left, join.left) && contains(old.right, join.right));
    if (matches.length !== 1) continue;
    const at = matches[0]!.left.originalEnd;
    if (used.has(at)) continue;
    used.add(at);
    result.push({ ...transition, at });
  }
  return result;
}

function totalFramesOf(state: EditState): number | null {
  const total = state.originalTotalFrames;
  return Number.isInteger(total) && (total ?? 0) > 0 ? total! : null;
}

function normalizedRequestedRanges(totalFrames: number, ranges: readonly CutRegion[]): CutRegion[] {
  return normalizeCutRegions(ranges.flatMap(range => {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return [];
    const start = Math.max(0, Math.min(totalFrames, Math.round(range.start)));
    const end = Math.max(0, Math.min(totalFrames, Math.round(range.end)));
    return start < end ? [{ start, end }] : [];
  }));
}

function sameRegions(a: readonly CutRegion[], b: readonly CutRegion[]): boolean {
  return a.length === b.length && a.every((region, index) => {
    const other = b[index];
    return other !== undefined && region.start === other.start && region.end === other.end;
  });
}

interface SplitPlan {
  before: CutOrdering;
  after: CutOrdering;
  provisional: EditState;
  right: CutSegment;
}

function planSplit(state: EditState, originalFrame: number): SplitPlan | null {
  if (!Number.isFinite(originalFrame)) return null;
  const frame = Math.round(originalFrame);
  const before = cutOrderingOf(state);
  const index = before.segments.findIndex(segment => frame > segment.originalStart && frame < segment.originalEnd);
  if (index < 0) return null;
  const source = before.segments[index]!;
  const anchors = anchorsOf(before.segments);
  anchors.splice(index, 1,
    { originalStart: source.originalStart, originalEnd: frame },
    { originalStart: frame, originalEnd: source.originalEnd });
  const provisional: EditState = { ...state, cutOrder: anchors };
  const after = cutOrderingOf(provisional);
  const right = after.segments.find(segment => segment.originalStart === frame && segment.originalEnd === source.originalEnd);
  return right === undefined ? null : { before, after, provisional, right };
}

function playbackOverlaps(state: EditState, ordering: CutOrdering): PlaybackOverlap[] {
  const totalFrames = totalFramesOf(state);
  if (totalFrames === null) return [];
  const joins = computeJoins(totalFrames, state.cutRegions, ordering);
  const transitions = resolveSceneTransitions(state.sceneTransitions, joins)
    .map(({ transition, playbackFrame }) => ({ ...transition, at: playbackFrame }));
  return buildOverlaps(transitions, ordering.segments);
}

/** Mirrors buildPlaybackModel's current speed projection using only edit-state facts. */
function effectiveOverlaps(state: EditState, ordering: CutOrdering, overlaps: PlaybackOverlap[]): PlaybackOverlap[] {
  if (hasPerSegmentSpeed(state.segmentSpeeds, state.mainSpeed)) {
    const speeds = resolveSpeedSegments(ordering.segments, state.mainSpeed, state.segmentSpeeds);
    return overlaps.map(overlap => ({
      boundary: playbackToSpeed(overlap.boundary, speeds),
      overlap: playbackToSpeed(overlap.overlap, speeds),
    }));
  }
  return overlaps.map(overlap => ({
    boundary: speedScale(overlap.boundary, state.mainSpeed),
    overlap: speedScale(overlap.overlap, state.mainSpeed),
  }));
}

function sameOverlaps(a: readonly PlaybackOverlap[], b: readonly PlaybackOverlap[]): boolean {
  return a.length === b.length && a.every((overlap, index) => {
    const other = b[index];
    return other !== undefined && overlap.boundary === other.boundary && overlap.overlap === other.overlap;
  });
}

/** Returns a reason only when an otherwise valid split would change a visible overlap transition. */
export function mainClipSplitBlockedReason(state: EditState, originalFrame: number): string | null {
  const hasSegmentSpeed = hasPerSegmentSpeed(state.segmentSpeeds, state.mainSpeed);
  const hasOverlapTransition = state.sceneTransitions.some(
    transition => typeof transition.at === 'number' && isOverlapKind(transition.kind),
  );
  if (!hasSegmentSpeed && !hasOverlapTransition) return null;
  const plan = planSplit(state, originalFrame);
  if (plan === null) return null;
  const prospective: EditState = {
    ...plan.provisional,
    segmentSpeeds: remapBySource(state.segmentSpeeds, plan.before.segments, plan.after.segments),
    sceneTransitions: remapTransitions(state.sceneTransitions, plan.before.segments, plan.after.segments),
  };
  const before = playbackOverlaps(state, plan.before);
  const after = playbackOverlaps(prospective, plan.after);
  const overlapsUnchanged = sameOverlaps(before, after) && sameOverlaps(
    effectiveOverlaps(state, plan.before, before),
    effectiveOverlaps(prospective, plan.after, after),
  );
  if (!overlapsUnchanged) return SPLIT_TRANSITION_REASON;
  if (hasSegmentSpeed) {
    const beforeDuration = speedTotalFrames(resolveSpeedSegments(
      plan.before.segments,
      state.mainSpeed,
      state.segmentSpeeds,
    ));
    const afterDuration = speedTotalFrames(resolveSpeedSegments(
      plan.after.segments,
      prospective.mainSpeed,
      prospective.segmentSpeeds,
    ));
    if (beforeDuration !== afterDuration) return SPLIT_SPEED_REASON;
  }
  return null;
}

/**
 * Splits the kept main-video clip containing originalFrame. The explicit adjacent
 * anchors make the edit persist even though no source frames are removed.
 */
export function splitMainClip(state: EditState, originalFrame: number): EditState {
  const plan = planSplit(state, originalFrame);
  if (plan === null || mainClipSplitBlockedReason(state, originalFrame) !== null) return state;
  const before = plan.before.segments;
  const after = plan.after.segments;
  return {
    ...plan.provisional,
    segmentSpeeds: remapBySource(state.segmentSpeeds, before, after),
    segmentLayouts: remapBySource(state.segmentLayouts, before, after),
    sceneTransitions: remapTransitions(state.sceneTransitions, before, after),
    selection: { kind: 'cutSegment', id: plan.right.id },
    multiTelopIds: [],
  };
}

/** Returns the user-facing reason only when deleting this clip would remove every video frame. */
export function mainClipDeleteBlockedReason(state: EditState, segmentId: number): string | null {
  const segments = cutOrderingOf(state).segments;
  return segments.length === 1 && segments[0]!.id === segmentId ? DELETE_ALL_REASON : null;
}

/** Deletes one completed-order clip by adding its whole source range to the ripple cut. */
export function deleteMainClip(state: EditState, segmentId: number): EditState {
  const segment = cutOrderingOf(state).segments.find(item => item.id === segmentId);
  if (segment === undefined || mainClipDeleteBlockedReason(state, segmentId) !== null) return state;
  return cutMainSourceRanges(state, [{ start: segment.originalStart, end: segment.originalEnd }]);
}

/**
 * Adds several source ranges to the main-video cut in one immutable state update.
 * Remaining clips retain playback order and source-bound settings. An all-video
 * cut is rejected because the current editor and exporter require one kept clip.
 */
export function cutMainSourceRanges(state: EditState, ranges: CutRegion[]): EditState {
  const totalFrames = totalFramesOf(state);
  if (totalFrames === null || ranges.length === 0) return state;
  const requested = normalizedRequestedRanges(totalFrames, ranges);
  if (requested.length === 0) return state;
  const current = normalizeCutRegions(state.cutRegions);
  const cutRegions = normalizeCutRegions([...current, ...requested]);
  if (sameRegions(current, cutRegions)) return state;

  const before = cutOrderingOf(state).segments;
  const after = buildCutOrdering(totalFrames, cutRegions, anchorsOf(before)).segments;
  if (after.length === 0) return state;

  return {
    ...state,
    cutRegions,
    cutOrder: anchorsOf(after),
    segmentSpeeds: remapBySource(state.segmentSpeeds, before, after),
    segmentLayouts: remapBySource(state.segmentLayouts, before, after),
    sceneTransitions: remapTransitions(state.sceneTransitions, before, after),
    selection: null,
    multiTelopIds: [],
  };
}

/** A clip may recover adjacent removed footage, but may not consume another clip. */
export function mainClipTrimBounds(state: EditState, id: number) {
  const segments = cutOrderingOf(state).segments;
  const clip = segments.find(s => s.id === id);
  if (!clip) return null;
  const others = segments.filter(s => s.id !== id);
  const min = Math.max(0, ...others.filter(s => s.originalEnd <= clip.originalStart).map(s => s.originalEnd));
  const max = Math.min(state.originalTotalFrames ?? clip.originalEnd, ...others.filter(s => s.originalStart >= clip.originalEnd).map(s => s.originalStart));
  return { clip, min, max };
}

export function trimMainClip(state: EditState, id: number, start: number, end: number): EditState {
  const bounds = mainClipTrimBounds(state, id), total = totalFramesOf(state);
  if (!bounds || total === null || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < bounds.min || end > bounds.max || end <= start) return state;
  if (start === bounds.clip.originalStart && end === bounds.clip.originalEnd) return state;
  const before = cutOrderingOf(state).segments;
  const anchors = before.map(s => s.id === id ? { originalStart: start, originalEnd: end } : { originalStart: s.originalStart, originalEnd: s.originalEnd });
  const sorted = [...anchors].sort((a, b) => a.originalStart - b.originalStart);
  const cutRegions: CutRegion[] = [];
  let cursor = 0;
  for (const a of sorted) { if (a.originalStart > cursor) cutRegions.push({ start: cursor, end: a.originalStart }); cursor = a.originalEnd; }
  if (cursor < total) cutRegions.push({ start: cursor, end: total });
  const after = buildCutOrdering(total, cutRegions, anchors).segments;
  const mapping = new Map(before.map((s, i) => [s.id, after.find(a => a.originalStart === anchors[i]!.originalStart && a.originalEnd === anchors[i]!.originalEnd)]));
  if ([...mapping.values()].some(s => !s)) return state;
  const remap = <T,>(values: Record<number, T>): Record<number, T> => Object.fromEntries(before.flatMap(s => values[s.id] === undefined ? [] : [[mapping.get(s.id)!.id, values[s.id]!]]));
  const sceneTransitions = state.sceneTransitions.flatMap(t => {
    if (typeof t.at !== 'number') return [t];
    const index = before.findIndex(s => s.originalEnd === t.at);
    if (index < 0 || index === before.length - 1) return [];
    return [{ ...t, at: mapping.get(before[index]!.id)!.originalEnd }];
  });
  return { ...state, cutRegions, cutOrder: anchors, segmentSpeeds: remap(state.segmentSpeeds), segmentLayouts: remap(state.segmentLayouts), sceneTransitions,
    selection: { kind: 'cutSegment', id: mapping.get(id)!.id }, multiTelopIds: [] };
}
