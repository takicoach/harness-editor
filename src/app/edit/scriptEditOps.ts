import { cutOrderingOf } from '../../core/cutOrder';
import { validateScriptEditArtifact, type ScriptEditArtifact } from '../../core/scriptEditArtifact';
import {
  resolveScriptEditPlan,
  type ScriptEditModification,
} from '../../core/scriptEditModification';
import type { CutSegment, SceneTransition, SegmentLayout } from '../../core/types';
import type { EditState, Selection } from './editState';
import { setTelopText } from './textOps';

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((value, index) => sameValue(value, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  return aKeys.length === bKeys.length
    && aKeys.every((key, index) => key === bKeys[index] && sameValue(aRecord[key], bRecord[key]));
}

function assertCurrent(state: EditState, artifact: ScriptEditArtifact): void {
  const expected = artifact.input.editing;
  const telops = state.telops.map(({ id, text, originalStart, originalEnd }) => ({ id, text, originalStart, originalEnd }));
  const cuts = state.cutRegions.map(({ start, end }) => ({ start, end }));
  const order = (state.cutOrder ?? []).map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd }));
  if (!sameValue(state.scriptDocument, artifact.input.alignment.packet.script)
    || !sameValue(telops, expected.telops)
    || !sameValue(cuts, expected.cutRegions)
    || !sameValue(order, expected.cutOrder)
    || state.originalTotalFrames !== expected.totalFrames) {
    throw new Error('STALE_SCRIPT_EDIT: current script, captions, cuts, order, or source duration differs from the proposal input');
  }
}

function overlaps(a: CutSegment, b: CutSegment): boolean {
  return Math.max(a.originalStart, b.originalStart) < Math.min(a.originalEnd, b.originalEnd);
}

function contains(container: CutSegment, child: CutSegment): boolean {
  return child.originalStart >= container.originalStart && child.originalEnd <= container.originalEnd;
}

function sameLayout(a: SegmentLayout, b: SegmentLayout): boolean {
  return a.position.x === b.position.x
    && a.position.y === b.position.y
    && a.scale === b.scale
    && (a.rotation ?? 0) === (b.rotation ?? 0)
    && !!a.flipH === !!b.flipH
    && !!a.flipV === !!b.flipV
    && sameValue(a.motion, b.motion);
}

/**
 * A resulting clip may cover several old clips (or source that used to be cut).
 * Carry a setting only when its value is homogeneous across the entire resulting
 * source range. Otherwise applying either value would silently change part of the
 * source, so the proposal must be reviewed after resolving the conflict.
 */
function remapSettings<T>(
  values: Record<number, T>,
  before: readonly CutSegment[],
  after: readonly CutSegment[],
  equal: (a: T, b: T) => boolean,
  errorCode: string,
): Record<number, T> {
  const sourceOrder = [...before].sort((a, b) => a.originalStart - b.originalStart);
  const result: Record<number, T> = {};
  for (const target of after) {
    const parts: Array<T | undefined> = [];
    let cursor = target.originalStart;
    for (const source of sourceOrder) {
      const start = Math.max(target.originalStart, source.originalStart);
      const end = Math.min(target.originalEnd, source.originalEnd);
      if (end <= start) continue;
      if (cursor < start) parts.push(undefined);
      parts.push(values[source.id]);
      cursor = Math.max(cursor, end);
    }
    if (cursor < target.originalEnd) parts.push(undefined);
    const first = parts[0];
    const homogeneous = parts.every(value => first === undefined
      ? value === undefined
      : value !== undefined && equal(first, value));
    if (!homogeneous) {
      throw new Error(`${errorCode}: differently configured source clips cannot be fused into one clip`);
    }
    if (first !== undefined) result[target.id] = first;
  }
  return result;
}

interface SegmentJoin {
  left: CutSegment;
  right: CutSegment;
}

function segmentJoins(segments: readonly CutSegment[]): SegmentJoin[] {
  return segments.slice(0, -1).map((left, index) => ({ left, right: segments[index + 1]! }));
}

function createJoinMapper(before: readonly CutSegment[], after: readonly CutSegment[]) {
  const beforeJoins = segmentJoins(before);
  const afterJoins = segmentJoins(after);
  return (at: number): number | null => {
    const old = beforeJoins.filter(join => join.left.originalEnd === at);
    if (old.length !== 1) {
      throw new Error('SCRIPT_EDIT_TRANSITION_CONFLICT: numeric transition does not identify one current source join');
    }
    const matches = afterJoins.filter(join => contains(old[0]!.left, join.left) && contains(old[0]!.right, join.right));
    if (matches.length > 1) {
      throw new Error('SCRIPT_EDIT_TRANSITION_CONFLICT: one source join maps to several resulting joins');
    }
    return matches[0]?.left.originalEnd ?? null;
  };
}

function remapTransitions(
  transitions: readonly SceneTransition[],
  mapJoin: (at: number) => number | null,
): SceneTransition[] {
  const result: SceneTransition[] = [];
  const numericTargets = new Set<number>();
  for (const transition of transitions) {
    if (typeof transition.at !== 'number') {
      result.push(transition);
      continue;
    }
    const at = mapJoin(transition.at);
    if (at === null) continue;
    if (numericTargets.has(at)) {
      throw new Error('SCRIPT_EDIT_TRANSITION_CONFLICT: several transitions map to one resulting join');
    }
    numericTargets.add(at);
    result.push({ ...transition, at });
  }
  return result;
}

function remapSelection(
  selection: Selection | null,
  before: readonly CutSegment[],
  after: readonly CutSegment[],
  mapJoin: (at: number) => number | null,
): Selection | null {
  if (selection?.kind === 'cutSegment') {
    const source = before.find(segment => segment.id === selection.id);
    if (source === undefined) return null;
    const matches = after.filter(segment => overlaps(source, segment));
    return matches.length === 1 ? { kind: 'cutSegment', id: matches[0]!.id } : null;
  }
  if (selection?.kind === 'join' && typeof selection.at === 'number') {
    const at = mapJoin(selection.at);
    return at === null ? null : { kind: 'join', at };
  }
  return selection;
}

/**
 * Applies one already reviewed script-edit artifact as a single pure state change.
 * Every validation and remapping conflict is resolved before a new state is
 * returned, so callers can place the result in one EditSession/Undo entry.
 */
export function applyScriptEditArtifact(
  state: EditState,
  artifactValue: ScriptEditArtifact,
  modification?: ScriptEditModification,
): EditState {
  const artifact = validateScriptEditArtifact(artifactValue);
  if(artifact.input.native)throw new Error('NATIVE_SCRIPT_REQUIRED: 新形式の台本案は独自編集で反映してください');
  assertCurrent(state, artifact);
  const plan = resolveScriptEditPlan(artifact, modification);

  if (plan.kind === 'caption') {
    return plan.changes.reduce(
      (current, change) => setTelopText(current, change.telopId, change.after),
      state,
    );
  }

  const before = cutOrderingOf(state).segments;
  const provisional: EditState = {
    ...state,
    cutRegions: plan.cutRegions.map(region => ({ ...region })),
    cutOrder: plan.cutOrder.map(anchor => ({ ...anchor })),
  };
  const after = cutOrderingOf(provisional).segments;
  const segmentSpeeds = remapSettings(
    state.segmentSpeeds,
    before,
    after,
    (a, b) => a === b,
    'SCRIPT_EDIT_SEGMENT_SPEED_CONFLICT',
  );
  const segmentLayouts = remapSettings(
    state.segmentLayouts,
    before,
    after,
    sameLayout,
    'SCRIPT_EDIT_SEGMENT_LAYOUT_CONFLICT',
  );
  const mapJoin = createJoinMapper(before, after);
  const sceneTransitions = remapTransitions(state.sceneTransitions, mapJoin);
  const selection = remapSelection(state.selection, before, after, mapJoin);

  return { ...provisional, segmentSpeeds, segmentLayouts, sceneTransitions, selection };
}
