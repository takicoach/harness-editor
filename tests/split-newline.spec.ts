import { test, expect } from '@playwright/test';
import { openEditor, useTempProject } from './helpers';

// 改行位置でのテロップ分割（実機バグ再現: 改行を入れて「分割」を押すと改行位置で割れる）。

// 共有 sample-project は smoke.spec.ts の afterEach（git checkout / git clean）が
// 実行中ずっと書き換え続けるため、その窓に重なって開くと壊れた状態を読む
// （実測: 「[telopData.ts] telopData 配列が見つかりません」で editor が止まる）。
// 専用コピーへ隔離する（helpers.ts の useTempProject）。
// コピーは afterEach で丸ごと消すので、共有フィクスチャの git 巻き戻しは不要になった。
const projectId = useTempProject('split-newline-tmp');
test('textarea の改行位置で分割される（時間中央ではなく）', async ({ page }) => {
  await openEditor(page, projectId());

  // 最初のテロップ「ゆる素振り」（チップ: ゆる / 素振り）を選択し、改行を入れる。
  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  const editor = page.locator('.tx-row.selected .tx-text-edit');
  await expect(editor).toBeVisible();
  await editor.fill('ゆる\n素振り');

  // 分割 → 改行位置（ゆる｜素振り）で 2 行になる。
  await page.locator('.tx-row.selected .tx-mini-btn', { hasText: '分割' }).click();
  await expect(page.locator('.tx-row', { hasText: '素振り' }).first()).toBeVisible();
  const texts = await page.locator('.tx-row .tx-text, .tx-row .tx-text-edit').allTextContents();
  // 分割後の前半行が「ゆる」単独で存在する（改行込みの塊が残っていない）。
  const hasYuru = await page.locator('.tx-row', { hasText: /^ゆる$/ }).count()
    + (texts.some((t) => t.trim() === 'ゆる') ? 1 : 0);
  expect(hasYuru).toBeGreaterThan(0);
});
