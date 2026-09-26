import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from '../../core/cutEngine';
import type { CutOrdering, CutRegion } from '../../core/types';
import type { PlaybackModel } from '../../preview/playbackModel';
import { playbackToPlayer, playerToPlayback } from '../../preview/speedBridge';

export interface OverviewWindow {
  start: number;
  end: number;
}

export interface OverviewCoordinateMap {
  originalTotalFrames: number;
  cutRegions: CutRegion[];
  ordering: CutOrdering;
  finalModel: Pick<PlaybackModel, 'durationInFrames' | 'speedSegments' | 'playbackOverlaps' | 'mainSpeed'>;
}

function clampFrame(frame: number, totalFrames: number): number {
  if (!Number.isFinite(frame) || !Number.isFinite(totalFrames) || totalFrames <= 1) return 0;
  return Math.max(0, Math.min(totalFrames - 1, Math.round(frame)));
}

/**
 * 原本座標を、書き出しと同じ完成後座標へ写す。
 *
 * 素材確認中はカット済み区間にも再生ヘッドが入れる。その区間は完成動画に対応点が
 * ないため、原本上で近い「残す区間」の端へ寄せてから完成後へ射影する。
 */
export function originalFrameToOverviewFrame(
  originalFrame: number,
  map: OverviewCoordinateMap,
): number {
  const original = clampFrame(originalFrame, map.originalTotalFrames);
  let playback = originalToPlayback(original, map.cutRegions, map.ordering);
  if (playback === null) {
    const cut = normalizeCutRegions(map.cutRegions)
      .find((region) => original >= region.start && original < region.end);
    const candidates = cut === undefined
      ? []
      : [cut.start - 1, cut.end]
          .filter((frame) => frame >= 0 && frame < map.originalTotalFrames)
          .sort((a, b) => Math.abs(a - original) - Math.abs(b - original));
    for (const candidate of candidates) {
      playback = originalToPlayback(candidate, map.cutRegions, map.ordering);
      if (playback !== null) break;
    }
  }
  const finalFrame = playbackToPlayer(playback ?? 0, map.finalModel);
  return clampFrame(finalFrame, map.finalModel.durationInFrames);
}

/** 素材確認Player（原本座標）の再生ヘッドを、完成後の全体帯へ投影する。 */
export function previewFrameToOverviewFrame(
  previewFrame: number,
  map: OverviewCoordinateMap,
): number {
  return originalFrameToOverviewFrame(previewFrame, map);
}

/** 完成後の全体帯で選んだ位置を、素材確認Playerの原本座標へ戻す。 */
export function overviewFrameToPreviewFrame(
  overviewFrame: number,
  map: OverviewCoordinateMap,
): number {
  const finalFrame = clampFrame(overviewFrame, map.finalModel.durationInFrames);
  const playback = playerToPlayback(finalFrame, map.finalModel);
  const original = playbackToOriginal(playback, map.cutRegions, map.ordering);
  return clampFrame(original, map.originalTotalFrames);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** 完成後フレームを全体帯の比率へ変換する。 */
export function overviewFractionForFrame(frame: number, totalFrames: number): number {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return 0;
  return clamp01(frame / totalFrames);
}

/** 全体帯のクリック比率を完成後フレームへ戻す。 */
export function frameAtOverviewFraction(fraction: number, totalFrames: number): number {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return 0;
  return Math.round(clamp01(fraction) * totalFrames);
}

/** 詳細側の両端を、完成後の全体帯に見える範囲として正規化する。 */
export function overviewWindowForFrames(
  firstFrame: number,
  lastFrame: number,
  totalFrames: number,
): OverviewWindow {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return { start: 0, end: 1 };
  const a = overviewFractionForFrame(firstFrame, totalFrames);
  const b = overviewFractionForFrame(lastFrame, totalFrames);
  return { start: Math.min(a, b), end: Math.max(a, b) };
}
