import type { EditorSe } from '../../core/types';
import type { EditState } from './editState';

/** 新規 SE のデフォルト音量（ハーネス形式標準の中間値）。 */
const DEFAULT_SE_VOLUME = 0.3;

/** 新規 SE の既定区間長（フレーム）。音源デコード前の仮置き。 */
export const DEFAULT_SE_DURATION_FRAMES = 90;

/**
 * 効果音を originalStart（原本フレーム）へ追加し、その SE を選択状態にする。
 * file が空・originalStart が非有限なら state をそのまま返す。
 * originalStart は 0 以上へクランプし丸める。
 * durationFrames 未指定は DEFAULT_SE_DURATION_FRAMES（90）を使い autoLength を立てる。
 */
export function addSe(
  state: EditState,
  file: string,
  originalStart: number,
  durationFrames: number = DEFAULT_SE_DURATION_FRAMES,
): EditState {
  if (file === '' || !Number.isFinite(originalStart)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const dur = Math.max(1, Math.round(durationFrames));
  const se: EditorSe = {
    id: state.nextSeId,
    originalStart: start,
    originalEnd: start + dur,
    file,
    volume: DEFAULT_SE_VOLUME,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    autoLength: true,
    autoVolume: true,
  };
  return {
    ...state,
    se: [...state.se, se],
    nextSeId: state.nextSeId + 1,
    selection: { kind: 'se', id: se.id },
  };
}

/**
 * 指定 ID の効果音を取り除く。不在 ID なら state をそのまま返す。
 * 削除した SE が選択中なら選択を外す。
 */
export function removeSe(state: EditState, seId: number): EditState {
  if (!state.se.some((s) => s.id === seId)) return state;
  const selection =
    state.selection?.kind === 'se' && state.selection.id === seId ? null : state.selection;
  return { ...state, se: state.se.filter((s) => s.id !== seId), selection };
}

/** 指定 ID の効果音を選択状態にする。 */
export function selectSe(state: EditState, seId: number): EditState {
  return { ...state, selection: { kind: 'se', id: seId } };
}

/** 数値を [min,max] へクランプする。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 指定 ID の SE へ patch を適用するヘルパ（不在 ID はそのまま）。 */
function patchSe(
  state: EditState,
  seId: number,
  patch: (s: EditorSe) => EditorSe,
): EditState {
  // some() で不在 ID を早期 return（同一参照を保つ）→ map() で実際の更新を行う。
  if (!state.se.some((s) => s.id === seId)) return state;
  return { ...state, se: state.se.map((s) => (s.id === seId ? patch(s) : s)) };
}

/**
 * 指定 SE を newOriginalStart へ移動する。区間長を保持する。
 * 非有限値・不在 ID は state をそのまま返す。0 以上へクランプし丸める。
 */
export function moveSe(state: EditState, seId: number, originalStart: number): EditState {
  if (!Number.isFinite(originalStart)) return state;
  const next = Math.max(0, Math.round(originalStart));
  return patchSe(state, seId, (s) => {
    const duration = s.originalEnd - s.originalStart;
    return { ...s, originalStart: next, originalEnd: next + duration };
  });
}

/**
 * 指定 SE の音量を設定する（0..1 へクランプ）。
 * 非有限値・不在 ID は state をそのまま返す。
 */
export function setSeVolume(state: EditState, seId: number, volume: number): EditState {
  if (!Number.isFinite(volume)) return state;
  return patchSe(state, seId, (s) => ({ ...s, volume: clamp(volume, 0, 1), autoVolume: undefined }));
}

/**
 * 指定 SE の効果音ファイルを差し替える。
 * 空文字・不在 ID は state をそのまま返す。
 */
export function setSeFile(state: EditState, seId: number, file: string): EditState {
  if (file === '') return state;
  return patchSe(state, seId, (s) => ({ ...s, file }));
}

/** SE の区間（原本フレーム）を変える。end >= start+1 をクランプ。ユーザー操作なので autoLength を外す。 */
export function resizeSe(
  state: EditState,
  seId: number,
  originalStart: number,
  originalEnd: number,
): EditState {
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const end = Math.max(start + 1, Math.round(originalEnd));
  return patchSe(state, seId, (s) => ({ ...s, originalStart: start, originalEnd: end, autoLength: undefined }));
}

/** SE のフェードイン長（フレーム・0 以上）。 */
export function setSeFadeIn(state: EditState, seId: number, fadeInFrames: number): EditState {
  if (!Number.isFinite(fadeInFrames)) return state;
  return patchSe(state, seId, (s) => ({ ...s, fadeInFrames: Math.max(0, Math.round(fadeInFrames)) }));
}

/** SE のフェードアウト長（フレーム・0 以上）。 */
export function setSeFadeOut(state: EditState, seId: number, fadeOutFrames: number): EditState {
  if (!Number.isFinite(fadeOutFrames)) return state;
  return patchSe(state, seId, (s) => ({ ...s, fadeOutFrames: Math.max(0, Math.round(fadeOutFrames)) }));
}

/** 音源デコード後、autoLength の SE を自然長（durationFrames）へ合わせて autoLength を外す。 */
export function fitSeToSource(state: EditState, seId: number, durationFrames: number): EditState {
  if (!Number.isFinite(durationFrames)) return state;
  const dur = Math.max(1, Math.round(durationFrames));
  return patchSe(state, seId, (s) => ({ ...s, originalEnd: s.originalStart + dur, autoLength: undefined }));
}

/** ラウドネス正規化で音量を確定し autoVolume を外す（自動・履歴1件）。 */
export function normalizeSeVolume(state: EditState, seId: number, volume: number): EditState {
  if (!Number.isFinite(volume)) return state;
  return patchSe(state, seId, (s) => ({ ...s, volume: clamp(volume, 0, 1), autoVolume: undefined }));
}

/**
 * 追加直後の SE をデコード結果で確定する（自然長 fit ＋ ラウドネス正規化を1回で）。
 * 既に手動変更済み（autoLength/autoVolume が false）の項目は上書きしない。
 * 1 apply で適用するため、fit と normalize が別 apply で衝突する lost-update を防ぐ。
 */
export function finalizeAddedSe(
  state: EditState,
  seId: number,
  durationFrames: number,
  volume: number,
): EditState {
  return patchSe(state, seId, (s) => {
    const next: EditorSe = { ...s };
    if (s.autoLength === true && Number.isFinite(durationFrames)) {
      next.originalEnd = s.originalStart + Math.max(1, Math.round(durationFrames));
      next.autoLength = undefined;
    }
    if (s.autoVolume === true && Number.isFinite(volume)) {
      next.volume = clamp(volume, 0, 1);
      next.autoVolume = undefined;
    }
    return next;
  });
}
