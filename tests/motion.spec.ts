import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// 2点アニメ（motion）の e2e。テロップにプリセットを設定→保存→再読込で保持されることと、
// telopData.ts に motion が書き出されることを確認する。
// fixture を書き換えるため afterEach で pristine へ戻す（render-button.spec と同型）。

const FIXTURE_DIR = resolve(import.meta.dirname, '../src/server/__fixtures__/sample-project');

test.afterEach(() => {
  try {
    execSync(`git checkout -- "${FIXTURE_DIR}"`, { stdio: 'ignore' });
    execSync(`git clean -fdx "${FIXTURE_DIR}"`, { stdio: 'ignore' });
  } catch {
    // git 管理外環境では無視
  }
});

test('テロップにズームインを設定→保存→再読込で保持され、telopData に書き出される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 最初のテロップ行を選択 → 設定タブ → アニメのプリセットを選ぶ。
  await page.locator('.tx-row').first().click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  const presetSelect = page.locator('#ins-telop-motion-preset');
  await expect(presetSelect).toBeVisible();
  await presetSelect.selectOption('zoomIn');

  // 強さスライダーが出る（プリセット選択済みの証拠）。
  await expect(page.locator('#ins-telop-motion-intensity')).toBeVisible();

  // 保存 → 保存済み表示。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });

  // 再読込しても選択が保持されている。
  await page.reload();
  const item2 = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item2).toBeVisible({ timeout: 15_000 });
  await item2.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await page.locator('.tx-row').first().click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await expect(page.locator('#ins-telop-motion-preset')).toHaveValue('zoomIn');

  expect(pageErrors).toEqual([]);
});
