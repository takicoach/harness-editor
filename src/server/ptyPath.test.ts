import { describe, it, expect } from 'vitest';
import { buildPtyPath } from './ptyPath';

const posix = { platform: 'darwin' as const, sep: '/', delimiter: ':' };

describe('buildPtyPath', () => {
  it('採用した実行ファイルの親と node の bin を先頭に置く', () => {
    expect(buildPtyPath('/usr/bin:/bin', '/Users/x/.local/bin/claude', '/opt/homebrew/bin/node', posix))
      .toBe('/Users/x/.local/bin:/opt/homebrew/bin:/usr/bin:/bin');
  });
  it('既に PATH にある同じディレクトリは重複させず、先頭へ引き上げる', () => {
    expect(buildPtyPath('/usr/bin:/opt/homebrew/bin', '/opt/homebrew/bin/codex', '/opt/homebrew/bin/node', posix))
      .toBe('/opt/homebrew/bin:/usr/bin');
  });
  it('PATH が空でも壊れない', () => {
    expect(buildPtyPath(undefined, '/a/b/claude', '/c/d/node', posix)).toBe('/a/b:/c/d');
  });
  it('空要素を落とす', () => {
    expect(buildPtyPath('/usr/bin::', '/a/b/claude', '/a/b/node', posix)).toBe('/a/b:/usr/bin');
  });
  it('Windows は ; 区切りで、比較は大文字小文字を無視する', () => {
    const win = { platform: 'win32' as const, sep: '\\', delimiter: ';' };
    expect(buildPtyPath('C:\\Windows;C:\\Users\\X\\AppData\\Roaming\\npm', 'C:\\Users\\X\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Program Files\\nodejs\\node.exe', win))
      .toBe('C:\\Users\\X\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Windows');
  });
});
