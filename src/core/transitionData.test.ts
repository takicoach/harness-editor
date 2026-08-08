import { describe, it, expect } from 'vitest';
import { formatTransitionArray, parseTransitionData, serializeTransitionData } from './transitionData';
import type { SceneTransition } from './types';

describe('formatTransitionArray', () => {
  it('id/at/kind/durationFrames を常に出力・color は fadeColor のみ', () => {
    const out = formatTransitionArray([
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 },
      { id: 2, at: 'head', kind: 'fadeColor', durationFrames: 15, color: '#0A84FF' },
    ]);
    expect(out).toContain('id: 1,');
    expect(out).toContain('at: 100,');
    expect(out).toContain('kind: "fadeBlack",');
    expect(out).toContain('durationFrames: 20,');
    expect(out).toContain('at: "head",');     // 文字列 at はクオート
    expect(out).toContain('color: "#0A84FF",');
  });
  it('fadeColor 以外は color を出力しない', () => {
    const out = formatTransitionArray([{ id: 1, at: 'tail', kind: 'fadeBlack', durationFrames: 20 }]);
    expect(out).not.toContain('color:');
  });
});

describe('serializeTransitionData', () => {
  it('元ソース無し・空配列なら null（孤立ファイルを作らない）', () => {
    expect(serializeTransitionData(null, [])).toBeNull();
  });
  it('元ソース無し・要素ありなら新規雛形を生成', () => {
    const out = serializeTransitionData(null, [{ id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 }]);
    expect(out).toContain('export const transitionData');
    expect(out).toContain('kind: "fadeBlack"');
  });
});

describe('parseTransitionData', () => {
  it('source=null は空配列', () => {
    expect(parseTransitionData(null, 60)).toEqual([]);
  });
  it('往復: serialize したものを parse すると同値（at の数値/文字列両方）', () => {
    const items: SceneTransition[] = [
      { id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 },
      { id: 2, at: 'head', kind: 'fadeColor', durationFrames: 15, color: '#0A84FF' },
    ];
    const src = serializeTransitionData(null, items)!;
    expect(parseTransitionData(src, 60)).toEqual(items);
  });
});
