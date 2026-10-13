import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { clickUntilVisible, drag } from './thumbnailHelpers';
import { createSlidesFixture, openSlides, slidesCanvasToScreen, slidesShot, slidesState } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`キャンバスで文字を選んで動かし、元に戻せる。左のレイヤーと右のつまみが出る（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-editor-${theme}`);
    const titleY = async () => (await slidesState(request, project.id)).document.pages[0]!.layers.find(layer => layer.id === 'page-1-title')!.visual.position.y;
    try {
      await openSlides(page, project.id, theme);
      await expect(page.locator('.native-thumbnail-paper iframe')).toBeVisible();
      const title = await slidesCanvasToScreen(page, 960, 440), before = await titleY();
      await clickUntilVisible(page, title, page.getByRole('toolbar', { name: '文字の道具' }));
      await expect(page.getByRole('complementary', { name: 'つまみ' })).toContainText('選択中: 題');
      await drag(page, title, { x: title.x, y: title.y + 60 * title.scale });
      await expect.poll(titleY).toBeGreaterThan(before);
      await slidesShot(page, `b3-editor-${theme}`);
      await page.keyboard.press('ControlOrMeta+z');
      await expect.poll(titleY).toBeCloseTo(before, 4);
      await page.getByRole('navigation', { name: 'スライドの道具' }).getByRole('button', { name: 'レイヤー' }).click();
      await expect(page.getByRole('list', { name: '重なり順（上が前面）' }).getByRole('button', { name: '題', exact: true })).toBeVisible();
      await slidesShot(page, `b3-layers-${theme}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
