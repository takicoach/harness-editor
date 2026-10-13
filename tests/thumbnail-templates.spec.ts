import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailState } from './thumbnailHelpers';

test('テンプレ: 6 種の見本が本物の描画で出る。選んだ文字に当て、無ければ見出しを足す', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-templates');
  const layers = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers;
  const look = async () => (await layers()).map(layer => layer.content.kind === 'text'
    ? { color: layer.content.appearance.color, outlines: layer.content.appearance.outlines?.length ?? 0, band: !!layer.content.appearance.band } : null);
  try {
    await openThumbnailMode(page, project.id);
    await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: 'テンプレ' }).click();
    const drawer = page.getByRole('complementary', { name: 'テンプレ' });
    await expect(drawer.locator('.native-thumbnail-template [data-native-text]')).toHaveCount(6);
    await drawer.getByRole('button', { name: '袋文字 2 重（黄×黒×白）' }).click();
    await expect.poll(look).toEqual([{ color: '#ffe600', outlines: 2, band: false }]);
    // 足した見出しは選ばれたままなので、次のスタイルはその文字に当たる（増えない）。
    await drawer.getByRole('button', { name: '帯つき' }).click();
    await expect.poll(look).toEqual([{ color: '#ffffff', outlines: 0, band: true }]);
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b15-templates.png') });
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(look).toEqual([{ color: '#ffe600', outlines: 2, band: false }]);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
