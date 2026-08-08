import { test, expect } from '@playwright/test';
import { HELP_TOPICS } from '../src/app/help/helpTopics';

test('チュートリアル図鑑: ホームの？から開き、検索・カテゴリ・項目選択・再開始ができる', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });

  // ホームの？ボタン → 図鑑が開く
  await page.locator('.tb-tutorial-btn').click();
  const dialog = page.locator('[data-testid="help-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);

  // 検索絞り込み（タイトルの完全一致語で1件に絞れることを確認）
  await dialog.locator('.help-search-input').fill('レイアウトとテーマ');
  await expect(dialog.locator('.help-item')).toHaveCount(1);
  await expect(dialog.locator('.help-item')).toContainText('レイアウトとテーマ');
  await dialog.locator('.help-search-input').fill('');
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);

  // カテゴリチップ
  await dialog.locator('.help-chip', { hasText: '編集' }).click();
  await expect(dialog.locator('.help-item')).toHaveCount(4);
  await dialog.locator('.help-chip', { hasText: 'すべて' }).click();
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);

  // 項目選択で右ペイン切替
  await dialog.locator('.help-item', { hasText: '書き出し' }).click();
  await expect(dialog.locator('.help-detail-pane .help-cap')).toHaveText('書き出し');
  await expect(dialog.locator('.help-detail-pane .help-img')).toBeVisible();

  // Esc で閉じる
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // もう一度開いて「▶ もう一度最初から見る」→ welcome 吹き出し表示
  await page.locator('.tb-tutorial-btn').click();
  await expect(dialog).toBeVisible();
  await dialog.locator('.help-replay-btn').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.tut[data-step="welcome"]')).toBeVisible();
});
