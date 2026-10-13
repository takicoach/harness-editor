import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, thumbnailState } from './thumbnailHelpers';

test('4 つ目のモード「サムネ」で画面が切り替わり、元に戻すの接続先が替わる', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-mode'), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`/?project=${project.id}`);
    const modes = page.getByRole('group', { name: 'モード' });
    await expect(modes.getByRole('button')).toHaveText(['確認', '編集', '仕上げ', 'サムネ']);
    await modes.getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect(page.locator('.native-main')).toBeHidden();
    await expect(page.locator('.native-thumbnail')).toBeVisible();
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.pages.length).toBe(1);
    await expect(page.getByRole('button', { name: '元に戻す' })).toBeDisabled();
    await page.screenshot({ path: join(shotDir('thumbnail'), 'b2-mode.png') });
    await modes.getByRole('button', { name: '編集', exact: true }).click();
    await expect(page.locator('.native-main')).toBeVisible();
    await expect(page.locator('.native-thumbnail')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('サムネを開いたまま離れても、案件を開き直すと動画の編集画面（前回のモード）から始まる', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-reopen');
  try {
    await page.goto(`/?project=${project.id}`);
    const modes = page.getByRole('group', { name: 'モード' });
    await modes.getByRole('button', { name: '仕上げ', exact: true }).click();
    await modes.getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect(page.locator('.native-thumbnail')).toBeVisible();
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.pages.length).toBe(1);
    // 画面の状態は 250ms 後に覚える。覚えた後で開き直す。
    await page.waitForTimeout(600);
    await page.reload();
    await expect(page.locator('.native-main')).toBeVisible();
    await expect(page.locator('.native-thumbnail')).toHaveCount(0);
    await expect(modes.getByRole('button', { name: '仕上げ', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.goto(`/?project=${project.id}`);
    await expect(page.locator('.native-main')).toBeVisible();
    await expect(page.locator('.native-thumbnail')).toHaveCount(0);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('サムネで「AIの作業」を開くと、AI が扱うのは動画だけだと一行で示す', async ({ page }) => {
  const project = createThumbnailProject('e2e-thumb-ai-note');
  try {
    await page.goto(`/?project=${project.id}`);
    await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
    await page.getByRole('button', { name: 'AIの作業' }).click();
    await expect(page.getByText('サムネの画面でも、AI が扱うのは動画の編集内容だけです（サムネは対象外）。')).toBeVisible();
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
