import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesShot, slidesState } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`レイアウトを変えても文字は残り、テーマを変えても配置は動かない（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-layout-${theme}`), doc = async () => (await slidesState(request, project.id)).document;
    try {
      await openSlides(page, project.id, theme);
      await page.getByRole('region', { name: 'ページの帯' }).getByRole('button', { name: '2 ページ（要点）' }).click();
      await page.getByRole('navigation', { name: 'スライドの道具' }).getByRole('button', { name: 'レイアウト' }).click();
      const drawer = page.getByRole('complementary', { name: 'レイアウト' });
      await drawer.getByRole('button', { name: '手順', exact: true }).click();
      await expect.poll(async () => (await doc()).pages[1]!.layout).toBe('steps');
      expect((await doc()).pages[1]!.layers.filter(layer => layer.content.kind === 'text').map(layer => layer.content.kind === 'text' ? layer.content.text : '')).toContain('左手から握る');
      const before = (await doc()).pages.map(item => item.layers.map(layer => [layer.id, layer.visual]));
      await drawer.getByRole('button', { name: '白×紺' }).click();
      await expect.poll(async () => (await doc()).theme.id).toBe('white-navy');
      expect((await doc()).pages.map(item => item.layers.map(layer => [layer.id, layer.visual]))).toEqual(before);
      await drawer.getByLabel('強調の色').fill('#c0392b');
      await expect.poll(async () => (await doc()).theme.overrides?.colors?.accent).toBe('#c0392b');
      await drawer.getByRole('button', { name: '章見出しのページを足す' }).click();
      await expect.poll(async () => (await doc()).pages.map(item => item.layout)).toEqual(['cover', 'steps', 'chapter']);
      await expect(page.getByRole('region', { name: 'ページの帯' }).getByRole('button', { name: /^3 ページ/ })).toBeVisible();
      await page.getByRole('region', { name: 'ページの帯' }).getByRole('button', { name: /^2 ページ/ }).click();
      await page.waitForTimeout(600);
      await slidesShot(page, `b7-layout-${theme}`);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
