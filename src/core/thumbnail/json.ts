import { SequenceError } from '../sequence/errors';
import { isRational, rational } from '../sequence/time';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function fail(message: string): never { throw new SequenceError('INVALID_DOCUMENT', message); }

/** NaN・循環・独自クラス・穴あき配列を、正規化で情報が落ちる前に拒否する。 */
export function assertPlainJson(value: unknown, stack = new Set<object>()): void {
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('保存する数値に NaN または Infinity があります'); return; }
  if (typeof value !== 'object') fail('保存できない値が含まれています');
  const object = value as object;
  if (stack.has(object)) fail('サムネのデータが循環参照しています');
  if (!Array.isArray(object) && Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) fail('保存データには通常の JSON オブジェクトが必要です');
  stack.add(object);
  if (Array.isArray(object)) {
    const keys = Object.keys(object);
    if (keys.length !== object.length || keys.some((key, index) => key !== String(index))) fail('配列に未定義の要素または余分な属性があります');
  }
  for (const child of Object.values(object)) {
    if (Array.isArray(object) && child === undefined) fail('配列に未定義の値があります');
    assertPlainJson(child, stack);
  }
  stack.delete(object);
}
/** キーを並べ替え、undefined を落とし、有理数を既約にする。同じ内容は同じバイト列になる。 */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!record(value)) return Object.is(value, -0) ? 0 : value;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  if (keys.length === 2 && keys[0] === 'den' && keys[1] === 'num' && isRational(value)) {
    const reduced = rational(value.num, value.den);
    return { den: reduced.den, num: reduced.num };
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) result[key] = canonicalJson(value[key]);
  return result;
}
