import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ソース検査（`vite.config.ts` は Vite 自身の CJS/ESM ロードを通さないと実行できないため、
 * ここでは設定を import せずテキストで確認する）。dev の依存事前バンドルが全 .html を走査して
 * `archive/` 配下の退役 worktree（367 個）まで拾い、504 Outdated Optimize Dep でプレビューの
 * 部品読み込みが一時失敗した（followup review 2026-09-18）。再発防止の固定。
 */
const config = readFileSync(resolve(import.meta.dirname, '../../vite.config.ts'), 'utf8');

describe('vite.config.ts の走査範囲', () => {
  it('optimizeDeps.entries が実際のエントリ 2 枚だけに絞られている', () => {
    expect(config).toMatch(/entries:\s*\[\s*'index\.html',\s*'native-render\.html'\s*\]/);
  });

  it('server.watch.ignored が archive/ 配下を除外している', () => {
    expect(config).toContain("'**/archive/**'");
  });
});
