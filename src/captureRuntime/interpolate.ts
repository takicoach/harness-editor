/**
 * captureRuntime: interpolate（'remotion' の interpolate と同名 export・同値）
 *
 * 移植元: remotion@4.0.489
 *   `node_modules/remotion/dist/cjs/interpolate.js`
 *   （`interpolate` → `interpolateNumber` → `interpolateSegment` → `interpolateFunction`）
 * アルゴリズム（入力検証・セグメント探索・正規化→easing→出力写像の順序）を理解した上で
 * 自分の表現で再実装している（逐語転載はしていない）。
 *
 * 実使用は「数値 outputRange・easing は単一関数（未指定 or Easing.out(Easing.cubic)）・
 * extrapolate は既定(extend) か 'clamp'」のみ（M2a Task2 Step1 の機械抽出）。
 * 文字列/タプル outputRange・easing 配列・posterize・'identity'/'wrap'・
 * remotionShouldExtendRight 付き easing は **未実装で throw** する
 * （黙って違う値を返す状態を構造的に排除する）。
 */

import type { EasingFunction } from './easing';

export type ExtrapolateType = 'extend' | 'clamp';

export type InterpolateOptions = {
  easing?: EasingFunction;
  extrapolateLeft?: ExtrapolateType;
  extrapolateRight?: ExtrapolateType;
};

const unimplemented = (what: string): never => {
  throw new Error(`captureRuntime: 未実装オプション interpolate ${what}`);
};

const identityEasing: EasingFunction = (value) => value;

const assertSupportedExtrapolate = (
  side: 'extrapolateLeft' | 'extrapolateRight',
  value: unknown,
): void => {
  if (value === undefined || value === 'extend' || value === 'clamp') {
    return;
  }
  unimplemented(`${side}='${String(value)}'（実使用は extend / clamp のみ）`);
};

const resolveEasing = (easing: InterpolateOptions['easing']): EasingFunction => {
  if (easing === undefined) {
    return identityEasing;
  }
  if (Array.isArray(easing)) {
    return unimplemented('easing が配列（セグメント別 easing は実使用0件）');
  }
  if (typeof easing !== 'function') {
    return unimplemented('easing が関数でない');
  }
  if ((easing as { remotionShouldExtendRight?: unknown }).remotionShouldExtendRight === true) {
    return unimplemented(
      'easing.remotionShouldExtendRight（Easing.spring の tail 継続は実使用0件）',
    );
  }
  return easing;
};

/** 入力が属するセグメントの左端インデックスを返す */
const findSegment = (input: number, inputRange: readonly number[]): number => {
  let i = 1;
  for (; i < inputRange.length - 1; i++) {
    if (inputRange[i]! >= input) {
      break;
    }
  }
  return i - 1;
};

const interpolateSegment = (
  input: number,
  inputMin: number,
  inputMax: number,
  outputMin: number,
  outputMax: number,
  easing: EasingFunction,
  extrapolateLeft: ExtrapolateType,
  extrapolateRight: ExtrapolateType,
): number => {
  let value = input;

  if (value < inputMin && extrapolateLeft === 'clamp') {
    value = inputMin;
  }
  if (value > inputMax && extrapolateRight === 'clamp') {
    value = inputMax;
  }
  // 'extend' はクランプせずそのまま外挿する（Remotion 側も no-op）。

  if (outputMin === outputMax) {
    return outputMin;
  }

  // [inputMin, inputMax] → [0, 1] → easing → [outputMin, outputMax] の順に写す。
  // この 3 段の演算順序が Number 同値の要（順序を変えると丸めがずれる）。
  const progress = (value - inputMin) / (inputMax - inputMin);
  const eased = easing(progress);
  return eased * (outputMax - outputMin) + outputMin;
};

const assertFiniteNumbers = (name: string, values: readonly unknown[]): void => {
  if (values.length < 1) {
    throw new Error(`${name} must have at least 1 element`);
  }
  for (const value of values) {
    if (typeof value !== 'number') {
      throw new Error(`${name} must contain only numbers`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(
        `${name} must contain only finite numbers, but got [${values.join(',')}]`,
      );
    }
  }
};

export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: InterpolateOptions,
): number {
  if (typeof input === 'undefined') {
    throw new Error('input can not be undefined');
  }
  if (typeof inputRange === 'undefined') {
    throw new Error('inputRange can not be undefined');
  }
  if (typeof outputRange === 'undefined') {
    throw new Error('outputRange can not be undefined');
  }
  if (inputRange.length !== outputRange.length) {
    throw new Error(
      `inputRange (${inputRange.length}) and outputRange (${outputRange.length}) must have the same length`,
    );
  }

  if ((options as { posterize?: unknown } | undefined)?.posterize !== undefined) {
    unimplemented('posterize（実使用0件）');
  }
  assertSupportedExtrapolate('extrapolateLeft', options?.extrapolateLeft);
  assertSupportedExtrapolate('extrapolateRight', options?.extrapolateRight);

  assertFiniteNumbers('inputRange', inputRange);
  for (let i = 1; i < inputRange.length; i++) {
    if (!(inputRange[i]! > inputRange[i - 1]!)) {
      throw new Error(
        `inputRange must be strictly monotonically increasing but got [${inputRange.join(',')}]`,
      );
    }
  }

  const easing = resolveEasing(options?.easing);

  if (typeof input !== 'number') {
    throw new TypeError('Cannot interpolate an input which is not a number');
  }
  if (!Array.isArray(outputRange)) {
    throw new Error('outputRange must contain only numbers');
  }
  if (outputRange.some((output) => typeof output !== 'number')) {
    unimplemented(
      '数値以外の outputRange（文字列 transform / 数値タプルは実使用0件）',
    );
  }
  assertFiniteNumbers('outputRange', outputRange);

  if (inputRange.length === 1) {
    return outputRange[0]!;
  }

  const segment = findSegment(input, inputRange);
  return interpolateSegment(
    input,
    inputRange[segment]!,
    inputRange[segment + 1]!,
    outputRange[segment]!,
    outputRange[segment + 1]!,
    easing,
    options?.extrapolateLeft ?? 'extend',
    options?.extrapolateRight ?? 'extend',
  );
}
