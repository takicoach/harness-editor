import { cutOrderingOf } from '../../core/cutOrder';
import type { CutSegment } from '../../core/types';
import type { EditState } from './editState';

function segmentKey(segment: Pick<CutSegment, 'originalStart' | 'originalEnd'>): string {
  return `${segment.originalStart}:${segment.originalEnd}`;
}

function remapBySegment<T>(
  values: Record<number, T>,
  before: readonly CutSegment[],
  after: readonly CutSegment[],
): Record<number, T> {
  const oldIdByKey = new Map(before.map((segment) => [segmentKey(segment), segment.id]));
  const out: Record<number, T> = {};
  for (const segment of after) {
    const oldId = oldIdByKey.get(segmentKey(segment));
    if (oldId === undefined) continue;
    const value = values[oldId];
    if (value !== undefined) out[segment.id] = value;
  }
  return out;
}

/**
 * 完成順の区間を移動する。cutRegions自体は変えず、再生順アンカーと区間IDに
 * 結び付く速度・レイアウト・選択を同じ素材へ追随させる。
 */
export function moveCutSegment(state: EditState, segmentId: number, targetIndex: number): EditState {
  const before = cutOrderingOf(state).segments;
  const from = before.findIndex((segment) => segment.id === segmentId);
  if (from < 0 || before.length < 2) return state;
  const to = Math.max(0, Math.min(before.length - 1, targetIndex));
  if (from === to) return state;

  const reordered = [...before];
  const [moved] = reordered.splice(from, 1);
  if (moved === undefined) return state;
  reordered.splice(to, 0, moved);
  const anchors = reordered.map(({ originalStart, originalEnd }) => ({ originalStart, originalEnd }));

  // 新アンカーから実際に採番されるIDを確定してから、区間固有値を移す。
  const provisional: EditState = { ...state, cutOrder: anchors };
  const after = cutOrderingOf(provisional).segments;
  const selection = state.selection;
  const selectedBefore = selection?.kind === 'cutSegment'
    ? before.find((segment) => segment.id === selection.id)
    : undefined;
  const selectedAfter = selectedBefore === undefined
    ? undefined
    : after.find((segment) => segmentKey(segment) === segmentKey(selectedBefore));

  return {
    ...provisional,
    segmentSpeeds: remapBySegment(state.segmentSpeeds, before, after),
    segmentLayouts: remapBySegment(state.segmentLayouts, before, after),
    selection: selectedAfter === undefined ? state.selection : { kind: 'cutSegment', id: selectedAfter.id },
  };
}
