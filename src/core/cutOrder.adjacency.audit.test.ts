import { describe, expect, it } from 'vitest';
import { buildCutOrdering } from './cutOrder';

function permutations(items: number[]): number[][] {
  return items.length ? items.flatMap((head, index) => permutations(items.filter((_, i) => i !== index)).map(tail => [head, ...tail])) : [[]];
}

describe('independent adjacent cut ordering audit', () => {
  it('reproduces every source frame in the requested order for all 24 four-span permutations and partial cuts', () => {
    for (const order of permutations([0, 1, 2, 3])) {
      const anchors = order.map(i => ({ originalStart: i * 10, originalEnd: (i + 1) * 10 }));
      for (const cuts of [[], [{ start: 13, end: 17 }], [{ start: 0, end: 10 }, { start: 23, end: 24 }]]) {
        const expected = order.flatMap(i => Array.from({ length: 10 }, (_, frame) => i * 10 + frame))
          .filter(frame => !cuts.some(cut => frame >= cut.start && frame < cut.end));
        const actual = buildCutOrdering(40, cuts, anchors);
        expect(actual.segments.flatMap(span => Array.from({ length: span.originalEnd - span.originalStart }, (_, i) => span.originalStart + i))).toEqual(expected);
        let cursor = 0;
        actual.segments.forEach(span => {
          expect(span.playbackStart).toBe(cursor);
          cursor += span.originalEnd - span.originalStart;
          expect(span.playbackEnd).toBe(cursor);
        });
        expect(cursor).toBe(expected.length);
      }
    }
  });
});
