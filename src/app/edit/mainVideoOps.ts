import { clampMainSpeed } from '../../core/speedEngine';
import { DEFAULT_MAIN_LAYOUT, clampLayoutPos, clampLayoutScale, clampRotation, isIdentityMainLayout } from '../../core/mainLayout';
import type { MainLayout, TelopPosition } from '../../core/types';
import type { EditState } from './editState';

/** メイン動画 全体一律の速度を設定する（クランプ・no-op は参照不変）。 */
export function setMainSpeed(state: EditState, rate: number): EditState {
  if (!Number.isFinite(rate)) return state;
  const next = clampMainSpeed(rate);
  if (state.mainSpeed === next) return state;
  return { ...state, mainSpeed: next };
}

/** 現在のレイアウト（未設定＝既定）を返すヘルパ。 */
function currentLayout(state: EditState): MainLayout {
  return state.mainLayout ?? DEFAULT_MAIN_LAYOUT;
}

/** メイン動画の位置（中心原点 -1..1）を設定。非有限・同値は no-op（参照不変）。 */
export function setMainVideoPosition(state: EditState, x: number, y: number): EditState {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  const position: TelopPosition = { x: clampLayoutPos(x), y: clampLayoutPos(y) };
  const cur = currentLayout(state);
  if (cur.position.x === position.x && cur.position.y === position.y) return state;
  return { ...state, mainLayout: { ...cur, position } };
}

/** メイン動画のスケール（0.1..5）を設定。非有限・同値は no-op。 */
export function setMainVideoScale(state: EditState, scale: number): EditState {
  if (!Number.isFinite(scale)) return state;
  const s = clampLayoutScale(scale);
  const cur = currentLayout(state);
  if (cur.scale === s) return state;
  return { ...state, mainLayout: { ...cur, scale: s } };
}

/** メイン動画の背景色（CSS カラー）を設定。非文字列・空文字・同値は no-op。 */
export function setMainVideoBackground(state: EditState, background: string): EditState {
  if (typeof background !== 'string' || background === '') return state;
  const cur = currentLayout(state);
  if (cur.background === background) return state;
  return { ...state, mainLayout: { ...cur, background } };
}

/** メイン動画の回転(度・-180..180)を設定。非有限・同値は no-op。 */
export function setMainVideoRotation(state: EditState, deg: number): EditState {
  if (!Number.isFinite(deg)) return state;
  const rotation = clampRotation(deg);
  const cur = currentLayout(state);
  if ((cur.rotation ?? 0) === rotation) return state;
  return { ...state, mainLayout: { ...cur, rotation } };
}

/** メイン動画の水平反転を設定。同値は no-op。 */
export function setMainVideoFlipH(state: EditState, on: boolean): EditState {
  const cur = currentLayout(state);
  if (!!cur.flipH === !!on) return state;
  return { ...state, mainLayout: { ...cur, flipH: !!on } };
}

/** メイン動画の垂直反転を設定。同値は no-op。 */
export function setMainVideoFlipV(state: EditState, on: boolean): EditState {
  const cur = currentLayout(state);
  if (!!cur.flipV === !!on) return state;
  return { ...state, mainLayout: { ...cur, flipV: !!on } };
}

/** レイアウトを既定（全画面・黒）へ戻す。既に既定なら no-op。 */
export function resetMainLayout(state: EditState): EditState {
  const cur = currentLayout(state);
  // identity 判定は isIdentityMainLayout に単一化（背景も既定なら完全に既定＝no-op）。
  if (isIdentityMainLayout(cur) && cur.background === DEFAULT_MAIN_LAYOUT.background) {
    return state;
  }
  return {
    ...state,
    mainLayout: { position: { x: 0, y: 0 }, scale: 1, background: DEFAULT_MAIN_LAYOUT.background, rotation: 0, flipH: false, flipV: false },
  };
}
