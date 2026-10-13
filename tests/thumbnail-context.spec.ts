import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { shapeLayer, textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

test('文字・図形の道具と小メニューが、選んだ物にだけ効く', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-context');
  const layers = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers;
  const layerOf = async (id: string) => (await layers()).find(layer => layer.id === id);
  const textOf = async () => { const layer = await layerOf('title'); return layer?.content.kind === 'text' ? layer.content.appearance : null; };
  const shapeOf = async () => { const layer = await layerOf('box'); return layer?.content.kind === 'shape' ? layer.content.shape : null; };
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'batch', commands: [
      { type: 'add-layer', pageId, layer: { ...shapeLayer('box'), visual: { position: { x: -.6, y: -.6 }, scale: 1, rotation: 0, opacity: 1 } } },
      { type: 'add-layer', pageId, layer: textLayer('title', '道具') }] });
    await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: 'レイヤー' }).click();
    const list = page.getByRole('list', { name: '重なり順（上が前面）' });
    await list.getByRole('button', { name: '道具', exact: true }).click();
    const bar = page.getByRole('toolbar', { name: '文字の道具' });
    await bar.getByRole('button', { name: '文字を大きく' }).click();
    await expect.poll(async () => (await textOf())?.fontSize).toBe(130);
    await bar.getByRole('button', { name: '袋文字' }).click();
    await expect.poll(async () => (await textOf())?.outlines?.length).toBe(2);
    await bar.getByRole('button', { name: '影', exact: true }).click();
    await expect.poll(async () => !!(await textOf())?.shadow).toBe(true);
    await bar.getByLabel('書体').selectOption('dela-gothic-one');
    await expect.poll(async () => (await textOf())?.fontFamily).toContain('Dela Gothic One');
    await bar.getByRole('button', { name: '配置' }).click();
    await page.getByRole('menuitem', { name: '上にそろえる' }).click();
    await expect.poll(async () => (await layerOf('title'))!.visual.position.y).toBeLessThan(-.5);
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b13-context.png') });
    const menu = page.getByRole('toolbar', { name: '選んだ物のメニュー' });
    await menu.getByRole('button', { name: 'ロック', exact: true }).click();
    await expect.poll(async () => (await layerOf('title'))!.locked).toBe(true);
    await expect(bar.getByRole('button', { name: '文字を大きく' })).toBeDisabled();
    await menu.getByRole('button', { name: 'ロック解除', exact: true }).click();
    await expect.poll(async () => (await layerOf('title'))!.locked).toBe(false);
    await menu.getByRole('button', { name: '複製', exact: true }).click();
    await expect.poll(async () => (await layers()).length).toBe(3);
    await menu.getByRole('button', { name: '削除', exact: true }).click();
    await expect.poll(async () => (await layers()).length).toBe(2);
    await list.getByRole('button', { name: '四角', exact: true }).click();
    const shapeBar = page.getByRole('toolbar', { name: '図形の道具' });
    await shapeBar.getByRole('button', { name: '塗り', exact: true }).click();
    await expect.poll(async () => (await shapeOf())?.fill).toEqual({ kind: 'solid', color: '#ffffff' });
    await shapeBar.getByLabel('線の太さ').selectOption('16');
    await expect.poll(async () => (await shapeOf())?.strokeWidth).toBe(16);
    expect((await textOf())?.fontSize).toBe(130);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
