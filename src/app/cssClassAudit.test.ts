import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
// @ts-expect-error — 監査ロジックは scripts からも使う素の ESM（型定義なし）
import { findUnstyledGroups } from './cssClassAudit.mjs';

/**
 * 「クラスはあるのに styles.css に定義がない＝素のテキスト状態」の再発防止。
 * 2026-07-09 に ＋追加ボタン / 波形の高さ / 図形色スウォッチ等が
 * この形で3件以上見つかったため、突合をテストとして常設する。
 * 意図的にスタイル不要なクラスは cssClassAudit.mjs の ALLOWLIST に理由付きで追加する。
 */
describe('CSS class audit', () => {
  it('className に使われる全クラスが styles.css で定義されている（許容リスト除く）', () => {
    const groups = findUnstyledGroups() as Array<{ file: string; classes: string }>;
    const report = groups.map((g) => `${g.file}: "${g.classes}"`).join('\n');
    expect(report).toBe('');
  });
  it('本計画で足したクラスは、定義済みの変数だけを使う', () => {
    // 全体走査にしない（`var(--native-left, 248px)` のように**既定値つきで JS が注入する**変数が
    // 既存 CSS に在り、恒常的な赤になる）。**本計画が足したクラスの本文だけ**を見る。
    const css = readFileSync(resolve('src/app/native/native-polish.css'), 'utf8')
      + readFileSync(resolve('src/app/styles.css'), 'utf8');
    const defined = new Set([...css.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:/gm)].map(match => match[1]!));
    const added = [...css.matchAll(/\.(native-pack-update[a-z-]*|native-animation-note-line|tb-pack-note)[^{]*\{([^}]*)\}/g)];
    expect(added.length, '対象クラスが見つからない（名前を変えたらここも直す）').toBeGreaterThanOrEqual(4);
    const used = new Set(added.flatMap(rule => [...rule[2]!.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map(m => m[1]!)));
    expect([...used].filter(name => !defined.has(name))).toEqual([]);
  });
});
