/**
 * 写しが「写し」であり続けることを 1 バイトで固定する。数値一致（parity）は走査表の点しか
 * 見ないので、走査表に無い分岐だけがずれる事故を素通しする。領域の全文突合を必ず並設する。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const START = '// <<< 共有式ここから', END = '// >>> 共有式ここまで';

const region = (path: string): string => {
  const source = readFileSync(resolve(path), 'utf8');
  const from = source.indexOf(START), to = source.indexOf(END);
  if (from < 0 || to < 0) throw new Error(`共有式の目印がありません: ${path}`);
  return source.slice(from, to + END.length);
};

describe('新 8 種の式はリポジトリと案件テンプレートで同一', () => {
  it('共有式の領域が 1 バイト一致する', () => {
    const core = region('src/core/telopAnimation.ts');
    expect(core.length).toBeGreaterThan(2000);
    expect(region('project-template/src/テロップテンプレート/telopAnimationEffect.ts')).toBe(core);
  });

  it('領域の中身が本物（目印だけを突き合わせていない）', () => {
    const core = region('src/core/telopAnimation.ts');
    for (const needle of ['telopAnimationEffect', 'stampPress', 'inset(0 ', 'Intl.Segmenter', 'blur(']) expect(core).toContain(needle);
  });
});
