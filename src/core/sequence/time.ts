import { SequenceError } from './errors';

/** Exact seconds, rates, or effect frames; units are supplied by the owning field. */
export interface Rational { num: number; den: number }
export const ZERO: Readonly<Rational> = Object.freeze({ num: 0, den: 1 });
export const ONE: Readonly<Rational> = Object.freeze({ num: 1, den: 1 });
const LIMIT = BigInt(Number.MAX_SAFE_INTEGER);

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reduced(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new SequenceError('INVALID_TIME', '時刻の分母は0にできません');
  if (den < 0n) { num = -num; den = -den; }
  const divisor = gcd(num, den);
  num /= divisor;
  den /= divisor;
  if (num > LIMIT || num < -LIMIT || den > LIMIT) {
    throw new SequenceError('TIME_OVERFLOW', '時刻の精度を保てる範囲を超えています');
  }
  return { num: Number(num), den: Number(den) };
}

export function rational(num: number, den = 1): Rational {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new SequenceError('INVALID_TIME', '時刻の分子と分母には整数が必要です');
  }
  return reduced(BigInt(num), BigInt(den));
}

/** Compound exact expressions keep intermediates wide; only the stored result is bounded. */
export function rationalFromBigInts(num:bigint,den:bigint):Rational {
  return reduced(num,den);
}

/** Preserves a finite decimal literally; 29.97 is NOT silently 30000/1001. */
export function rationalFromDecimal(value: number | string): Rational {
  const text = String(value);
  if (text.length > 1024) throw new SequenceError('TIME_OVERFLOW', '時刻の精度を保てる範囲を超えています');
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new SequenceError('INVALID_TIME', '有限の数値で時刻を指定してください');
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0) - fraction.length;
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) {
    throw new SequenceError('TIME_OVERFLOW', '時刻の精度を保てる範囲を超えています');
  }
  let num = BigInt(match[2]! + fraction) * (match[1] === '-' ? -1n : 1n);
  let den = 1n;
  if (exponent >= 0) num *= 10n ** BigInt(exponent);
  else den = 10n ** BigInt(-exponent);
  return reduced(num, den);
}

export function isRational(value: unknown): value is Rational {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Rational;
  return Number.isSafeInteger(v.num) && Number.isSafeInteger(v.den) && v.den > 0;
}

function terms(value: Rational): [bigint, bigint] {
  if (!isRational(value)) throw new SequenceError('INVALID_TIME', '時刻の形式が不正です');
  return [BigInt(value.num), BigInt(value.den)];
}

export function addTime(a: Rational, b: Rational): Rational {
  const [an, ad] = terms(a); const [bn, bd] = terms(b);
  return reduced(an * bd + bn * ad, ad * bd);
}
export function subtractTime(a: Rational, b: Rational): Rational {
  const [an, ad] = terms(a); const [bn, bd] = terms(b);
  return reduced(an * bd - bn * ad, ad * bd);
}
export function multiplyTime(a: Rational, b: Rational): Rational {
  const [an, ad] = terms(a); const [bn, bd] = terms(b);
  return reduced(an * bn, ad * bd);
}
export function divideTime(a: Rational, b: Rational): Rational {
  const [an, ad] = terms(a); const [bn, bd] = terms(b);
  return reduced(an * bd, ad * bn);
}
export function compareTime(a: Rational, b: Rational): -1 | 0 | 1 {
  const [an, ad] = terms(a); const [bn, bd] = terms(b);
  const delta = an * bd - bn * ad;
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function timeNumber(value: Rational): number {
  terms(value);
  return value.num / value.den;
}
/** Render a clock without forcing its intermediate position into the stored Rational limits. */
export function sampleTimeClock(offset: Rational, rate: Rational, frames: number) {
  if (!Number.isSafeInteger(frames)) throw new SequenceError('INVALID_TIME', 'フレームには整数が必要です');
  const [on, od] = terms(offset), [rn, rd] = terms(rate);
  const vn = on * rd + BigInt(frames) * rn * od, vd = od * rd;
  return {
    compare(time: Rational): -1 | 0 | 1 {
      const [tn, td] = terms(time), delta = vn * td - tn * vd;
      return delta < 0n ? -1 : delta > 0n ? 1 : 0;
    },
    progress(start: Rational, end: Rational): number {
      const [sn, sd] = terms(start), [en, ed] = terms(end);
      const numerator = (vn * sd - sn * vd) * ed, denominator = (en * sd - sn * ed) * vd;
      return denominator === 0n ? 0 : Number(numerator) / Number(denominator);
    },
  };
}
export function frameSeconds(frame: number, fps: Rational): Rational {
  if (compareTime(fps, ZERO) <= 0) throw new SequenceError('INVALID_TIME', 'fpsは正の値が必要です');
  return divideTime(rational(frame), fps);
}
export function floorTime(value: Rational): number {
  const [n, d] = terms(value);
  const floor = n >= 0n ? n / d : -((-n + d - 1n) / d);
  return Number(floor);
}
export function ceilTime(value: Rational): number {
  return -floorTime({ num: -value.num, den: value.den });
}
