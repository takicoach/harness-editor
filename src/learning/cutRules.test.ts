import { describe, expect, it } from 'vitest';
import { applyCutFeedback, emptyCutRules, type CutFeedbackEntry } from './cutRules';

function entry(
  kind: 'added-cut' | 'restored-cut',
  text: string,
  videoId: string,
): CutFeedbackEntry {
  return { videoId, timestamp: '2026-07-03T00:00:00Z', kind, startFrame: 0, endFrame: 10, text };
}

describe('applyCutFeedback', () => {
  it('異なる動画で added-cut を2回観測した語は action:cut ルールに昇格する', () => {
    const r1 = applyCutFeedback(emptyCutRules(), [entry('added-cut', 'えーと', 'v1')]);
    expect(r1.rules).toEqual([]); // 1回では昇格しない
    const r2 = applyCutFeedback(r1, [entry('added-cut', 'えーと', 'v2')]);
    expect(r2.rules).toEqual([{ text: 'えーと', action: 'cut' }]);
    expect(r2.meta.observations['えーと']).toEqual({
      added: 2,
      restored: 0,
      addedVideos: ['v1', 'v2'],
      restoredVideos: [],
    });
  });

  it('異なる動画で restored-cut を2回観測した語は action:keep ルールに昇格する', () => {
    const r = applyCutFeedback(emptyCutRules(), [
      entry('restored-cut', 'なので', 'v1'),
      entry('restored-cut', 'なので', 'v2'),
    ]);
    expect(r.rules).toEqual([{ text: 'なので', action: 'keep' }]);
  });

  it('added と restored の両方で観測された語は競合として保留しルール化しない', () => {
    const r = applyCutFeedback(emptyCutRules(), [
      entry('added-cut', 'まあ', 'v1'),
      entry('added-cut', 'まあ', 'v2'),
      entry('restored-cut', 'まあ', 'v3'),
    ]);
    expect(r.rules).toEqual([]);
    expect(r.conflicts).toEqual(['まあ']);
  });

  it('入力を破壊しない', () => {
    const base = emptyCutRules();
    applyCutFeedback(base, [entry('added-cut', 'えー', 'v1')]);
    expect(base.meta.observations).toEqual({});
  });

  it('同一videoIdの再観測は加算されず昇格閾値に届かない', () => {
    const r1 = applyCutFeedback(emptyCutRules(), [entry('added-cut', 'フィラー', 'v1')]);
    const r2 = applyCutFeedback(r1, [entry('added-cut', 'フィラー', 'v1')]);
    expect(r2.meta.observations['フィラー']).toEqual({
      added: 1,
      restored: 0,
      addedVideos: ['v1'],
      restoredVideos: [],
    });
    expect(r2.rules).toEqual([]);
  });

  it('異なる2つのvideoIdでの観測は加算され昇格閾値に届く', () => {
    const r1 = applyCutFeedback(emptyCutRules(), [entry('added-cut', 'フィラー', 'v1')]);
    const r2 = applyCutFeedback(r1, [entry('added-cut', 'フィラー', 'v2')]);
    expect(r2.meta.observations['フィラー']).toEqual({
      added: 2,
      restored: 0,
      addedVideos: ['v1', 'v2'],
      restoredVideos: [],
    });
    expect(r2.rules).toEqual([{ text: 'フィラー', action: 'cut' }]);
  });
});
