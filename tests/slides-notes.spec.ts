import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesShot, slidesState } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`話すメモを書いて確定し、開き直しても残る。閉じても覚える（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-notes-${theme}`), notes = async () => (await slidesState(request, project.id)).document.pages[0]!.notes;
    try {
      await openSlides(page, project.id, theme);
      const area = page.getByRole('textbox', { name: '話すメモ' });
      await area.fill('ここで自己紹介をする。\n今日の流れを先に話す。');
      await expect.poll(notes, { timeout: 5000 }).toBe('ここで自己紹介をする。\n今日の流れを先に話す。');
      await expect(page.getByText('23 / 2000')).toBeVisible();
      await slidesShot(page, `b5-notes-${theme}`);
      await page.getByRole('button', { name: '保存' }).click();
      await page.reload();
      await expect(page.getByRole('textbox', { name: '話すメモ' })).toHaveValue('ここで自己紹介をする。\n今日の流れを先に話す。');
      await page.getByRole('button', { name: '話すメモ', exact: true }).click();
      await expect(page.getByRole('textbox', { name: '話すメモ' })).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('textbox', { name: '話すメモ' })).toHaveCount(0);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
