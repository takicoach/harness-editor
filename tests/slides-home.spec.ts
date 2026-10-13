import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FIXTURES_ROOT, removeTempProject } from './helpers';
import { createSlidesFixture, slidesShot } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`ホームのスライドの欄から作って開き、ホームへ戻る（${theme}）`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
    const existing = createSlidesFixture(`e2e-slides-home-${theme}`), name = `e2e-新しいスライド-${theme}-${Date.now()}`;
    try {
      await page.goto('/');
      const section = page.getByRole('region', { name: 'スライド' });
      await expect(section.getByRole('button', { name: `${existing.id}を開く` })).toBeVisible();
      await slidesShot(page, `b2-home-${theme}`);
      await section.getByRole('button', { name: '＋ スライドを作る' }).click();
      await section.getByLabel('スライドの名前').fill(name);
      await section.getByRole('button', { name: '作る', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`slides=${encodeURIComponent(name)}`));
      await expect(page.locator('.native-slides-header')).toContainText('スライド');
      await expect(page.getByText('まだページがありません')).toBeVisible();
      await slidesShot(page, `b2-empty-${theme}`);
      await page.getByRole('button', { name: '白紙のページを足す' }).click();
      await expect(page.getByText('まだページがありません')).toHaveCount(0);
      await page.getByRole('button', { name: 'ホームへ戻る' }).click();
      await expect(page.getByRole('region', { name: 'スライド' }).getByRole('button', { name: `${name}を開く` })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.goto('about:blank'); removeTempProject(existing.dir); removeTempProject(join(FIXTURES_ROOT, name)); }
  });
}
