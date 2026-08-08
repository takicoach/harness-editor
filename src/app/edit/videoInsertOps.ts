import type { CutRegion, EditorVideoInsert, ElementAnim, TelopPosition } from '../../core/types';
import { originalToPlayback, playbackToOriginal } from '../../core/cutEngine';
import { videoInsertPlaybackSpan } from '../../core/videoInsertEngine';
import type { EditState } from './editState';

/** 新規サブ動画インサートの既定再生長（フレーム）。60fps で約 2 秒。 */
const DEFAULT_VIDEO_INSERT_DURATION_FRAMES = 120;

/** 数値を [min,max] へクランプする。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * サブ動画インサートを originalStart（原本フレーム）から既定長で追加し選択する。
 * file 空・start 非有限なら state をそのまま返す。start は 0 以上へクランプ・丸め。
 * sourceInFrame は 0（サブの頭から）。position/scale は未指定（全画面中央）。
 */
export function addVideoInsert(state: EditState, file: string, originalStart: number): EditState {
  if (file === '' || !Number.isFinite(originalStart)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const clip: EditorVideoInsert = {
    id: state.nextVideoInsertId,
    originalStart: start,
    originalEnd: start + DEFAULT_VIDEO_INSERT_DURATION_FRAMES,
    file,
    sourceInFrame: 0,
  };
  return {
    ...state,
    videoInserts: [...state.videoInserts, clip],
    nextVideoInsertId: state.nextVideoInsertId + 1,
    selection: { kind: 'videoInsert', id: clip.id },
  };
}

/** 指定 ID を取り除く。不在 ID はそのまま。削除対象が選択中なら選択を外す。 */
export function removeVideoInsert(state: EditState, id: number): EditState {
  if (!state.videoInserts.some((v) => v.id === id)) return state;
  const selection =
    state.selection?.kind === 'videoInsert' && state.selection.id === id ? null : state.selection;
  return { ...state, videoInserts: state.videoInserts.filter((v) => v.id !== id), selection };
}

/** 指定 ID を選択状態にする。 */
export function selectVideoInsert(state: EditState, id: number): EditState {
  return { ...state, selection: { kind: 'videoInsert', id } };
}

/** 指定 ID へ patch を適用するヘルパ（不在 ID はそのまま）。 */
function patch(
  state: EditState,
  id: number,
  fn: (v: EditorVideoInsert) => EditorVideoInsert,
): EditState {
  if (!state.videoInserts.some((v) => v.id === id)) return state;
  return { ...state, videoInserts: state.videoInserts.map((v) => (v.id === id ? fn(v) : v)) };
}

/** 区間を平行移動（長さ保持・0クランプ・丸め）。非有限・不在 ID はそのまま。 */
export function moveVideoInsert(state: EditState, id: number, originalStart: number): EditState {
  if (!Number.isFinite(originalStart)) return state;
  const newStart = Math.max(0, Math.round(originalStart));
  return patch(state, id, (v) => {
    const duration = v.originalEnd - v.originalStart;
    return { ...v, originalStart: newStart, originalEnd: newStart + duration };
  });
}

/**
 * クリップが素材内に収まる originalEnd の上限を返す（純関数）。
 *
 * ソース消費量は「**再生尺** × 速度」なので、許容再生尺は残量（実尺 − イン点）を速度で割った値。
 * 端数は切り捨て、素材の外へ 1 フレームもはみ出さない。クリップ内側にカット区間があると
 * 原本尺 > 再生尺 になるため、再生座標で上限を出してから原本座標へ戻す。
 *
 * @param clip        対象クリップ（イン点・速度をここから読む）
 * @param sourceFrames 素材の実フレーム長。プローブ未完了・不明・非正なら undefined を返す
 *                     （＝上限なし＝従来挙動。推定できないものを勝手に縮めない）
 * @param originalStart クランプ後に確定する開始フレーム。左端ドラッグで start が動く経路が
 *                     あるため、呼び出し側は「これから確定する start」を渡すこと
 * @param cutRegions  カット区間。**任意にしない**（省略を許すと原本座標へ静かに退化する）
 */
export function videoInsertMaxEnd(
  clip: EditorVideoInsert,
  sourceFrames: number | undefined,
  originalStart: number,
  cutRegions: CutRegion[],
): number | undefined {
  if (sourceFrames === undefined || !Number.isFinite(sourceFrames) || sourceFrames <= 0) return undefined;
  if (!Number.isFinite(originalStart)) return undefined;
  const rate = clip.playbackRate ?? 1;
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const remaining = sourceFrames - clip.sourceInFrame;
  // イン点が素材尻を越えている等の退化ケースでも 1 フレームは残す（end >= start+1 の契約）。
  const maxPlaybackDuration = Math.max(1, Math.floor(remaining / rate));
  if (cutRegions.length === 0) return originalStart + maxPlaybackDuration;
  const playbackStart =
    originalToPlayback(originalStart, cutRegions) ?? originalToPlayback(originalStart - 1, cutRegions);
  // start がカット区間内＝そもそも編集不可の経路。ここでは縮めない。
  if (playbackStart === null) return undefined;
  return playbackToOriginal(playbackStart + maxPlaybackDuration, cutRegions);
}

/**
 * クリップが素材の終端をどれだけはみ出しているか（ソース座標のフレーム数）。
 * 収まっていれば 0、実尺不明なら null（＝判定しない）。
 *
 * 消費量は**再生尺**×速度で測る（クリップ内側にカット区間があると原本尺より短くなる）。
 * 原本尺で測ると誤警告になる。はみ出した区間はソース最終フレームで静止する。
 * イン点（sourceInFrame）はユーザーが波形で合わせる同期点なので勝手にクランプせず、
 * ここで警告に使う。
 */
export function videoInsertOverflowFrames(
  clip: EditorVideoInsert,
  sourceFrames: number | undefined,
  cutRegions: CutRegion[],
): number | null {
  if (sourceFrames === undefined || !Number.isFinite(sourceFrames) || sourceFrames <= 0) return null;
  const rate = clip.playbackRate ?? 1;
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const consumed = videoInsertPlaybackSpan(clip.originalStart, clip.originalEnd, cutRegions) * rate;
  return Math.max(0, Math.round(clip.sourceInFrame + consumed - sourceFrames));
}

/**
 * 両端を独立設定（つまみ・数値入力用）。0クランプ・丸め・end>=start+1 保証。
 * maxEnd を渡すとそこで頭打ちにする（素材の実尺クランプ・`videoInsertMaxEnd` で算出）。
 * maxEnd 未指定・非有限のときはクランプしない＝従来挙動（実尺不明の素材を勝手に縮めない）。
 */
export function retimeVideoInsert(
  state: EditState,
  id: number,
  originalStart: number,
  originalEnd: number,
  maxEnd?: number,
): EditState {
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return state;
  const start = Math.max(0, Math.round(originalStart));
  let end = Math.max(start + 1, Math.round(originalEnd));
  if (maxEnd !== undefined && Number.isFinite(maxEnd)) {
    // 上限が start+1 を下回る退化ケースでも end>=start+1 の契約を壊さない。
    end = Math.min(end, Math.max(start + 1, Math.floor(maxEnd)));
  }
  return patch(state, id, (v) => ({ ...v, originalStart: start, originalEnd: end }));
}

/** サブ動画のイン点（sourceInFrame）を設定（0 以上クランプ・丸め）。非有限・不在 ID はそのまま。 */
export function setVideoInsertInPoint(state: EditState, id: number, sourceInFrame: number): EditState {
  if (!Number.isFinite(sourceInFrame)) return state;
  const inFrame = Math.max(0, Math.round(sourceInFrame));
  return patch(state, id, (v) => ({ ...v, sourceInFrame: inFrame }));
}

/** 位置（フレーム中心原点の正規化オフセット -1..1）を設定。非有限はそのまま。 */
export function setVideoInsertPosition(state: EditState, id: number, x: number, y: number): EditState {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  const position: TelopPosition = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  return patch(state, id, (v) => ({ ...v, position }));
}

/** スケールを設定（0.1..5 へクランプ）。非有限・不在 ID はそのまま。 */
export function setVideoInsertScale(state: EditState, id: number, scale: number): EditState {
  if (!Number.isFinite(scale)) return state;
  return patch(state, id, (v) => ({ ...v, scale: clamp(scale, 0.1, 5) }));
}

/** サブ動画ファイルを差し替える。空文字・不在 ID はそのまま。 */
export function setVideoInsertFile(state: EditState, id: number, file: string): EditState {
  if (file === '') return state;
  return patch(state, id, (v) => ({ ...v, file }));
}

/** サブ動画の登場アニメを設定する。不在 ID はそのまま。 */
export function setVideoInsertEnter(state: EditState, id: number, enter: ElementAnim): EditState {
  return patch(state, id, (v) => ({ ...v, enter }));
}

/** サブ動画の退場アニメを設定する。不在 ID はそのまま。 */
export function setVideoInsertExit(state: EditState, id: number, exit: ElementAnim): EditState {
  return patch(state, id, (v) => ({ ...v, exit }));
}

/** 速度範囲の下限・上限。 */
const MIN_PLAYBACK_RATE = 0.1;
const MAX_PLAYBACK_RATE = 16;

/**
 * サブ動画の再生速度を設定する（0.1〜16 へクランプ）。
 * D_source（= 現尺 × 現速度）を保ったまま originalEnd を伸縮する（NLE 標準＝速度変更でクリップが自動伸縮）。
 * 実効速度が同値なら no-op（同一 state 参照を返し履歴に積まない）。非有限・不在 ID はそのまま。
 */
export function setVideoInsertPlaybackRate(state: EditState, id: number, rate: number): EditState {
  if (!Number.isFinite(rate)) return state;
  const next = clamp(rate, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE);
  const target = state.videoInserts.find((v) => v.id === id);
  if (target === undefined) return state;
  const current = target.playbackRate ?? 1;
  if (current === next) return state; // no-op
  const dSource = (target.originalEnd - target.originalStart) * current;
  const newDuration = Math.max(1, Math.round(dSource / next));
  return patch(state, id, (v) => ({
    ...v,
    playbackRate: next,
    originalEnd: v.originalStart + newDuration,
  }));
}

/**
 * 基準クリップ fromId の「ズレ」offset = sourceInFrame - originalStart を、同じ file の
 * 他クリップへ線形適用する（other.sourceInFrame = max(0, round(other.originalStart + offset))）。
 * 回しっぱなし撮影で 1 クリップ合わせれば全体が合う、を実現する。fromId 不在はそのまま返す。
 */
export function applySourceOffsetToFile(state: EditState, fromId: number): EditState {
  const base = state.videoInserts.find((v) => v.id === fromId);
  if (base === undefined) return state;
  const offset = base.sourceInFrame - base.originalStart;
  return {
    ...state,
    videoInserts: state.videoInserts.map((v) =>
      v.file === base.file && v.id !== fromId
        ? { ...v, sourceInFrame: Math.max(0, Math.round(v.originalStart + offset)) }
        : v,
    ),
  };
}
