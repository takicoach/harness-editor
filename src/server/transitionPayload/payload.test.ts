import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(__dirname);
const coreDir = join(__dirname, '..', '..', 'core');

function bodyOf(src: string): string {
  // import 行を除いた本体（ドリフト比較用）。
  return src.split('\n').filter((l) => !l.trimStart().startsWith('import ')).join('\n').trim();
}

describe('payload ローカル import のみ', () => {
  it('payload の全ファイルに ../ import が無い', () => {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
      if (f.endsWith('.test.ts') || f.endsWith('.test.tsx')) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/from ['"]\.\.\//);
    }
  });
});

describe('byte コピーのドリフト 0', () => {
  // core 正典と payload コピーの本体（import 行除く）が一致すること。
  // transitionEngine だけでなく presentation/style も検証する（I-1: プレビュー＝書き出し一致の保険）。
  for (const file of ['transitionEngine.ts', 'transitionPresentation.ts', 'transitionStyle.ts']) {
    it(`core ${file} とコピーの本体が一致`, () => {
      const core = bodyOf(readFileSync(join(coreDir, file), 'utf8'));
      const copy = bodyOf(readFileSync(join(dir, file), 'utf8'));
      expect(copy).toBe(core);
    });
  }
});
