import { describe, it, expect } from 'vitest';
import { diffSegmentText } from './segmentDiff';
import { diffTranscriptFixed } from './segmentDiff';
import type { TranscriptFixed } from './types';

describe('diffSegmentText', () => {
  it('共通接頭辞・接尾辞を剥がし変化部分を返す', () => {
    expect(diffSegmentText('ゼロ式ドリル', '零式ドリル')).toEqual({ before: 'ゼロ', after: '零' });
  });

  it('接頭辞のみ共通のケース', () => {
    expect(diffSegmentText('当て感ねん', '当て感')).toBeNull(); // 純粋な削除は対象外
  });

  it('全置換（共通部分なし）', () => {
    expect(diffSegmentText('1の肩', '壱の型')).toEqual({ before: '1の肩', after: '壱の型' });
  });

  it('変化なしは null', () => {
    expect(diffSegmentText('同じ', '同じ')).toBeNull();
  });

  it('純粋な挿入は null', () => {
    expect(diffSegmentText('テスト', 'テストです')).toBeNull();
  });
});

describe('diffTranscriptFixed', () => {
  it('対応するセグメントの語句置換を集める', () => {
    const baseline: TranscriptFixed = {
      segments: [
        { text: 'ゼロ式ドリル', start: 0, end: 1 },
        { text: '変わらない', start: 2, end: 3 },
        { text: '1の肩', start: 4, end: 5 },
      ],
    };
    const final: TranscriptFixed = {
      segments: [
        { text: '零式ドリル', start: 0, end: 1 },
        { text: '変わらない', start: 2, end: 3 },
        { text: '壱の型', start: 4, end: 5 },
      ],
    };
    expect(diffTranscriptFixed(baseline, final)).toEqual([
      { before: 'ゼロ', after: '零' },
      { before: '1の肩', after: '壱の型' },
    ]);
  });

  it('セグメント数が違えば誤学習を防ぐため何も返さない', () => {
    const baseline: TranscriptFixed = { segments: [{ text: 'あ', start: 0, end: 1 }] };
    const final: TranscriptFixed = {
      segments: [
        { text: 'い', start: 0, end: 1 },
        { text: 'う', start: 2, end: 3 },
      ],
    };
    expect(diffTranscriptFixed(baseline, final)).toEqual([]);
  });
});
