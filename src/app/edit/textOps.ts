import type { EditState } from './editState';

/**
 * 指定 ID のテロップ本文を書き換える（spec §7「文字編集 = テロップ表示の変更のみ」）。
 * カットは一切発生しない。元の state は破壊せず新しい state を返す。
 */
export function setTelopText(state: EditState, telopId: number, text: string): EditState {
  return {
    ...state,
    telops: state.telops.map((t) => (t.id === telopId ? { ...t, text } : t)),
  };
}
