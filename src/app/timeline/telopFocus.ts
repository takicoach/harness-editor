import { normalizeCutRegions, originalToPlayback } from '../../core/cutEngine';
import type { CutOrdering, CutRegion } from '../../core/types';

interface OriginalFrameRange {
  originalStart: number;
  originalEnd: number;
}

interface PlaybackSpan {
  start: number;
  length: number;
}

/**
 * テロップ内で実際に再生されるフレーム群の中央を、速度適用前の再生座標で返す。
 * カットで中央が断片の境界に来た場合は、新しい断片の fade 開始を避けて内側へ寄せる。
 */
export function telopFocusPlaybackFrame(
  telop: OriginalFrameRange,
  cutRegions: CutRegion[],
  ordering?: CutOrdering,
): number | null {
  const originalStart = Math.max(0, Math.ceil(telop.originalStart));
  const originalEnd = Math.max(originalStart, Math.ceil(telop.originalEnd));
  if (originalEnd <= originalStart) return null;

  const spans: PlaybackSpan[] = ordering !== undefined && ordering.segments.length > 0
    ? ordering.segments.flatMap((segment) => {
        const start = Math.max(originalStart, segment.originalStart);
        const end = Math.min(originalEnd, segment.originalEnd);
        if (end <= start) return [];
        return [{
          start: segment.playbackStart + (start - segment.originalStart),
          length: end - start,
        }];
      })
    : visibleSpansWithoutOrdering(originalStart, originalEnd, cutRegions);

  const total = spans.reduce((sum, span) => sum + span.length, 0);
  if (total <= 0) return null;

  let remaining = Math.floor(total / 2);
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!;
    if (remaining >= span.length) {
      remaining -= span.length;
      continue;
    }
    // 等長断片の境界などで中央が新しい断片の先頭に一致したら、
    // fade-in の開始フレームを避け、その断片の中央へ寄せる。
    const offset = remaining === 0 && index > 0 && span.length > 1
      ? Math.floor(span.length / 2)
      : remaining;
    return span.start + offset;
  }
  return null;
}

function visibleSpansWithoutOrdering(
  originalStart: number,
  originalEnd: number,
  cutRegions: CutRegion[],
): PlaybackSpan[] {
  const cuts = normalizeCutRegions(cutRegions);
  const originalSpans: Array<{ start: number; end: number }> = [];
  let cursor = originalStart;
  for (const cut of cuts) {
    if (cut.end <= cursor) continue;
    if (cut.start >= originalEnd) break;
    if (cut.start > cursor) {
      originalSpans.push({ start: cursor, end: Math.min(cut.start, originalEnd) });
    }
    cursor = Math.max(cursor, cut.end);
    if (cursor >= originalEnd) break;
  }
  if (cursor < originalEnd) originalSpans.push({ start: cursor, end: originalEnd });

  return originalSpans.flatMap((span) => {
    const playbackStart = originalToPlayback(span.start, cuts);
    return playbackStart === null
      ? []
      : [{ start: playbackStart, length: span.end - span.start }];
  });
}
