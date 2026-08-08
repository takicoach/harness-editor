import type { TranscriptWord, WordChip } from './types';

interface FrameRange {
  originalStart: number;
  originalEnd: number;
}

/**
 * テロップの原本フレーム区間に重なる transcript 単語を WordChip[] にする。
 * transcript の時刻は ms。sourceOffsetMs は transcript 原点とプロジェクト原点のズレ補正。
 */
export function buildWordChips(
  range: FrameRange,
  words: TranscriptWord[],
  fps: number,
  sourceOffsetMs = 0,
): WordChip[] {
  const msToFrame = (ms: number): number => Math.round(((ms - sourceOffsetMs) / 1000) * fps);
  const chips: WordChip[] = [];
  for (const w of words) {
    const startFrame = msToFrame(w.start);
    const endFrame = msToFrame(w.end);
    // 区間と少しでも重なれば採用
    if (endFrame <= range.originalStart || startFrame >= range.originalEnd) continue;
    chips.push({ text: w.text, originalStart: startFrame, originalEnd: endFrame });
  }
  return chips;
}
