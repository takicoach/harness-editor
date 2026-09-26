import type { EditState } from './editState';

/** 履歴の最大保持件数。これを超えると最古から切り捨てる。 */
export const HISTORY_LIMIT = 100;

/**
 * スナップショット式の Undo/Redo 履歴。
 * states[index] が現在の状態。index より後は redo 可能な未来。
 */
export interface History {
  states: EditState[];
  index: number;
}

/** 初期状態 1 件だけを持つ履歴を作る。 */
export function createHistory(initial: EditState): History {
  return { states: [initial], index: 0 };
}

/** 現在の状態を返す。 */
export function current(history: History): EditState {
  // index は常に states の有効範囲内に保たれる（pushState/undo/redo の不変条件）。
  const state = history.states[history.index];
  if (state === undefined) {
    throw new Error('履歴インデックスが範囲外です');
  }
  return state;
}

/**
 * 新しい状態を履歴へ積む。
 * - **無変化（現在と参照が同一）なら何もしない。** 各 op は「対象が無い」ときに同一 state を
 *   返す契約なので、そのまま積むと空の 1 手が redo 分岐を捨て、履歴上限を押し流す。
 *   参照同一のときだけ弾くので、内容が変わる編集の挙動は従来どおり。
 * - 現在より後の redo 分岐は捨てる。
 * - HISTORY_LIMIT を超えたら最古から切り捨て、index を詰める。
 */
export function pushState(history: History, next: EditState): History {
  if (next === current(history)) return history;
  const kept = history.states.slice(0, history.index + 1);
  kept.push(next);
  let states = kept;
  let index = states.length - 1;
  if (states.length > HISTORY_LIMIT) {
    const overflow = states.length - HISTORY_LIMIT;
    states = states.slice(overflow);
    index -= overflow;
  }
  return { states, index };
}

/** 1 つ前の状態へ戻る（戻れなければそのまま）。 */
export function undo(history: History): History {
  if (history.index <= 0) return history;
  return { states: history.states, index: history.index - 1 };
}

/** 1 つ先の状態へ進む（進めなければそのまま）。 */
export function redo(history: History): History {
  if (history.index >= history.states.length - 1) return history;
  return { states: history.states, index: history.index + 1 };
}

/** Undo 可能か。 */
export function canUndo(history: History): boolean {
  return history.index > 0;
}

/** Redo 可能か。 */
export function canRedo(history: History): boolean {
  return history.index < history.states.length - 1;
}
