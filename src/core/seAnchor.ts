import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { CutRegion, EditorSe, SoundEffect } from './types';

/** endFrame 未指定の旧 SE データに与える既定区間長（フレーム）。従来の固定 90 を踏襲。 */
const LEGACY_SE_DURATION_FRAMES = 90;

/**
 * SoundEffect[]（再生フレーム）を EditorSe[]（原本フレームアンカー）へ変換する。
 * endFrame 無し（旧データ）は originalStart + 90 で補完し従来の 3 秒挙動を保つ。
 */
export function anchorSe(se: SoundEffect[], regions: CutRegion[]): EditorSe[] {
  return se.map((s) => {
    const { startFrame, endFrame, ...rest } = s;
    const originalStart = playbackToOriginal(startFrame, regions);
    const originalEnd =
      endFrame !== undefined
        ? playbackToOriginal(endFrame, regions)
        : originalStart + LEGACY_SE_DURATION_FRAMES;
    return { ...rest, originalStart, originalEnd };
  });
}

/** 原本フレームの点を再生フレームへ射影する（カット区間内はその終端へ寄せる）。 */
function projectPoint(frame: number, regions: CutRegion[]): number {
  const direct = originalToPlayback(frame, regions);
  if (direct !== null) return direct;
  for (const c of normalizeCutRegions(regions)) {
    if (frame >= c.start && frame < c.end) {
      return originalToPlayback(c.end, regions) ?? 0;
    }
  }
  return 0;
}

/**
 * EditorSe[]（原本フレームアンカー）を SoundEffect[]（再生フレーム）へ射影する。
 * 両端を射影し、端がカットに飲まれた場合は projectBgm と同じ frame-1 フォールバック。
 * autoLength（セッション専用）は出力しない。
 */
export function projectSe(se: EditorSe[], regions: CutRegion[]): SoundEffect[] {
  return se.map((s) => {
    const { originalStart, originalEnd, autoLength: _autoLength, autoVolume: _autoVolume, ...rest } = s;
    const start = originalToPlayback(originalStart, regions);
    const end = originalToPlayback(originalEnd, regions);
    return {
      ...rest,
      startFrame: Math.max(0, start ?? projectPoint(originalStart, regions)),
      endFrame: Math.max(0, end ?? originalToPlayback(originalEnd - 1, regions) ?? projectPoint(originalEnd, regions)),
    };
  });
}

/**
 * EditorSe[] の両端をカット区間の外へ clamp する（BGM の clampBgm と同方針）。
 * 両端が同一カットに飲まれて start>=end になった区間は flag（出力は元のまま）。
 */
export function clampSe(
  se: EditorSe[],
  regions: CutRegion[],
): { se: EditorSe[]; flaggedIds: number[] } {
  const cuts = normalizeCutRegions(regions);
  const flaggedIds: number[] = [];
  const result = se.map((s) => {
    let start = s.originalStart;
    let end = s.originalEnd;
    for (const c of cuts) {
      if (start >= c.start && start < c.end) start = c.end;
      if (end > c.start && end <= c.end) end = c.start;
    }
    if (start >= end) {
      flaggedIds.push(s.id);
      return s;
    }
    if (start === s.originalStart && end === s.originalEnd) return s;
    return { ...s, originalStart: start, originalEnd: end };
  });
  return { se: result, flaggedIds };
}

/** 原本フレームの開始点がいずれかのカット区間内に落ちているか（UI の警告表示用）。 */
export function seInCutRegion(originalStart: number, regions: CutRegion[]): boolean {
  return originalToPlayback(originalStart, regions) === null;
}
