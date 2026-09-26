import { describe, it, expect } from 'vitest';
import { addMotionKey, moveMotionKey, removeMotionKey, setMotionKeyAxis, toKeyframeMotion } from './motionKeyOps';
import type { Motion, MotionBase } from './motion';

const BASE: MotionBase = { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 };
const KF = (keys: Motion['keys']): Motion => ({ preset: 'keyframes', keys });

describe('toKeyframeMotion（キーフレーム編集モードへの切替）', () => {
  it('motion 無しからは開始 t=0 / 終了 t=1 の 2 点を base の値で作る', () => {
    const m = toKeyframeMotion(undefined, BASE);
    expect(m.preset).toBe('keyframes');
    expect(m.keys).toEqual([
      { t: 0, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
      { t: 1, x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
    ]);
  });
  it('既存プリセットからは解決済みの from/to を 2 点として引き継ぐ（見た目が変わらない）', () => {
    const m = toKeyframeMotion({ preset: 'zoomIn', intensity: 1 }, BASE);
    expect(m.keys?.[0]?.scale).toBeCloseTo(1, 10);
    expect(m.keys?.[1]?.scale).toBeCloseTo(1.8, 10);
  });
  it('既にキーフレームならそのまま返す', () => {
    const src = KF([{ t: 0, scale: 1 }]);
    expect(toKeyframeMotion(src, BASE)).toEqual(src);
  });
});

describe('addMotionKey（打つ）', () => {
  it('指定 t にその時点の補間値でキーを差し込む（絵が変わらない）', () => {
    const m = KF([{ t: 0, scale: 1, x: 0, y: 0, opacity: 1, rotation: 0 }, { t: 1, scale: 2, x: 0, y: 0, opacity: 1, rotation: 0 }]);
    const next = addMotionKey(m, 0.5, BASE);
    expect(next.keys).toHaveLength(3);
    expect(next.keys?.[1]?.t).toBe(0.5);
    expect(next.keys?.[1]?.scale).toBeCloseTo(1.5, 10);
  });
  it('同じ t のキーが既にあるなら増やさない', () => {
    const m = KF([{ t: 0, scale: 1 }, { t: 1, scale: 2 }]);
    expect(addMotionKey(m, 0, BASE).keys).toHaveLength(2);
  });
  it('t 昇順を保つ', () => {
    const m = KF([{ t: 0, scale: 1 }, { t: 1, scale: 2 }]);
    const next = addMotionKey(addMotionKey(m, 0.8, BASE), 0.2, BASE);
    expect(next.keys?.map((k) => k.t)).toEqual([0, 0.2, 0.8, 1]);
  });
});

describe('moveMotionKey（動かす）', () => {
  it('t だけを変える（他のキーはそのまま）', () => {
    const m = KF([{ t: 0, x: -1 }, { t: 0.5, x: 0 }, { t: 1, x: 1 }]);
    const next = moveMotionKey(m, 1, 0.9);
    expect(next.keys?.[1]).toEqual({ t: 0.9, x: 0 });
    expect(next.keys?.[0]).toEqual({ t: 0, x: -1 });
    expect(next.keys?.[2]).toEqual({ t: 1, x: 1 });
  });
  it('他のキーを追い越しても配列の並びは変わらない（UI が掴んでいるキーが入れ替わらない）', () => {
    // 並べ替えると、ドラッグ中のスライダー（配列 index で対象を指す）が別のキーを掴む。
    // 補間側（sampleMotionKeys）は評価時に自分で昇順化するので、保持順は自由でよい。
    const m = KF([{ t: 0, x: -1 }, { t: 0.5, x: 0 }, { t: 1, x: 1 }]);
    const next = moveMotionKey(m, 2, 0.2);
    expect(next.keys?.map((k) => k.x)).toEqual([-1, 0, 1]);
    expect(next.keys?.map((k) => k.t)).toEqual([0, 0.5, 0.2]);
    // 続けて同じ index を動かしても同じキーが動く。
    const again = moveMotionKey(next, 2, 0.1);
    expect(again.keys?.[2]).toEqual({ t: 0.1, x: 1 });
  });
  it('t は 0..1 にクランプ', () => {
    const m = KF([{ t: 0, x: 0 }, { t: 1, x: 1 }]);
    expect(moveMotionKey(m, 0, -5).keys?.[0]?.t).toBe(0);
    expect(moveMotionKey(m, 1, 5).keys?.[1]?.t).toBe(1);
  });
  it('範囲外 index は無変更', () => {
    const m = KF([{ t: 0, x: 0 }]);
    expect(moveMotionKey(m, 7, 0.5)).toEqual(m);
  });
});

describe('removeMotionKey（消す）', () => {
  it('指定 index を消す', () => {
    const m = KF([{ t: 0, x: 0 }, { t: 0.5, x: 1 }, { t: 1, x: 0 }]);
    expect(removeMotionKey(m, 1)?.keys?.map((k) => k.t)).toEqual([0, 1]);
  });
  it('最後の 1 点を消したら motion 自体を外す（undefined）', () => {
    const m = KF([{ t: 0, x: 0 }]);
    expect(removeMotionKey(m, 0)).toBeUndefined();
  });
  it('範囲外 index は無変更', () => {
    const m = KF([{ t: 0, x: 0 }]);
    expect(removeMotionKey(m, 3)).toEqual(m);
  });
});

describe('setMotionKeyAxis（値をいじる）', () => {
  it('指定軸だけ差し替える', () => {
    const m = KF([{ t: 0, x: 0 }, { t: 1, x: 1 }]);
    const next = setMotionKeyAxis(m, 0, 'scale', 1.5);
    expect(next.keys?.[0]).toEqual({ t: 0, x: 0, scale: 1.5 });
    expect(next.keys?.[1]).toEqual({ t: 1, x: 1 });
  });
  it('範囲外 index は無変更', () => {
    const m = KF([{ t: 0, x: 0 }]);
    expect(setMotionKeyAxis(m, 5, 'scale', 2)).toEqual(m);
  });
});
