import { describe, expect, it } from 'vitest';
import { hasReviewableDiff } from './useLearningDiff';
import type { LearningDiffResponse } from '../shared/types';

const EMPTY: LearningDiffResponse = { cut: null, words: null, telops: null, ses: null, undistilledCount: 0 };

describe('hasReviewableDiff', () => {
  it('全項目 null なら false', () => {
    expect(hasReviewableDiff(EMPTY)).toBe(false);
  });

  it('全項目空配列なら false', () => {
    const diff: LearningDiffResponse = { cut: [], words: [], telops: [], ses: [], undistilledCount: 0 };
    expect(hasReviewableDiff(diff)).toBe(false);
  });

  it('cut が 1 件あれば true', () => {
    const diff: LearningDiffResponse = {
      ...EMPTY,
      cut: [{ kind: 'added-cut', startFrame: 0, endFrame: 10, startSec: 0, endSec: 1, text: '' }],
    };
    expect(hasReviewableDiff(diff)).toBe(true);
  });

  it('words が 1 件あれば true', () => {
    const diff: LearningDiffResponse = { ...EMPTY, words: [{ before: 'あ', after: 'い' }] };
    expect(hasReviewableDiff(diff)).toBe(true);
  });

  it('telops が 1 件あれば true', () => {
    const diff: LearningDiffResponse = {
      ...EMPTY,
      telops: [{ kind: 'changed', startFrame: 0, endFrame: 10, startSec: 0, endSec: 1, before: 'A', after: 'B' }],
    };
    expect(hasReviewableDiff(diff)).toBe(true);
  });

  it('ses が 1 件あれば true', () => {
    const diff: LearningDiffResponse = {
      ...EMPTY,
      ses: [{ kind: 'added', startFrame: 0, startSec: 0, file: 'a.mp3', nearbyText: '' }],
    };
    expect(hasReviewableDiff(diff)).toBe(true);
  });
});
