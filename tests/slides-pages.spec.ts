import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesShot, slidesState } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`ページの帯で足す・複製・削除・並べ替え、全ページを並べる（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-pages-${theme}`), ids = async () => (await slidesState(request, project.id)).document.pages.map(item => item.id);
    try {
      await openSlides(page, project.id, theme);
      const strip = page.getByRole('region', { name: 'ページの帯' });
      // 存在検査: 縮小画像が実際に届くまで待つ（空の枠のまま撮らない）。
      await expect(strip.locator('img')).toHaveCount(2, { timeout: 30_000 });
      await expect.poll(() => strip.locator('img').evaluateAll(items => items.every(item => item instanceof HTMLImageElement && item.complete && item.naturalWidth > 0)), { timeout: 30_000 }).toBe(true);
      await slidesShot(page, `b4-strip-${theme}`);
      await strip.getByRole('button', { name: 'ページを足す' }).click();
      await expect.poll(ids).toHaveLength(3);
      await strip.getByRole('button', { name: '1 ページ（表紙）' }).click();
      await strip.getByRole('button', { name: '複製', exact: true }).click();
      await expect.poll(ids).toHaveLength(4);
      const before = await ids();
      await strip.getByRole('listitem').nth(3).dragTo(strip.getByRole('listitem').nth(0));
      await expect.poll(ids).toEqual([before[3], before[0], before[1], before[2]]);
      await strip.getByRole('button', { name: '1 ページ（要点）' }).click();
      await strip.getByRole('button', { name: '削除', exact: true }).click();
      await expect.poll(ids).toHaveLength(3);
      await strip.getByRole('button', { name: '全ページを並べる' }).click();
      const sheet = page.getByRole('dialog', { name: '全ページを並べる' });
      await expect(sheet.getByRole('listitem')).toHaveCount(3);
      await slidesShot(page, `b4-grid-${theme}`);
      await sheet.getByRole('button', { name: '2 ページ（表紙）' }).click();
      await expect(sheet).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
