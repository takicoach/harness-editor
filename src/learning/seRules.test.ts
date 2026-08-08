import { describe, expect, it } from 'vitest';
import { applySeFeedback, emptySeRules, type SeFeedbackEntry } from './seRules';

function entry(kind: 'added' | 'removed', seFile: string, contextText: string, videoId: string): SeFeedbackEntry {
  return { videoId, timestamp: '2026-07-16T00:00:00Z', kind, seFile, contextText };
}

describe('applySeFeedback', () => {
  it('異なる動画で added を2回観測した文脈×SE名は action:add ルールに昇格する', () => {
    const r1 = applySeFeedback(emptySeRules(), [entry('added', 'whoosh.mp3', 'ここで素振り', 'v1')]);
    expect(r1.rules).toEqual([]);
    const r2 = applySeFeedback(r1, [entry('added', 'whoosh.mp3', 'ここで素振り', 'v2')]);
    expect(r2.rules).toEqual([{ seFile: 'whoosh.mp3', contextText: 'ここで素振り', action: 'add' }]);
  });

  it('異なる動画で removed を2回観測すると action:remove ルールに昇格する', () => {
    const r = applySeFeedback(emptySeRules(), [
      entry('removed', 'pop.mp3', 'ズレた場面', 'v1'),
      entry('removed', 'pop.mp3', 'ズレた場面', 'v2'),
    ]);
    expect(r.rules).toEqual([{ seFile: 'pop.mp3', contextText: 'ズレた場面', action: 'remove' }]);
  });

  it('add と remove の両方で観測された組は競合として保留する', () => {
    const r = applySeFeedback(emptySeRules(), [
      entry('added', 'whoosh.mp3', '同じ文脈', 'v1'),
      entry('added', 'whoosh.mp3', '同じ文脈', 'v2'),
      entry('removed', 'whoosh.mp3', '同じ文脈', 'v3'),
      entry('removed', 'whoosh.mp3', '同じ文脈', 'v4'),
    ]);
    expect(r.rules).toEqual([]);
    expect(r.conflicts).toEqual(['whoosh.mp3::同じ文脈']);
  });

  it('同一videoIdの再観測は加算されず昇格閾値に届かない', () => {
    const r1 = applySeFeedback(emptySeRules(), [entry('added', 'a.mp3', '文脈', 'v1')]);
    const r2 = applySeFeedback(r1, [entry('added', 'a.mp3', '文脈', 'v1')]);
    expect(r2.rules).toEqual([]);
  });

  it('入力を破壊しない', () => {
    const base = emptySeRules();
    applySeFeedback(base, [entry('added', 'a.mp3', '文脈', 'v1')]);
    expect(base.meta.observations).toEqual({});
  });
});
