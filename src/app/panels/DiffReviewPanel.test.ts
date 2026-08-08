import { describe, it, expect } from 'vitest';
import { buildApprovePayload, cutBadgeLabel, telopBadgeLabel, seBadgeLabel, showDistillHint } from './DiffReviewPanel';
import type { LearningCutDiffItem, LearningSeDiffItem, LearningTelopDiffItem, LearningWordDiffItem } from '../../shared/types';

const cut = (kind: LearningCutDiffItem['kind'], text: string): LearningCutDiffItem => ({
  kind,
  startFrame: 0,
  endFrame: 30,
  startSec: 0,
  endSec: 1,
  text,
});
const word = (before: string, after: string): LearningWordDiffItem => ({ before, after });
const telop = (kind: LearningTelopDiffItem['kind'], before: string, after: string): LearningTelopDiffItem => ({
  kind,
  startFrame: 0,
  endFrame: 30,
  startSec: 0,
  endSec: 1,
  before,
  after,
});
const se = (kind: LearningSeDiffItem['kind'], file: string): LearningSeDiffItem => ({
  kind,
  startFrame: 0,
  startSec: 0,
  file,
  nearbyText: '文脈',
});

describe('buildApprovePayload', () => {
  const cutItems = [cut('added-cut', 'a'), cut('restored-cut', 'b'), cut('added-cut', 'c')];
  const wordItems = [word('誤1', '正1'), word('誤2', '正2')];
  const telopItems = [telop('changed', 'A', 'B'), telop('added', '', 'C')];
  const seItems = [se('added', 'a.mp3'), se('removed', 'b.mp3')];

  it('選択された index のカット/文字/テロップ/SE のみを集める', () => {
    const payload = buildApprovePayload(
      cutItems,
      wordItems,
      telopItems,
      seItems,
      new Set([0, 2]),
      new Set([1]),
      new Set([0]),
      new Set([1]),
    );
    expect(payload.cut).toEqual([cutItems[0], cutItems[2]]);
    expect(payload.words).toEqual([wordItems[1]]);
    expect(payload.telops).toEqual([telopItems[0]]);
    expect(payload.ses).toEqual([seItems[1]]);
  });

  it('全選択なら全件返す', () => {
    const payload = buildApprovePayload(
      cutItems,
      wordItems,
      telopItems,
      seItems,
      new Set([0, 1, 2]),
      new Set([0, 1]),
      new Set([0, 1]),
      new Set([0, 1]),
    );
    expect(payload.cut).toEqual(cutItems);
    expect(payload.words).toEqual(wordItems);
    expect(payload.telops).toEqual(telopItems);
    expect(payload.ses).toEqual(seItems);
  });

  it('未選択なら空配列', () => {
    const payload = buildApprovePayload(cutItems, wordItems, telopItems, seItems, new Set(), new Set(), new Set(), new Set());
    expect(payload.cut).toEqual([]);
    expect(payload.words).toEqual([]);
    expect(payload.telops).toEqual([]);
    expect(payload.ses).toEqual([]);
  });

  it('全項目 null なら空配列（選択があっても無視）', () => {
    const payload = buildApprovePayload(null, null, null, null, new Set([0]), new Set([0]), new Set([0]), new Set([0]));
    expect(payload.cut).toEqual([]);
    expect(payload.words).toEqual([]);
    expect(payload.telops).toEqual([]);
    expect(payload.ses).toEqual([]);
  });
});

describe('cutBadgeLabel', () => {
  it('added-cut は「追加カット」', () => {
    expect(cutBadgeLabel('added-cut')).toBe('追加カット');
  });
  it('restored-cut は「復元」', () => {
    expect(cutBadgeLabel('restored-cut')).toBe('復元');
  });
});

describe('telopBadgeLabel', () => {
  it('changed は「修正」', () => {
    expect(telopBadgeLabel('changed')).toBe('修正');
  });
  it('added は「追加」', () => {
    expect(telopBadgeLabel('added')).toBe('追加');
  });
  it('removed は「削除」', () => {
    expect(telopBadgeLabel('removed')).toBe('削除');
  });
});

describe('seBadgeLabel', () => {
  it('added は「追加」', () => {
    expect(seBadgeLabel('added')).toBe('追加');
  });
  it('removed は「削除」', () => {
    expect(seBadgeLabel('removed')).toBe('削除');
  });
});

describe('showDistillHint', () => {
  it('20 より大きいとき true', () => {
    expect(showDistillHint(21)).toBe(true);
  });
  it('20 以下は false', () => {
    expect(showDistillHint(20)).toBe(false);
    expect(showDistillHint(0)).toBe(false);
  });
});
