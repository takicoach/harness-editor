import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { BgmClip, CutRegion, EditorBgmClip } from './types';

/**
 * BgmClip[]（再生フレーム区間）を EditorBgmClip[]（原本フレームアンカー）へ変換する。
 * 区間 [startFrame, endFrame) の両端を逆射影する。videoInsertEngine.anchorVideoInserts と同型。
 * volume / fadeInFrames / fadeOutFrames は BGM 側の値なので ...rest で carry-through する。
 */
export function anchorBgm(items: BgmClip[], regions: CutRegion[]): EditorBgmClip[] {
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
 * EditorBgmClip[]（原本フレームアンカー）を BgmClip[]（再生フレーム）へ射影する。
 * アンカーがカット区間内に落ちた場合は最寄りの再生フレームへ丸める
 * （カット内クリップは事前に clampBgm で寄せる想定）。videoInsertEngine.projectVideoInserts と同型。
 */
export function projectBgm(items: EditorBgmClip[], regions: CutRegion[]): BgmClip[] {
  return items.map((t) => {
    const { originalStart, originalEnd, autoVolume: _autoVolume, ...rest } = t;
    const start = originalToPlayback(originalStart, regions);
    const end = originalToPlayback(originalEnd, regions);
    return {
      ...rest,
      startFrame: Math.max(0, start ?? originalToPlayback(originalStart - 1, regions) ?? 0),
      endFrame: Math.max(0, end ?? originalToPlayback(originalEnd - 1, regions) ?? 0),
    };
  });
}

export interface BgmClampResult {
  bgm: EditorBgmClip[];
  /** カット区間に完全に飲まれた（範囲外になった）クリップの ID。 */
  flaggedIds: number[];
}

/**
 * カット区間と重なるクリップの端を区間外へ寄せる。完全に飲まれたクリップは flaggedIds へ。
 * videoInsertEngine.clampVideoInserts と同型。
 */
export function clampBgm(items: EditorBgmClip[], regions: CutRegion[]): BgmClampResult {
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
  return { bgm: result, flaggedIds };
}

/** 原本フレーム区間の両端がカット区間内に落ちているか（UI の warning 表示用）。 */
export function bgmInCutRegion(
  originalStart: number,
  originalEnd: number,
  regions: CutRegion[],
): boolean {
  const startIn = originalToPlayback(originalStart, regions) === null;
  const endIn = originalToPlayback(Math.max(originalStart, originalEnd - 1), regions) === null;
  return startIn && endIn;
}
