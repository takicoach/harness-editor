import { describe, it, expect } from 'vitest';
import { matchBracket, replaceExportArray } from './sourceEdit';

describe('matchBracket', () => {
  it('対応する閉じ括弧の位置を返す', () => {
    const s = 'x = [1, [2], 3];';
    expect(matchBracket(s, 4)).toBe(14);
  });

  it('文字列内の括弧を無視する', () => {
    const s = '[ "]" ]';
    expect(matchBracket(s, 0)).toBe(6);
  });

  it('エスケープされた引用符を正しく扱う', () => {
    const s = '[ "a\\"]" ]';
    expect(matchBracket(s, 0)).toBe(9);
  });

  it('行コメント内の括弧を無視する', () => {
    // '[\n  // ] dummy\n  1,\n]'
    //  0  1  2345678901234  5  678901
    // true closing ']' is at index 20
    const s = '[\n  // ] dummy\n  1,\n]';
    expect(matchBracket(s, 0)).toBe(20);
  });

  it('ブロックコメント内の括弧を無視する', () => {
    // '[\n  /* ] */\n  1,\n]'
    //  0  1  234567890  1  234567
    // true closing ']' is at index 17
    const s = '[\n  /* ] */\n  1,\n]';
    expect(matchBracket(s, 0)).toBe(17);
  });
});

describe('replaceExportArray', () => {
  it('ヘッダ・import を保ったまま配列だけ差し替える', () => {
    const src =
      "import x from 'y';\n// header\nexport const data = [\n  1,\n];\nexport const z = 9;";
    const out = replaceExportArray(src, 'data', '[2, 3]');
    expect(out).toBe(
      "import x from 'y';\n// header\nexport const data = [2, 3];\nexport const z = 9;",
    );
  });

  it('型注釈付きの export const も差し替えられる', () => {
    const src = 'export const data: Foo[] = [\n  1,\n];';
    expect(replaceExportArray(src, 'data', '[]')).toBe('export const data: Foo[] = [];');
  });

  it('対象が見つからなければ throw する', () => {
    expect(() => replaceExportArray('export const a = 1;', 'data', '[]')).toThrow(/data/);
  });
});
