import { describe, it, expect } from 'vitest';
import { emptyTypoDict, parseTypoDict, serializeTypoDict } from './typoDict';

describe('emptyTypoDict', () => {
  it('空の typo_dict を返す', () => {
    expect(emptyTypoDict()).toEqual({
      replace: {},
      fillers: { remove: [], keep_in_context: [] },
      preserve: [],
    });
  });
});

describe('parseTypoDict', () => {
  it('完全な typo_dict を読む', () => {
    const json = JSON.stringify({
      replace: { ゼロ式: '零式' },
      fillers: { remove: ['えーと'], keep_in_context: ['まあ'] },
      preserve: ['AI'],
    });
    expect(parseTypoDict(json).replace).toEqual({ ゼロ式: '零式' });
  });

  it('欠けたキーは既定値で補う', () => {
    expect(parseTypoDict('{"replace":{"a":"b"}}')).toEqual({
      replace: { a: 'b' },
      fillers: { remove: [], keep_in_context: [] },
      preserve: [],
    });
  });

  it('空オブジェクト {} は空の typo_dict として有効', () => {
    expect(parseTypoDict('{}')).toEqual(emptyTypoDict());
  });

  it('JSON ルートが null / 配列なら throw する', () => {
    expect(() => parseTypoDict('null')).toThrow();
    expect(() => parseTypoDict('[]')).toThrow();
  });

  it('不正な JSON は throw する', () => {
    expect(() => parseTypoDict('not json')).toThrow();
  });
});

describe('serializeTypoDict', () => {
  it('読み書きで往復する', () => {
    const dict = parseTypoDict('{"replace":{"a":"b"}}');
    expect(parseTypoDict(serializeTypoDict(dict))).toEqual(dict);
  });

  it('末尾に改行を付ける', () => {
    expect(serializeTypoDict(emptyTypoDict()).endsWith('\n')).toBe(true);
  });
});
