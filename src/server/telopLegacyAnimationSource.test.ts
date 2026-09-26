/**
 * 写しが「写し」であり続けることを 1 バイトで固定する（`telopAnimationSource.test.ts:1-4` と同じ理由）。
 * 数値一致（parity）は走査表の点しか見ないので、走査表に無い分岐だけがずれる事故を素通しする。
 * 既存 9 種は写し先が **2 本**（案件テンプレートとパック）。パックは案件へコピーされて動くため
 * `src/core` を import できない（`installTelopPack.ts:122-123`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const START = '// <<< 共有式ここから', END = '// >>> 共有式ここまで';

const region = (path: string): string => {
  const source = readFileSync(resolve(path), 'utf8');
  // 目印が 2 組あると `indexOf` の初出しか見ないので、黙って切り詰まった領域どうしを
  // 突き合わせて緑になる。写しが 3 本に増えるので重複そのものを弾く（事前検査 A の Fix）。
  if (source.split(START).length !== 2 || source.split(END).length !== 2)
    throw new Error(`共有式の目印が 1 組ではありません: ${path}`);
  const from = source.indexOf(START), to = source.indexOf(END);
  if (from < 0 || to < 0) throw new Error(`共有式の目印がありません: ${path}`);
  return source.slice(from, to + END.length);
};

describe('既存 9 種の式はリポジトリ・案件テンプレート・パックで同一', () => {
  it('共有式の領域が 3 者で 1 バイト一致する', () => {
    const core = region('src/core/telopLegacyAnimation.ts');
    expect(core.length).toBeGreaterThan(2000);
    expect(region('project-template/src/テロップテンプレート/telopLegacyAnimation.ts')).toBe(core);
    expect(region('src/server/telopPack/telopLegacyAnimation.ts')).toBe(core);
  });

  it('領域の中身が本物（目印だけを突き合わせていない）', () => {
    const core = region('src/core/telopLegacyAnimation.ts');
    for (const needle of ['legacyTelopAnimationFrame', 'packLegacyTelopAnimationFrame',
      'LEGACY_TELOP_ANIMATION_CONFIG', 'slideLeftFadeBlur', 'LEGACY_TELOP_ENTRY_OPACITY_FLOOR'])
      expect(core).toContain(needle);
  });

  it('3 本とも領域がファイル全体（目印の外に何も足されていない）', () => {
    // 領域一致だけだと、目印より上に import や BOM を挿しても 3 者は一致したままになる。
    // 「領域 === ファイル全文」を要求すれば前後の追記をまとめて塞げる（レビュー Minor 1）。
    for (const path of ['src/core/telopLegacyAnimation.ts',
      'project-template/src/テロップテンプレート/telopLegacyAnimation.ts',
      'src/server/telopPack/telopLegacyAnimation.ts'])
      expect(`${region(path)}\n`, path).toBe(readFileSync(resolve(path), 'utf8'));
  });

  it('パックの写しは部品コンパイルを通る形（外部 import も動的 import も無い）', () => {
    // パックの写しは案件へコピーされ、`compileSequenceComponent` の esbuild を通る。
    // `auditSource`（`components.ts:17-47`）が動的 import / require を弾くので、そこまでを 1 件で固定する。
    const source = readFileSync(resolve('src/server/telopPack/telopLegacyAnimation.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});
