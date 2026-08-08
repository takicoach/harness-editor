import { describe, expect, it } from 'vitest';
import { applyTelopFeedback, emptyTelopRules, type TelopFeedbackEntry } from './telopRules';

function entry(
  kind: TelopFeedbackEntry['kind'],
  before: string,
  after: string,
  videoId: string,
): TelopFeedbackEntry {
  return { videoId, timestamp: '2026-07-16T00:00:00Z', kind, before, after };
}

describe('applyTelopFeedback', () => {
  it('異なる動画で同じ before→after を2回観測すると昇格する', () => {
    const r1 = applyTelopFeedback(emptyTelopRules(), [entry('changed', '素振りする', '素振りをする', 'v1')]);
    expect(r1.rules).toEqual([]);
    const r2 = applyTelopFeedback(r1, [entry('changed', '素振りする', '素振りをする', 'v2')]);
    expect(r2.rules).toEqual([{ before: '素振りする', after: '素振りをする' }]);
  });

  it('同一 before に対し複数の after が閾値に達すると競合として保留する', () => {
    const r = applyTelopFeedback(emptyTelopRules(), [
      entry('changed', 'まえ', 'あと1', 'v1'),
      entry('changed', 'まえ', 'あと1', 'v2'),
      entry('changed', 'まえ', 'あと2', 'v3'),
      entry('changed', 'まえ', 'あと2', 'v4'),
    ]);
    expect(r.rules).toEqual([]);
    expect(r.conflicts).toEqual(['まえ']);
  });

  it('同一videoIdの再観測は加算されず昇格しない', () => {
    const r1 = applyTelopFeedback(emptyTelopRules(), [entry('changed', 'A', 'B', 'v1')]);
    const r2 = applyTelopFeedback(r1, [entry('changed', 'A', 'B', 'v1')]);
    expect(r2.rules).toEqual([]);
  });

  it('added/removed は before/after 対応がないためルール化しない', () => {
    const r = applyTelopFeedback(emptyTelopRules(), [
      entry('added', '', '新規テロップ', 'v1'),
      entry('added', '', '新規テロップ', 'v2'),
      entry('removed', '消えたテロップ', '', 'v1'),
      entry('removed', '消えたテロップ', '', 'v2'),
    ]);
    expect(r.rules).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });

  it('入力を破壊しない', () => {
    const base = emptyTelopRules();
    applyTelopFeedback(base, [entry('changed', 'A', 'B', 'v1')]);
    expect(base.meta.observations).toEqual({});
  });
});
