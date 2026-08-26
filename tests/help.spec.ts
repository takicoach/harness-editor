import { test, expect } from '@playwright/test';
import { HELP_TOPICS } from '../src/app/help/helpTopics';
import { CURRENT_FEATURE_GENERATION } from '../src/app/featureSeen';

test('チュートリアル図鑑: ホームの？から開き、検索・カテゴリ・項目選択・再開始ができる', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });

  // ホームの？ボタン → 図鑑が開く
  await page.locator('.tb-tutorial-btn').click();
  const dialog = page.locator('[data-testid="help-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);

  // 検索絞り込み（1 項目にしか出ない語で 1 件に絞れることを確認）。
  // 2026-08-26: 旧検体はタイトル「レイアウトとテーマ」だったが、⚙ メニューの実体に合わせて
  // 表題を改めたため、タイトルではなく本文にしか出ない語（ダッキング）で引く。
  await dialog.locator('.help-search-input').fill('ダッキング');
  await expect(dialog.locator('.help-item')).toHaveCount(1);
  await expect(dialog.locator('.help-item')).toContainText('設定');
  await dialog.locator('.help-search-input').fill('');
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);

  // カテゴリチップ
  await dialog.locator('.help-chip', { hasText: '編集' }).click();
  await expect(dialog.locator('.help-item')).toHaveCount(
    HELP_TOPICS.filter((t) => t.category === '編集').length,
  );
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

test('チュートリアル図鑑: 新機能の NEW バッジは開くと消え、リロードしても復活しない', async ({ page }) => {
  // 既読になるのはユーザーが項目を選んだときだけ（自動選択された先頭項目は既読にしない）。
  const expectedNew = HELP_TOPICS.filter((t) => t.addedIn === CURRENT_FEATURE_GENERATION);
  expect(expectedNew.length).toBeGreaterThan(0);
  const target = expectedNew[0]!;

  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });

  await page.locator('.tb-tutorial-btn').click();
  const dialog = page.locator('[data-testid="help-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.help-new-badge')).toHaveCount(expectedNew.length);

  // 該当項目を開くと、その項目のバッジだけ消える。
  const targetItem = dialog.locator(`.help-item[data-topic-id="${target.id}"]`);
  await expect(targetItem.locator('.help-new-badge')).toBeVisible();
  await targetItem.click();
  await expect(targetItem.locator('.help-new-badge')).toHaveCount(0);
  await expect(dialog.locator('.help-new-badge')).toHaveCount(expectedNew.length - 1);

  // リロード後も既読のまま（localStorage 永続）。
  await page.reload();
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });
  await page.locator('.tb-tutorial-btn').click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`.help-item[data-topic-id="${target.id}"] .help-new-badge`)).toHaveCount(0);
  await expect(dialog.locator('.help-new-badge')).toHaveCount(expectedNew.length - 1);
});
