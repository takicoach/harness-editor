import { DEFAULT_MAIN_LAYOUT, clampLayoutPos, clampLayoutScale, clampRotation } from '../../core/mainLayout';
import type { SegmentLayout } from '../../core/types';
import type { EditState } from './editState';

/** 区間 id の現在の上書き(無ければ全体ベースを背景抜きで種にする)。 */
function seed(state: EditState, id: number): SegmentLayout {
  const existing = state.segmentLayouts[id];
  if (existing !== undefined) return existing;
  const base = state.mainLayout ?? DEFAULT_MAIN_LAYOUT;
  return {
    position: { x: base.position.x, y: base.position.y },
    scale: base.scale,
    rotation: base.rotation ?? 0,
    flipH: !!base.flipH,
    flipV: !!base.flipV,
  };
}

function patch(state: EditState, id: number, next: SegmentLayout): EditState {
  return { ...state, segmentLayouts: { ...state.segmentLayouts, [id]: next } };
}

/** 区間の位置(中心原点 -1..1)を設定。非有限は no-op。既存上書きと同値なら参照不変。 */
export function setSegmentPosition(state: EditState, id: number, x: number, y: number): EditState {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  const px = clampLayoutPos(x);
  const py = clampLayoutPos(y);
  const ex = state.segmentLayouts[id];
  if (ex && ex.position.x === px && ex.position.y === py) return state;
  const cur = seed(state, id);
  return patch(state, id, { ...cur, position: { x: px, y: py } });
}

/** 区間のスケール(0.1..5)を設定。非有限は no-op。既存上書きと同値なら参照不変。 */
export function setSegmentScale(state: EditState, id: number, s: number): EditState {
  if (!Number.isFinite(s)) return state;
  const s2 = clampLayoutScale(s);
  const ex = state.segmentLayouts[id];
  if (ex && ex.scale === s2) return state;
  const cur = seed(state, id);
  return patch(state, id, { ...cur, scale: s2 });
}

/** 区間の回転(度・-180..180)を設定。非有限は no-op。既存上書きと同値なら参照不変。 */
export function setSegmentRotation(state: EditState, id: number, deg: number): EditState {
  if (!Number.isFinite(deg)) return state;
  const r = clampRotation(deg);
  const ex = state.segmentLayouts[id];
  if (ex && ex.rotation === r) return state;
  const cur = seed(state, id);
  return patch(state, id, { ...cur, rotation: r });
}

/** 区間の 2点アニメを設定（undefined で解除）。 */
export function setSegmentMotion(
  state: EditState,
  id: number,
  motion: import('../../core/motion').Motion | undefined,
): EditState {
  const cur = seed(state, id);
  const next = { ...cur };
  if (motion === undefined) delete next.motion;
  else next.motion = motion;
  return patch(state, id, next);
}

/** 区間の水平反転を設定。既存上書きと同値なら参照不変。 */
export function setSegmentFlipH(state: EditState, id: number, on: boolean): EditState {
  const on2 = !!on;
  const ex = state.segmentLayouts[id];
  if (ex && ex.flipH === on2) return state;
  const cur = seed(state, id);
  return patch(state, id, { ...cur, flipH: on2 });
}

/** 区間の垂直反転を設定。既存上書きと同値なら参照不変。 */
export function setSegmentFlipV(state: EditState, id: number, on: boolean): EditState {
  const on2 = !!on;
  const ex = state.segmentLayouts[id];
  if (ex && ex.flipV === on2) return state;
  const cur = seed(state, id);
  return patch(state, id, { ...cur, flipV: on2 });
}

/** 区間の個別指定を解除(全体に従う)。無い id は no-op(参照不変)。大域キーフレームは区間解除で消さない。 */
export function clearSegmentLayout(state: EditState, id: number): EditState {
  if (!(id in state.segmentLayouts)) return state;
  const nextLayouts = { ...state.segmentLayouts };
  delete nextLayouts[id];
  return { ...state, segmentLayouts: nextLayouts };
}
