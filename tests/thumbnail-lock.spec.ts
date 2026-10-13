import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { shapeLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { canvasToScreen, createThumbnailProject, drag, openThumbnailMode, thumbnailCommand, thumbnailState, clickUntilVisible } from './thumbnailHelpers';

test('ロック中は選べるが、ドラッグ・矢印キー・削除が効かず、ハンドルの代わりに札が出る。外すと動く', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-lock');
  const read = async () => (await thumbnailState(request, project.id)).document;
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await read()).pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: shapeLayer('box') });
    await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: 'レイヤー' }).click();
    const list = page.getByRole('list', { name: '重なり順（上が前面）' });
    await list.getByRole('button', { name: '四角をロック' }).click();
    await expect.poll(async () => (await read()).pages[0]!.layers[0]!.locked).toBe(true);
    const lockedRevision = (await read()).revision;
    const center = await canvasToScreen(page, 640, 360);
    await clickUntilVisible(page, center, page.locator('.native-thumbnail-outline[data-layer-id="box"]'));
    await expect(page.locator('.native-thumbnail-lock-badge')).toBeVisible();
    await expect(page.locator('[data-handle]')).toHaveCount(0);
    await drag(page, center, { x: center.x + 100 * center.scale, y: center.y + 50 * center.scale }, { alt: true });
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');
    await expect(page.getByText('ロック中のレイヤーは動かしたり消したりできません')).toBeVisible();
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b11-lock.png') });
    await list.getByRole('button', { name: '四角のロックを外す' }).click();
    await expect.poll(async () => (await read()).pages[0]!.layers[0]!.locked).toBe(false);
    const unlocked = await read();
    // ロック中の操作は 1 つも記録されていない（増えたのはロックを外した 1 回だけ）。
    expect(unlocked.revision).toBe(lockedRevision + 1);
    expect(unlocked.pages[0]!.layers[0]!.visual.position).toEqual({ x: 0, y: 0 });
    await page.mouse.click(center.x, center.y);
    await expect(page.locator('[data-handle="corner-br"]')).toBeVisible();
    await drag(page, center, { x: center.x + 64 * center.scale, y: center.y }, { alt: true });
    await expect.poll(async () => (await read()).pages[0]!.layers[0]!.visual.position.x).toBeGreaterThan(.05);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
