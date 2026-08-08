import { expect, type Page } from '@playwright/test';

/** エディタを起動してサンプルプロジェクトを開くまでの共通セットアップ。 */
export async function openEditor(page: Page): Promise<void> {
  await page.goto('/');
  // ホームはサイドバー非表示（UIリフレッシュ 2026-07-10）のため、カードから開く。
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  // Remotion Player がマウントされるまで待つ
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
}
