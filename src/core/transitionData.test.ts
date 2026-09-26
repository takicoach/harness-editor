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

  /**
   * B-0（2026-09-02）: JoinSettings には方向 UI があるのに `direction` が書き出されず、
   * 保存 → 再読込で方向が既定（left）へ戻っていた。
   */
  it('slide/wipe の direction を出力する（未指定なら書かない・他 kind でも書かない）', () => {
    expect(formatTransitionArray([{ id: 1, at: 10, kind: 'slide', durationFrames: 8, direction: 'up' }]))
      .toContain('direction: "up",');
    expect(formatTransitionArray([{ id: 1, at: 10, kind: 'wipe', durationFrames: 8, direction: 'right' }]))
      .toContain('direction: "right",');
    // 未指定は書かない（既存ファイルの出力を 1 バイトも変えない＝バイト同値ゲートに影響しない）。
    expect(formatTransitionArray([{ id: 1, at: 10, kind: 'wipe', durationFrames: 8 }]))
      .not.toContain('direction');
    // fade 系は direction を持たない（万一入っていても書かない）。
    expect(formatTransitionArray([
      { id: 1, at: 10, kind: 'fadeBlack', durationFrames: 8, direction: 'up' },
    ])).not.toContain('direction');
  });

  it('direction 未指定の既存要素は出力が従来と 1 バイトも変わらない（バイト同値ゲート）', () => {
    expect(formatTransitionArray([{ id: 1, at: 100, kind: 'fadeBlack', durationFrames: 20 }])).toBe(
      '[\n  {\n    id: 1,\n    at: 100,\n    kind: "fadeBlack",\n    durationFrames: 20,\n  },\n]',
    );
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

  it('往復: slide/wipe の direction が保存 → 再読込で保持される（B-0）', () => {
    const items: SceneTransition[] = [
      { id: 1, at: 100, kind: 'slide', durationFrames: 20, direction: 'up' },
      { id: 2, at: 200, kind: 'wipe', durationFrames: 15, direction: 'down' },
      { id: 3, at: 300, kind: 'wipe', durationFrames: 15 }, // 未指定は未指定のまま
    ];
    const src = serializeTransitionData(null, items)!;
    expect(parseTransitionData(src, 60)).toEqual(items);
  });
});
