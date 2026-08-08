import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// 改行位置でのテロップ分割（実機バグ再現: 改行を入れて「分割」を押すと改行位置で割れる）。

const FIXTURE_DIR = resolve(import.meta.dirname, '../src/server/__fixtures__/sample-project');

test.afterEach(() => {
  try {
    execSync(`git checkout -- "${FIXTURE_DIR}"`, { stdio: 'ignore' });
    execSync(`git clean -fdx "${FIXTURE_DIR}"`, { stdio: 'ignore' });
  } catch {
    // git 管理外環境では無視
  }
});

test('textarea の改行位置で分割される（時間中央ではなく）', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

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
