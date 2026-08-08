import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TELOP_PACK, TELOP_PACK_COUNT } from './manifest';

describe('TELOP_PACK manifest', () => {
  it('3 件', () => {
    expect(TELOP_PACK).toHaveLength(3);
    expect(TELOP_PACK_COUNT).toBe(3);
  });
  it('id は 1..3 の連番', () => {
    expect(TELOP_PACK.map((e) => e.id)).toEqual(Array.from({ length: 3 }, (_, i) => i + 1));
  });
  it('exportName / name / file がユニーク', () => {
    for (const key of ['exportName', 'name', 'file'] as const) {
      const vals = TELOP_PACK.map((e) => e[key]);
      expect(new Set(vals).size).toBe(TELOP_PACK.length);
    }
  });
  it('file は styles/ に実在し exportName.tsx と一致', () => {
    for (const e of TELOP_PACK) {
      expect(e.file).toBe(`${e.exportName}.tsx`);
      expect(existsSync(join(import.meta.dirname, 'styles', e.file))).toBe(true);
    }
  });
  // styles/ はプロジェクトへ丸ごとコピーされる（installTelopPack の cpSync）。
  // マニフェスト外のファイルが紛れ込むと、配布物に意図しないスタイルが同梱されるため機械で止める。
  it('styles/ にマニフェスト外の .tsx が無い（第三者スタイルの混入防止）', () => {
    const actual = readdirSync(join(import.meta.dirname, 'styles')).filter((f) => f.endsWith('.tsx')).sort();
    expect(actual).toEqual(TELOP_PACK.map((e) => e.file).sort());
  });
});
