import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { shapeLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { canvasToScreen, createThumbnailProject, drag, openThumbnailMode, thumbnailCommand, thumbnailState, clickUntilVisible } from './thumbnailHelpers';

test('回転ハンドルで回し、Shift を押すと 15° 刻みになる。1 回のドラッグは元に戻す 1 回', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-rotate');
  const rotation = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers[0]!.visual.rotation;
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: shapeLayer('box') });
    const center = await canvasToScreen(page, 640, 360);
    const handle = page.locator('[data-handle="rotate"]');
    await clickUntilVisible(page, center, handle);
    const start = (await handle.boundingBox())!, from = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    await drag(page, from, { x: center.x + 200 * center.scale, y: center.y - 40 * center.scale }, { shift: true });
    await expect.poll(async () => (await rotation()) % 15).toBe(0);
    expect(await rotation()).not.toBe(0);
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b9-rotate.png') });
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(rotation).toBe(0);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
