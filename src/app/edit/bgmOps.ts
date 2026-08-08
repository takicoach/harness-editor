import type { EditorBgmClip } from '../../core/types';
import type { EditState } from './editState';

/** 新規 BGM クリップの既定再生長（フレーム）。videoInsertOps と同じ 60fps × 2秒。 */
const DEFAULT_BGM_DURATION_FRAMES = 120;

/** BGM の既定音量。 */
const DEFAULT_BGM_VOLUME = 0.2;

/** 数値を [min,max] へクランプする。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// --- 重ね禁止（単一トラック運用・spec §9.1）---
// BGM は「1曲ずつ・重ねない」運用。追加・移動・リサイズの各操作で、他クリップと
// 半開区間として重ならないよう配置を求める純関数群。既存クリップ同士が（旧データ由来で）
// 重なっていても、編集対象クリップだけは重ならないように寄せる（防御的）。

/**
 * desiredStart から前方の最初の空きへ新規クリップ [start,end) を置く。
 * 既定長を保つが、次クリップ手前で切れる場合は縮める。トラックは上限なしのため必ず停止。
 */
function placeNewBgm(
  others: EditorBgmClip[],
  desiredStart: number,
  duration: number,
): { start: number; end: number } {
  const sorted = [...others].sort((a, b) => a.originalStart - b.originalStart);
  let cursor = desiredStart;
  // cursor を含むクリップがある限りその末尾へ送る（cursor は単調増加で必ず停止）。
  for (;;) {
    const blocking = sorted.find((o) => o.originalStart <= cursor && cursor < o.originalEnd);
    if (!blocking) break;
    cursor = blocking.originalEnd;
  }
  const next = sorted.find((o) => o.originalStart > cursor);
  const nextStart = next ? next.originalStart : Infinity;
  return { start: cursor, end: Math.min(cursor + duration, nextStart) };
}

/**
 * 平行移動（長さ固定）を、desiredStart が指す隙間の中で重ならないようクランプ。
 * その隙間が長さ未満なら移動できないので fallbackStart（＝現在位置）を返す。
 */
function clampBgmMove(
  others: EditorBgmClip[],
  duration: number,
  desiredStart: number,
  fallbackStart: number,
): number {
  let leftEnd = 0;
  let nextStart = Infinity;
  for (const o of others) {
    if (o.originalStart < desiredStart) leftEnd = Math.max(leftEnd, o.originalEnd);
    else nextStart = Math.min(nextStart, o.originalStart);
  }
  if (nextStart - leftEnd >= duration) {
    return clamp(desiredStart, leftEnd, nextStart - duration);
  }
  return fallbackStart;
}

/**
 * 両端リサイズを、現在位置の左右隣クリップ端でクランプする。
 * 0 クランプ・丸め・end>=start+1 も内包する（呼び出し側は結果をそのまま使える）。
 */
function clampBgmResize(
  others: EditorBgmClip[],
  current: EditorBgmClip,
  desiredStart: number,
  desiredEnd: number,
): { start: number; end: number } {
  let leftBound = 0;
  let rightBound = Infinity;
  for (const o of others) {
    if (o.originalEnd <= current.originalStart) leftBound = Math.max(leftBound, o.originalEnd);
    if (o.originalStart >= current.originalEnd) rightBound = Math.min(rightBound, o.originalStart);
  }
  let start = Math.max(0, Math.round(desiredStart));
  start = Math.max(leftBound, start);
  if (Number.isFinite(rightBound)) start = Math.min(start, rightBound - 1);
  let end = Math.round(desiredEnd);
  if (Number.isFinite(rightBound)) end = Math.min(end, rightBound);
  end = Math.max(start + 1, end);
  return { start, end };
}

/**
 * BGM クリップを originalStart（原本フレーム）から既定長で追加し選択する。
 * file 空・start 非有限なら state をそのまま返す。start は 0 以上へクランプ・丸め。
 * volume 既定は DEFAULT_BGM_VOLUME、fadeInFrames/fadeOutFrames 既定 0。
 */
export function addBgm(state: EditState, file: string, originalStart: number): EditState {
  if (file === '' || !Number.isFinite(originalStart)) return state;
  const desired = Math.max(0, Math.round(originalStart));
  const { start, end } = placeNewBgm(state.bgm, desired, DEFAULT_BGM_DURATION_FRAMES);
  const clip: EditorBgmClip = {
    id: state.nextBgmId,
    originalStart: start,
    originalEnd: end,
    file,
    volume: DEFAULT_BGM_VOLUME,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    autoVolume: true,
  };
  return {
    ...state,
    bgm: [...state.bgm, clip],
    nextBgmId: state.nextBgmId + 1,
    selection: { kind: 'bgm', id: clip.id },
  };
}

/** 指定 ID を取り除く。不在 ID はそのまま。削除対象が選択中なら選択を外す。 */
export function removeBgm(state: EditState, id: number): EditState {
  if (!state.bgm.some((b) => b.id === id)) return state;
  const selection =
    state.selection?.kind === 'bgm' && state.selection.id === id ? null : state.selection;
  return { ...state, bgm: state.bgm.filter((b) => b.id !== id), selection };
}

/** 指定 ID を選択状態にする。 */
export function selectBgm(state: EditState, id: number): EditState {
  return { ...state, selection: { kind: 'bgm', id } };
}

/** 指定 ID へ patch を適用するヘルパ（不在 ID はそのまま）。 */
function patch(
  state: EditState,
  id: number,
  fn: (b: EditorBgmClip) => EditorBgmClip,
): EditState {
  if (!state.bgm.some((b) => b.id === id)) return state;
  return { ...state, bgm: state.bgm.map((b) => (b.id === id ? fn(b) : b)) };
}

/** 区間を平行移動（長さ保持・0クランプ・丸め）。非有限・不在 ID はそのまま。 */
export function moveBgm(state: EditState, id: number, originalStart: number): EditState {
  if (!Number.isFinite(originalStart)) return state;
  const desired = Math.max(0, Math.round(originalStart));
  const others = state.bgm.filter((o) => o.id !== id);
  return patch(state, id, (b) => {
    const duration = b.originalEnd - b.originalStart;
    const start = clampBgmMove(others, duration, desired, b.originalStart);
    return { ...b, originalStart: start, originalEnd: start + duration };
  });
}

/** 両端を独立設定（つまみ・数値入力用）。0クランプ・丸め・end>=start+1 保証。 */
export function resizeBgm(
  state: EditState,
  id: number,
  originalStart: number,
  originalEnd: number,
): EditState {
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return state;
  const others = state.bgm.filter((o) => o.id !== id);
  return patch(state, id, (b) => {
    const { start, end } = clampBgmResize(others, b, originalStart, originalEnd);
    return { ...b, originalStart: start, originalEnd: end };
  });
}

/** 音量を [0,1] へクランプして設定。非有限・不在 ID はそのまま。 */
export function setBgmVolume(state: EditState, id: number, volume: number): EditState {
  if (!Number.isFinite(volume)) return state;
  return patch(state, id, (b) => ({ ...b, volume: clamp(volume, 0, 1), autoVolume: undefined }));
}

/** フェードイン長（フレーム）を 0 以上へクランプして設定。非有限・不在 ID はそのまま。 */
export function setBgmFadeIn(state: EditState, id: number, fadeInFrames: number): EditState {
  if (!Number.isFinite(fadeInFrames)) return state;
  return patch(state, id, (b) => ({ ...b, fadeInFrames: Math.max(0, Math.round(fadeInFrames)) }));
}

/** フェードアウト長（フレーム）を 0 以上へクランプして設定。非有限・不在 ID はそのまま。 */
export function setBgmFadeOut(state: EditState, id: number, fadeOutFrames: number): EditState {
  if (!Number.isFinite(fadeOutFrames)) return state;
  return patch(state, id, (b) => ({ ...b, fadeOutFrames: Math.max(0, Math.round(fadeOutFrames)) }));
}

/** BGM ファイルを差し替える。空文字・不在 ID はそのまま。 */
export function setBgmFile(state: EditState, id: number, file: string): EditState {
  if (file === '') return state;
  return patch(state, id, (b) => ({ ...b, file }));
}

/** ラウドネス正規化で音量を確定し autoVolume を外す（自動・履歴1件）。 */
export function normalizeBgmVolume(state: EditState, id: number, volume: number): EditState {
  if (!Number.isFinite(volume)) return state;
  return patch(state, id, (b) => ({ ...b, volume: clamp(volume, 0, 1), autoVolume: undefined }));
}
