import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { shapeLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { canvasToScreen, createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState, clickUntilVisible } from './thumbnailHelpers';

test('動かすとキャンバスの中央に吸い付いて線が出る。Alt を押している間は吸い付かない', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-snap');
  const position = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers[0]!.visual.position;
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: { ...shapeLayer('box'), visual: { position: { x: -.5, y: 0 }, scale: 1, rotation: 0, opacity: 1 } } });
    const from = await canvasToScreen(page, 320, 360), to = await canvasToScreen(page, 643, 360);
    await clickUntilVisible(page, from, page.locator('.native-thumbnail-outline[data-layer-id="box"]'));
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(from.x + (to.x - from.x) * step / 10, from.y);
    await expect(page.locator('.native-thumbnail-guide')).not.toHaveCount(0);
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b10-snap.png') });
    await page.mouse.up();
    await expect.poll(async () => (await position()).x).toBe(0);
    const back = await canvasToScreen(page, 640, 360), near = await canvasToScreen(page, 643, 360);
    await page.mouse.move(back.x, back.y); await page.keyboard.down('Alt'); await page.mouse.down();
    await page.mouse.move(near.x + 10 * near.scale, near.y); await page.mouse.move(near.x, near.y);
    await expect(page.locator('.native-thumbnail-guide')).toHaveCount(0);
    await page.mouse.up(); await page.keyboard.up('Alt');
    await expect.poll(async () => (await position()).x).not.toBe(0);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
