import { describe, it, expect } from 'vitest';
import { pickTelopExport } from './loadTelopComponent';

describe('pickTelopExport', () => {
  it('Telop 関数を持つモジュールから取り出す', () => {
    const fn = () => null;
    expect(pickTelopExport({ Telop: fn })).toBe(fn);
  });
  it('Telop が無いモジュールはエラー', () => {
    expect(() => pickTelopExport({})).toThrow(/Telop/);
  });
  it('Telop が関数でないモジュールはエラー', () => {
    expect(() => pickTelopExport({ Telop: 123 })).toThrow(/Telop/);
  });
  it('default-only exports have never satisfied the named Telop contract', () => {
    expect(() => pickTelopExport({ default: () => null })).toThrow(/Telop/);
  });
});
