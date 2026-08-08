import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { CutRegion, EditorVideoInsert, VideoInsert } from './types';

/**
 * VideoInsert[]（再生フレーム区間）を EditorVideoInsert[]（原本フレームアンカー）へ変換する。
 * 区間 [startFrame, endFrame) の両端を逆射影する。imageEngine.anchorImages と同型。
 * sourceInFrame / position / scale はサブ動画側の値なので ...rest で carry-through する。
 */
export function anchorVideoInserts(items: VideoInsert[], regions: CutRegion[]): EditorVideoInsert[] {
  return items.map((s) => {
    const { startFrame, endFrame, ...rest } = s;
    return {
      ...rest,
      originalStart: playbackToOriginal(startFrame, regions),
      originalEnd: playbackToOriginal(endFrame, regions),
    };
  });
}

/**
 * EditorVideoInsert[]（原本フレームアンカー）を VideoInsert[]（再生フレーム）へ射影する。
 * アンカーがカット区間内に落ちた場合は最寄りの再生フレームへ丸める
 * （カット内クリップは事前に clampVideoInserts で寄せる想定）。imageEngine.projectImages と同型。
 */
export function projectVideoInserts(items: EditorVideoInsert[], regions: CutRegion[]): VideoInsert[] {
  return items.map((t) => {
    const { originalStart, originalEnd, ...rest } = t;
    const start = originalToPlayback(originalStart, regions);
    const end = originalToPlayback(originalEnd, regions);
    return {
      ...rest,
      startFrame: Math.max(0, start ?? originalToPlayback(originalStart - 1, regions) ?? 0),
      endFrame: Math.max(0, end ?? originalToPlayback(originalEnd - 1, regions) ?? 0),
    };
  });
}

/**
 * クリップが**実際に再生される**尺（フレーム）。カット適用後の再生座標で測る。
 *
 * サブ動画のソース消費量は「原本尺 × 速度」ではなく「**再生尺** × 速度」。
 * クリップの内側にカット区間があると原本尺より再生尺のほうが短くなるため、
 * 原本尺で計算すると素材超過を過大評価して誤警告・過剰クランプになる。
 * 射影は `projectVideoInserts` と同じ式を使う（表示と判定を食い違わせない）。
 */
export function videoInsertPlaybackSpan(
  originalStart: number,
  originalEnd: number,
  regions: CutRegion[],
): number {
  const start = Math.max(
    0,
    originalToPlayback(originalStart, regions) ?? originalToPlayback(originalStart - 1, regions) ?? 0,
  );
  const end = Math.max(
    0,
    originalToPlayback(originalEnd, regions) ?? originalToPlayback(originalEnd - 1, regions) ?? 0,
  );
  return Math.max(0, end - start);
}

export interface VideoInsertClampResult {
  videoInserts: EditorVideoInsert[];
  /** カット区間に完全に飲まれた（範囲外になった）クリップの ID。 */
  flaggedIds: number[];
}

/**
 * カット区間と重なるクリップの端を区間外へ寄せる。
 * 完全に飲まれたクリップは flaggedIds へ入れ、クリップ自体は原形のまま残す
 * （VideoInsert スキーマには originalStart 退避が無いため、保存時は projectVideoInserts で
 *  最寄り再生フレームへ寄せて出力する。UI ではタイムラインで flagged 表示・Inspector で警告）。
 * imageEngine.clampImages と同型。
 */
export function clampVideoInserts(
  items: EditorVideoInsert[],
  regions: CutRegion[],
): VideoInsertClampResult {
  const cuts = normalizeCutRegions(regions);
  const flaggedIds: number[] = [];
  const result = items.map((t) => {
    let start = t.originalStart;
    let end = t.originalEnd;
    for (const c of cuts) {
      if (start >= c.start && start < c.end) start = c.end;
      if (end > c.start && end <= c.end) end = c.start;
    }
    if (start >= end) {
      flaggedIds.push(t.id);
      return t;
    }
    if (start === t.originalStart && end === t.originalEnd) return t;
    return { ...t, originalStart: start, originalEnd: end };
  });
  return { videoInserts: result, flaggedIds };
}

/** 原本フレーム区間の両端がカット区間内に落ちているか（UI の warning 表示用）。 */
export function videoInsertInCutRegion(
  originalStart: number,
  originalEnd: number,
  regions: CutRegion[],
): boolean {
  const startIn = originalToPlayback(originalStart, regions) === null;
  const endIn = originalToPlayback(Math.max(originalStart, originalEnd - 1), regions) === null;
  return startIn && endIn;
}
