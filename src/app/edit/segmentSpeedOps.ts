import { clampMainSpeed } from '../../core/speedEngine';
import type { EditState } from './editState';

/** 区間 id へ個別速度を設定する（クランプ・no-op は参照不変）。 */
export function setSegmentSpeed(state: EditState, id: number, rate: number): EditState {
  if (!Number.isFinite(rate)) return state;
  const next = clampMainSpeed(rate);
  if (state.segmentSpeeds[id] === next) return state;
  return { ...state, segmentSpeeds: { ...state.segmentSpeeds, [id]: next } };
}

/** 区間 id の個別速度を解除する（全体速度に従う・no-op は参照不変）。 */
export function clearSegmentSpeed(state: EditState, id: number): EditState {
  if (!(id in state.segmentSpeeds)) return state;
  const next = { ...state.segmentSpeeds };
  delete next[id];
  return { ...state, segmentSpeeds: next };
}
