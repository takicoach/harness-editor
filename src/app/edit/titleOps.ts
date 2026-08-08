import type { EditState } from './editState';
import { playbackToOriginal } from '../../core/cutEngine';
import type { EditorTitle } from '../../core/types';

export const TITLE_DEFAULT_DURATION_SEC = 5;
const TITLE_DEFAULT_TEXT = 'タイトル';

function patchTitle(state: EditState, id: number, fn: (t: EditorTitle) => EditorTitle): EditState {
  return { ...state, titles: state.titles.map((t) => (t.id === id ? fn(t) : t)) };
}

/** 再生位置から既定 5 秒・既定文言でタイトルを追加し選択する。 */
export function insertTitle(
  state: EditState,
  headPlaybackFrame: number,
  fps: number,
  totalPlaybackFrames: number,
): EditState {
  const start = Math.max(0, Math.min(Math.round(headPlaybackFrame), totalPlaybackFrames - 1));
  const dur = Math.max(1, Math.round(TITLE_DEFAULT_DURATION_SEC * fps));
  const endPlayback = Math.min(totalPlaybackFrames, start + dur);
  const originalStart = playbackToOriginal(start, state.cutRegions);
  const originalEnd = playbackToOriginal(endPlayback, state.cutRegions);
  if (originalStart >= originalEnd) return state;
  const title: EditorTitle = { id: state.nextTitleId, originalStart, originalEnd, text: TITLE_DEFAULT_TEXT };
  return {
    ...state,
    titles: [...state.titles, title],
    nextTitleId: state.nextTitleId + 1,
    selection: { kind: 'title', id: title.id },
  };
}

export function setTitleText(state: EditState, id: number, text: string): EditState {
  return patchTitle(state, id, (t) => ({ ...t, text }));
}

export function setTitleTiming(state: EditState, id: number, originalStart: number, originalEnd: number): EditState {
  const start = Math.max(0, Math.round(originalStart));
  const end = Math.max(0, Math.round(originalEnd));
  if (start >= end) return state;
  return patchTitle(state, id, (t) => ({ ...t, originalStart: start, originalEnd: end }));
}

/** クリップ全体を平行移動（区間長を保って originalStart を変える）。本体ドラッグ用。 */
export function moveTitle(state: EditState, id: number, originalStart: number): EditState {
  if (!Number.isFinite(originalStart)) return state;
  if (!state.titles.some((t) => t.id === id)) return state;
  const newStart = Math.max(0, Math.round(originalStart));
  return patchTitle(state, id, (t) => {
    const duration = t.originalEnd - t.originalStart;
    return { ...t, originalStart: newStart, originalEnd: newStart + duration };
  });
}

/** 原本フレーム atOriginalFrame で 2 つに分割（両方とも同じ文字で開始）。範囲外は no-op。 */
export function splitTitleAt(state: EditState, id: number, atOriginalFrame: number): EditState {
  const index = state.titles.findIndex((t) => t.id === id);
  if (index === -1) return state;
  const t = state.titles[index];
  if (t === undefined || atOriginalFrame <= t.originalStart || atOriginalFrame >= t.originalEnd) return state;
  const left: EditorTitle = { ...t, originalEnd: atOriginalFrame };
  const right: EditorTitle = { ...t, id: state.nextTitleId, originalStart: atOriginalFrame };
  const titles = [...state.titles];
  titles.splice(index, 1, left, right);
  return { ...state, titles, nextTitleId: state.nextTitleId + 1, selection: { kind: 'title', id: left.id } };
}

export function removeTitle(state: EditState, id: number): EditState {
  if (!state.titles.some((t) => t.id === id)) return state;
  const selection =
    state.selection?.kind === 'title' && state.selection.id === id ? null : state.selection;
  return { ...state, titles: state.titles.filter((t) => t.id !== id), selection };
}
