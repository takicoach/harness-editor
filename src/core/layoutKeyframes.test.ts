import { describe, it, expect } from 'vitest';
import { parse, format, sampleAtOriginalFrame, type LayoutKeyframe } from './layoutKeyframes';

describe('layoutKeyframes.parse', () => {
  it('2要素の配列を parse できる（originalFrame 昇順）', () => {
    const value = [
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 30, x: 0.5, y: -0.25, scale: 2, rotation: 90 },
    ];
    expect(parse(value)).toEqual(value);
  });
  it('順不同の入力は originalFrame 昇順にソートされる', () => {
    const value = [
      { originalFrame: 30, x: 1, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    ];
    expect(parse(value)).toEqual([
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 30, x: 1, y: 0, scale: 1, rotation: 0 },
    ]);
  });
  it('配列でない/空は undefined（1点は許容＝旧仕様と異なり大域KFは1点でも parse は通す）', () => {
    expect(parse(undefined)).toBeUndefined();
    expect(parse(null)).toBeUndefined();
    expect(parse([])).toBeUndefined();
    expect(parse('nope')).toBeUndefined();
    expect(parse([{ originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }])).toEqual([
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    ]);
  });
  it('欠損フィールドは既定値へフォールバック', () => {
    const parsed = parse([{}, { x: 1 }]);
    expect(parsed).toEqual([
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 0, x: 1, y: 0, scale: 1, rotation: 0 },
    ]);
  });
  it('範囲外はクランプ（pos -1..1 / scale 0.1..8 / rotation -180..180 / originalFrame 非負整数）', () => {
    const parsed = parse([
      { originalFrame: -5, x: 9, y: -9, scale: 99, rotation: 999 },
      { originalFrame: 10.6, x: 0, y: 0, scale: 0.001, rotation: -999 },
    ]);
    expect(parsed).toEqual([
      { originalFrame: 0, x: 1, y: -1, scale: 8, rotation: 180 },
      { originalFrame: 11, x: 0, y: 0, scale: 0.1, rotation: -180 },
    ]);
  });
  it('要素に不正な型が混じれば全体を undefined', () => {
    expect(parse([{ originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 }, null])).toBeUndefined();
  });
});

describe('layoutKeyframes.format', () => {
  it('parse した結果をそのまま format→parse で往復できる', () => {
    const keyframes: LayoutKeyframe[] = [
      { originalFrame: 0, x: 0.5, y: -0.25, scale: 1.4, rotation: 90 },
      { originalFrame: 45, x: -0.5, y: 0.25, scale: 2, rotation: -45 },
    ];
    const src = format(keyframes);
    expect(src).toContain('[');
    // format した文字列は JS リテラルとして評価可能で parse できる
    // eslint-disable-next-line no-eval
    const evaluated = eval(src);
    expect(parse(evaluated)).toEqual(keyframes);
  });
});

describe('layoutKeyframes.sampleAtOriginalFrame', () => {
  const kfs: LayoutKeyframe[] = [
    { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
    { originalFrame: 100, x: 1, y: -1, scale: 2, rotation: 90 },
  ];
  it('先頭 KF より前は先頭キーフレームで固定', () => {
    expect(sampleAtOriginalFrame(kfs, -10)).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 });
    expect(sampleAtOriginalFrame(kfs, 0)).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 });
  });
  it('末尾 KF より後は終端キーフレームで固定', () => {
    expect(sampleAtOriginalFrame(kfs, 100)).toEqual({ x: 1, y: -1, scale: 2, rotation: 90 });
    expect(sampleAtOriginalFrame(kfs, 9999)).toEqual({ x: 1, y: -1, scale: 2, rotation: 90 });
  });
  it('中間（ease-in-out なので線形の 0.5 と一致）', () => {
    const mid = sampleAtOriginalFrame(kfs, 50);
    expect(mid.scale).toBeCloseTo(1.5, 5);
    expect(mid.x).toBeCloseTo(0.5, 5);
  });
  it('可変間隔（非等間隔の originalFrame）でも区分ごとに正しく補間する', () => {
    const uneven: LayoutKeyframe[] = [
      { originalFrame: 0, x: 0, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 10, x: 1, y: 0, scale: 1, rotation: 0 },
      { originalFrame: 210, x: 1, y: 0, scale: 3, rotation: 0 },
    ];
    // 区間 [0,10] の中間(5)は progress 0.5 で x が 0.5 付近。
    expect(sampleAtOriginalFrame(uneven, 5).x).toBeCloseTo(0.5, 5);
    // 区間 [10,210] の中間(110)は progress 0.5 で scale が 2 付近。
    expect(sampleAtOriginalFrame(uneven, 110).scale).toBeCloseTo(2, 5);
    // 区間の境目（originalFrame=10）はジャンプなくちょうど両区間の共有値。
    expect(sampleAtOriginalFrame(uneven, 10)).toEqual({ x: 1, y: 0, scale: 1, rotation: 0 });
  });
  it('要素が1つなら常にそのキーフレーム（クランプ後）', () => {
    expect(sampleAtOriginalFrame([{ originalFrame: 5, x: 0.2, y: 0, scale: 1, rotation: 0 }], 100)).toEqual({ x: 0.2, y: 0, scale: 1, rotation: 0 });
  });
  it('要素が0なら恒等値', () => {
    expect(sampleAtOriginalFrame([], 50)).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 });
  });
});
