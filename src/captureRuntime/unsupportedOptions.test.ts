/**
 * 未実装オプションが「黙って違う値を返さない」ことの検査（M2a Task2）。
 *
 * captureRuntime の数値層は実使用で踏むオプションだけを実装する（YAGNI）。
 * 踏まないオプションを渡されたら必ず throw する — これが無いと、
 * 撮影経路だけ挙動が違うのに緑のまま通ってしまう。
 */
import { describe, expect, it } from 'vitest';

import { Easing } from './easing';
import { interpolate } from './interpolate';
import { spring } from './spring';

describe('interpolate — 未実装オプションは throw', () => {
  it('extrapolateLeft: identity', () => {
    expect(() =>
      interpolate(5, [0, 10], [0, 1], {
        extrapolateLeft: 'identity' as never,
      }),
    ).toThrow(/未実装オプション/);
  });

  it('extrapolateRight: wrap', () => {
    expect(() =>
      interpolate(5, [0, 10], [0, 1], {
        extrapolateRight: 'wrap' as never,
      }),
    ).toThrow(/未実装オプション/);
  });

  it('posterize', () => {
    expect(() =>
      interpolate(5, [0, 10], [0, 1], { posterize: 2 } as never),
    ).toThrow(/未実装オプション/);
  });

  it('easing が配列', () => {
    expect(() =>
      interpolate(5, [0, 10], [0, 1], {
        easing: [(t: number) => t] as never,
      }),
    ).toThrow(/未実装オプション/);
  });

  it('easing に remotionShouldExtendRight（Easing.spring の tail）', () => {
    const tailEasing = Object.assign((t: number) => t, {
      remotionShouldExtendRight: true,
    });
    expect(() =>
      interpolate(5, [0, 10], [0, 1], { easing: tailEasing }),
    ).toThrow(/未実装オプション/);
  });

  it('文字列 outputRange', () => {
    expect(() =>
      interpolate(5, [0, 10], ['0px', '10px'] as never, undefined),
    ).toThrow(/未実装オプション/);
  });

  it('タプル outputRange', () => {
    expect(() =>
      interpolate(5, [0, 10], [[0, 0], [1, 1]] as never, undefined),
    ).toThrow(/未実装オプション/);
  });
});

describe('interpolate — real remotion と同じ入力検証で throw', () => {
  it('inputRange と outputRange の長さ不一致', () => {
    expect(() => interpolate(5, [0, 10], [0, 1, 2])).toThrow(
      /must have the same length/,
    );
  });

  it('inputRange が狭義単調増加でない', () => {
    expect(() => interpolate(5, [0, 10, 10], [0, 1, 2])).toThrow(
      /strictly monotonically increasing/,
    );
  });

  it('inputRange が1要素なら outputRange[0] を返す', () => {
    expect(interpolate(5, [3], [0.42])).toBe(0.42);
  });

  it('非有限値を含む inputRange', () => {
    expect(() => interpolate(5, [0, Infinity], [0, 1])).toThrow(
      /finite numbers/,
    );
  });
});

describe('spring — 未実装オプションは throw', () => {
  const config = { damping: 20, stiffness: 100, mass: 0.5 };

  for (const key of [
    'from',
    'to',
    'durationInFrames',
    'durationRestThreshold',
    'delay',
    'reverse',
  ]) {
    it(`トップレベル ${key}`, () => {
      expect(() =>
        spring({ frame: 5, fps: 30, config, [key]: 1 } as never),
      ).toThrow(/未実装オプション/);
    });
  }

  it('config.overshootClamping', () => {
    expect(() =>
      spring({
        frame: 5,
        fps: 30,
        config: { ...config, overshootClamping: true },
      } as never),
    ).toThrow(/未実装オプション/);
  });

  it('未知の config キー', () => {
    expect(() =>
      spring({ frame: 5, fps: 30, config: { ...config, stiffnes: 100 } } as never),
    ).toThrow(/未実装オプション/);
  });

  it('damping <= 0（real remotion と同じく無限ループ回避で throw）', () => {
    expect(() =>
      spring({ frame: 5, fps: 30, config: { ...config, damping: 0 } }),
    ).toThrow(/damping/);
  });

  it('fps が正の有限数でない', () => {
    expect(() => spring({ frame: 5, fps: 0, config })).toThrow(/fps/);
  });
});

describe('Easing — 未実装の関数は throw', () => {
  it('Easing.bezier', () => {
    expect(() => Easing.bezier(0.42, 0, 1, 1)).toThrow(/未実装オプション/);
  });

  it('Easing.inOut', () => {
    expect(() => Easing.inOut(Easing.cubic)).toThrow(/未実装オプション/);
  });

  it('Easing.spring', () => {
    expect(() => Easing.spring()).toThrow(/未実装オプション/);
  });
});
