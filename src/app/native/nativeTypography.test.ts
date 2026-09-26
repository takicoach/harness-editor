// src/app/native/nativeTypography.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** UI 添削 F13: native の文字は 3 段だけ。11px 未満の直書きを禁止し、基本サイズはトークン経由にする。 */
const styles = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
const files = readdirSync(__dirname).filter(f => f.endsWith('.css')).map(f => [f, readFileSync(join(__dirname, f), 'utf8')] as const);

describe('native タイポグラフィ', () => {
  it('文字トークンが styles.css にある', () => {
    expect(styles).toMatch(/--native-font-base:\s*12px;/);
    expect(styles).toMatch(/--native-font-sub:\s*11\.5px;/);
    expect(styles).toMatch(/--native-font-tc:\s*15\.5px;/);
  });
  it('native の CSS に 11px 未満の font-size が無い', () => {
    for (const [file, css] of files) {
      const small = css.match(/font-size:\s*(\d+(\.\d+)?)px/g)?.filter(m => Number(m.replace(/[^\d.]/g, '')) < 11) ?? [];
      expect(small, file).toEqual([]);
    }
  });
  it('workspace の基本サイズはトークンを使う', () => {
    expect(files.find(([f]) => f === 'native.css')![1]).toMatch(/\.native-workspace \{[^}]*font-size:var\(--native-font-base\)/);
  });
});
