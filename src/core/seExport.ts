import { clampSe, projectSe } from './seAnchor';
import { reorderSe } from './cutOrder';
import type { CutOrdering, CutRegion, EditorSe } from './types';
import type { SePlayback } from './types';

/**
 * SE の再生導出の正本（プレビューと書き出しで共有 — 描き手は1つ）。
 * serializeProject / buildPlaybackModel と同型: clampSe→projectSe→reorder の順で射影し、
 * 縮退区間（endFrame<=startFrame）を除外して volume を 1 に解決する。
 * 返り値は**再生座標**。最終座標化（collapse）は exportTimeline.attachAudio だけが行う。
 */
export function deriveSePlayback(
  se: readonly EditorSe[],
  cutRegions: CutRegion[],
  ordering: CutOrdering | undefined,
): SePlayback[] {
  const { se: clampedSe } = clampSe([...se], cutRegions);
  return reorderSe(projectSe(clampedSe, cutRegions), ordering)
    .filter((s) => (s.endFrame ?? 0) > s.startFrame)
    .map((s) => ({
      id: s.id,
      playbackFrame: s.startFrame,
      playbackEnd: s.endFrame ?? s.startFrame,
      file: s.file,
      volume: s.volume ?? 1,
      fadeInFrames: s.fadeInFrames,
      fadeOutFrames: s.fadeOutFrames,
    }));
}
