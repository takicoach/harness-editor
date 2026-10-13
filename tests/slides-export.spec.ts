import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesShot } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`PDF の説明つきで表示用 PDF を書き出し、PNG 一式も書き出せる（${theme}）`, async ({ page }) => {
    test.setTimeout(120_000);
    const project = createSlidesFixture(`e2e-slides-export-${theme}`), folder = join(project.dir, '書き出し');
    try {
      await openSlides(page, project.id, theme);
      await page.getByRole('button', { name: 'PDF', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '書き出し' });
      await expect(dialog.getByRole('radio', { name: /表示用 PDF/ })).toBeChecked();
      await expect(dialog.getByText('PDF の中で文字を編集・検索することはできません')).toBeVisible();
      await slidesShot(page, `b13-export-${theme}`);
      await dialog.getByRole('button', { name: '書き出す' }).click();
      await expect(dialog.getByRole('status')).toHaveText('書き出しました', { timeout: 90_000 });
      const pdf = readdirSync(folder).filter(name => name.endsWith('.pdf'));
      expect(pdf).toHaveLength(1);
      expect(readFileSync(join(folder, pdf[0]!)).subarray(0, 5).toString()).toBe('%PDF-');
      await dialog.getByRole('radio', { name: /PNG 一式/ }).check();
      await expect(dialog.getByText('PDF の中で文字を編集・検索することはできません')).toHaveCount(0);
      await dialog.getByRole('button', { name: '書き出す' }).click();
      await expect(dialog.getByRole('list', { name: '書き出したファイル' }).getByRole('link')).toHaveCount(2, { timeout: 90_000 });
      expect(readdirSync(folder).filter(name => /_00[12]\.png$/.test(name))).toHaveLength(2);
      await slidesShot(page, `b13-export-done-${theme}`);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
