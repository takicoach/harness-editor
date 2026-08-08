import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { CutRegion, EditorTitle, TitleSegment } from './types';

/** TitleSegment[]（再生フレーム）を EditorTitle[]（原本フレームアンカー）へ変換する。 */
export function anchorTitles(titles: TitleSegment[], regions: CutRegion[]): EditorTitle[] {
  return titles.map((t) => {
    const { startFrame, endFrame, originalStart, originalEnd, ...rest } = t;
    const hasExplicit =
      typeof originalStart === 'number' && Number.isFinite(originalStart) &&
      typeof originalEnd === 'number' && Number.isFinite(originalEnd);
    if (hasExplicit) {
      return { ...rest, originalStart, originalEnd };
    }
    return {
      ...rest,
      originalStart: playbackToOriginal(startFrame, regions),
      originalEnd: playbackToOriginal(endFrame, regions),
    };
  });
}

/** EditorTitle[]（原本フレーム）を TitleSegment[]（再生フレーム）へ射影する。 */
export function projectTitles(titles: EditorTitle[], regions: CutRegion[]): TitleSegment[] {
  return titles.map((t) => {
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

export interface TitleClampResult {
  titles: EditorTitle[];
  flaggedIds: number[];
}

/** カット区間と重なるタイトルの端を区間外へ寄せる。完全に飲まれたものは flagged にして残す。 */
export function clampTitles(titles: EditorTitle[], regions: CutRegion[]): TitleClampResult {
  const cuts = normalizeCutRegions(regions);
  const flaggedIds: number[] = [];
  const result = titles.map((t) => {
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
  return { titles: result, flaggedIds };
}
