import { test, expect } from '@playwright/test';
import { openEditor } from './helpers';

// 保存往復テスト（区間速度設定→保存→再読込）は smoke.spec.ts に移動済み。
// smoke.spec.ts は全テストが同一ワーカーで直列実行されるため、
// 並列ワーカー間の git clean -fdx 競合が起きない。
// このファイルはファイル保存を伴わないテストのみ保持する。

test('「全体に従うへ戻す」で個別速度が解除される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page);

  // 区間をクリック → 速度を設定
  const kept = page.locator('.tl-kept-segment').first();
  await expect(kept).toBeVisible();
  await kept.click();
  await expect(page.locator('[data-cutsegment]')).toBeVisible();

  // 2x プリセットを設定（リセットボタンが現れる前提）
  await page.locator('[data-cutsegment] .ins-vi-speed-preset[data-rate="2"]').click();
  await expect(page.locator('[data-cutsegment] .ins-vi-speed-value')).toContainText('2');

  // リセットボタンが出る
  const resetBtn = page.locator('#ins-segment-speed-reset');
  await expect(resetBtn).toBeVisible();

  // リセット → 「全体に従う」表示に戻る
  await resetBtn.click();
  await expect(page.locator('[data-cutsegment] .ins-vi-speed-value')).toContainText('全体に従う');

  // リセットボタンは消える
  await expect(page.locator('#ins-segment-speed-reset')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
