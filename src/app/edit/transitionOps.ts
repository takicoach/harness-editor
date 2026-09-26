import type { SceneTransition, SceneTransitionKind, SlideDirection } from '../../core/types';
import type { EditState } from './editState';

function upsert(
  state: EditState, at: 'head' | 'tail' | number,
  make: (existing: SceneTransition | undefined, id: number) => SceneTransition,
): EditState {
  const existing = state.sceneTransitions.find((t) => t.at === at);
  if (existing) {
    const updated = make(existing, existing.id);
    return { ...state, sceneTransitions: state.sceneTransitions.map((t) => (t.at === at ? updated : t)) };
  }
  const id = state.nextTransitionId;
  return {
    ...state,
    sceneTransitions: [...state.sceneTransitions, make(undefined, id)],
    nextTransitionId: id + 1,
  };
}

/** つなぎ目/頭尾に転換を設定（既存 at は差し替え）。 */
export function setSceneTransition(
  state: EditState, at: 'head' | 'tail' | number, kind: SceneTransitionKind,
  opts?: { durationFrames?: number; color?: string; direction?: SlideDirection },
): EditState {
  return upsert(state, at, (existing, id) => ({
    id: existing?.id ?? id,
    at,
    kind,
    // 非有限な durationFrames は無視して既存値（無ければ既定 15）を保つ。
    durationFrames: Math.max(2, Math.round(
      Number.isFinite(opts?.durationFrames) ? (opts?.durationFrames as number)
        : (existing?.durationFrames ?? 15),
    )),
    ...(kind === 'fadeColor' ? { color: opts?.color ?? existing?.color } : {}),
    ...((kind === 'slide' || kind === 'wipe')
      ? { direction: opts?.direction ?? existing?.direction ?? 'left' }
      : {}),
  }));
}

/** 指定 at の転換を消す。 */
export function clearSceneTransition(state: EditState, at: 'head' | 'tail' | number): EditState {
  if (!state.sceneTransitions.some((t) => t.at === at)) return state;
  return { ...state, sceneTransitions: state.sceneTransitions.filter((t) => t.at !== at) };
}

/** 長さを設定（最小 2・丸め）。不在 at はそのまま。 */
export function setSceneTransitionDuration(state: EditState, at: 'head' | 'tail' | number, frames: number): EditState {
  if (!Number.isFinite(frames)) return state;
  if (!state.sceneTransitions.some((t) => t.at === at)) return state;
  const d = Math.max(2, Math.round(frames));
  return { ...state, sceneTransitions: state.sceneTransitions.map((t) => (t.at === at ? { ...t, durationFrames: d } : t)) };
}

/** 色を設定（fadeColor 用）。不在 at はそのまま。 */
export function setSceneTransitionColor(state: EditState, at: 'head' | 'tail' | number, color: string): EditState {
  if (!state.sceneTransitions.some((t) => t.at === at)) return state;
  return { ...state, sceneTransitions: state.sceneTransitions.map((t) => (t.at === at ? { ...t, color } : t)) };
}

/** 方向を設定（slide/wipe 用）。不在 at はそのまま。 */
export function setSceneTransitionDirection(
  state: EditState, at: 'head' | 'tail' | number, direction: SlideDirection,
): EditState {
  if (!state.sceneTransitions.some((t) => t.at === at)) return state;
  return { ...state, sceneTransitions: state.sceneTransitions.map((t) => (t.at === at ? { ...t, direction } : t)) };
}

/** 全つなぎ目（join.atOriginal）へ転換を一括設定。頭尾は対象外。 */
export function applyTransitionToAllJoins(
  state: EditState, joins: Array<{ atOriginal: number }>, kind: SceneTransitionKind,
  opts?: { durationFrames?: number; color?: string; direction?: SlideDirection },
): EditState {
  let s = state;
  for (const j of joins) s = setSceneTransition(s, j.atOriginal, kind, opts);
  return s;
}

/** つなぎ目/頭尾を選択（インスペクタ表示用）。 */
export function selectJoin(state: EditState, at: 'head' | 'tail' | number): EditState {
  return { ...state, selection: { kind: 'join', at } };
}
