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
});
