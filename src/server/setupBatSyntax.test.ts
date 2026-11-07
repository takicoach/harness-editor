import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// for /f の `...` の中は cmd が先に一度解釈するので、リダイレクトの記号はすべて ^ で逃がす。
// `2^>>` は 2 つ目の > が残り、「> was unexpected at this time.」で setup.bat が止まる（Windows 11 の利用者報告 2026-11-04）。
describe('setup.bat', () => {
  it('for /f のコマンドの中のリダイレクト記号をすべて ^ で逃がしている', () => {
    const lines = readFileSync('setup.bat', 'utf8').split(/\r?\n/);
    const bad = lines.flatMap((line, index) => {
      const command = /^\s*for \/f .*\(`(.*)`\)/i.exec(line)?.[1];
      return command !== undefined && /(^|[^^])[<>|&]/.test(command) ? [`${index + 1}: ${command}`] : [];
    });
    expect(bad).toEqual([]);
  });
});
