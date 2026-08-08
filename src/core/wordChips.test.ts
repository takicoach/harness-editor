import { describe, it, expect } from 'vitest';
import { buildWordChips } from './wordChips';
import type { TranscriptWord } from './types';

const words: TranscriptWord[] = [
  { text: 'ゆる', start: 500, end: 800 },
  { text: '素振り', start: 800, end: 1200 },
  { text: '長い', start: 3400, end: 3700 },
];

describe('buildWordChips', () => {
  it('テロップ区間に重なる単語をフレーム単位のチップにする（fps=60）', () => {
    // 区間 0〜120フレーム = 0〜2000ms。最初の 2 単語が該当。
    const chips = buildWordChips({ originalStart: 0, originalEnd: 120 }, words, 60);
    expect(chips).toHaveLength(2);
    expect(chips[0]).toEqual({ text: 'ゆる', originalStart: 30, originalEnd: 48 });
  });

  it('区間外の単語は含めない', () => {
    const chips = buildWordChips({ originalStart: 0, originalEnd: 120 }, words, 60);
    expect(chips.find((c) => c.text === '長い')).toBeUndefined();
  });

  it('sourceOffsetMs ぶん transcript 時刻をずらせる', () => {
    // offset 500ms ぶん前へずれる → 「ゆる」は 0ms 始まりになる
    const chips = buildWordChips({ originalStart: 0, originalEnd: 120 }, words, 60, 500);
    expect(chips[0]!.originalStart).toBe(0);
  });

  it('該当単語が無ければ空配列', () => {
    expect(buildWordChips({ originalStart: 9000, originalEnd: 9100 }, words, 60)).toEqual([]);
  });
});
