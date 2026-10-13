import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { shapeLayer, textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { canvasToScreen, createThumbnailProject, drag, openThumbnailMode, thumbnailCommand, thumbnailState, clickUntilVisible } from './thumbnailHelpers';

test('クリックで選び、ドラッグで動かし（元に戻す 1 回）、四隅で拡縮し、キーで動かす・複製・削除・重なり順', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-move');
  const layers = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers;
  // 画面座標の端数で 1px 前後ずれるので、ドラッグの結果は小数 2 桁で比べる（キー操作は計算どおりの値で比べる）。
  const rounded = async () => { const position = (await layers())[0]!.visual.position; return [Math.round(position.x * 100) / 100, Math.round(position.y * 100) / 100]; };
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'batch', commands: [{ type: 'add-layer', pageId, layer: shapeLayer('box') },
      { type: 'add-layer', pageId, layer: { ...textLayer('title', '動かす'), visual: { position: { x: 0, y: .6 }, scale: 1, rotation: 0, opacity: 1 } } }] });
    const center = await canvasToScreen(page, 640, 360);
    await clickUntilVisible(page, center, page.locator('.native-thumbnail-outline[data-layer-id="box"]'));
    const before = (await thumbnailState(request, project.id)).document.revision;
    // B10 の吸着が入った後も同じ結果になるよう、Alt（吸着なし）で動かす。
    await drag(page, center, { x: center.x + 128 * center.scale, y: center.y + 72 * center.scale }, { alt: true });
    await expect.poll(rounded).toEqual([.2, .2]);
    expect((await thumbnailState(request, project.id)).document.revision).toBe(before + 1);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await layers())[0]!.visual.position).toEqual({ x: 0, y: 0 });
    const corner = await canvasToScreen(page, 790, 460);
    await drag(page, corner, { x: corner.x + 150 * corner.scale, y: corner.y + 100 * corner.scale });
    await expect.poll(async () => (await layers())[0]!.visual.scale).toBeGreaterThan(1.5);
    // サーバーに反映された直後は、画面側の「保存中」がまだ残っていて矢印を受けない。応答が届くのを待つ。
    await page.waitForTimeout(400);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await layers())[0]!.visual.position).toEqual({ x: .0016, y: 0 });
    await page.waitForTimeout(400);
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(async () => (await layers())[0]!.visual.position).toEqual({ x: .0016, y: .0278 });
    await page.keyboard.press('ControlOrMeta+KeyD');
    await expect.poll(async () => (await layers()).length).toBe(3);
    await page.waitForTimeout(400);
    await page.keyboard.press('ControlOrMeta+BracketLeft');
    await expect.poll(async () => (await layers()).map(layer => layer.name)).toEqual(['四角', '四角 のコピー', '動かす']);
    await page.waitForTimeout(400);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await layers()).length).toBe(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.native-thumbnail-outline')).toHaveCount(0);
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b8-move.png') });
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('ドラッグ中の Esc は取り消し（元の位置に戻り、コマンドを送らない）。ドラッグ中の矢印キーは無視する', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-drag-cancel');
  const layers = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers;
  const revision = async () => (await thumbnailState(request, project.id)).document.revision;
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: shapeLayer('box') });
    const center = await canvasToScreen(page, 640, 360), outline = page.locator('.native-thumbnail-outline[data-layer-id="box"]');
    await clickUntilVisible(page, center, outline);
    await page.waitForTimeout(400);
    const before = await revision(), start = (await outline.boundingBox())!;
    // 吸着なし（Alt）で動かし、途中で Esc。
    await page.keyboard.down('Alt');
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.waitForTimeout(80);
    for (let step = 1; step <= 8; step++) { await page.mouse.move(center.x + 120 * step / 8, center.y + 60 * step / 8); await page.waitForTimeout(16); }
    await expect.poll(async () => (await outline.boundingBox())!.x - start.x).toBeGreaterThan(60);
    await page.keyboard.press('Escape');
    await expect.poll(async () => Math.round((await outline.boundingBox())!.x - start.x)).toBe(0);
    // 取り消した後に動かしても、離しても何も起きない。
    await page.mouse.move(center.x + 180, center.y + 90);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await page.waitForTimeout(600);
    expect(await revision()).toBe(before);
    expect((await layers())[0]!.visual.position).toEqual({ x: 0, y: 0 });
    // Esc はドラッグの取り消しだけで、選択は外さない。
    await expect(outline).toBeVisible();
    // ドラッグ中の矢印キーは無視する（離した時の 1 回だけ。矢印の 1 歩は入らない）。
    await page.keyboard.down('Alt');
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.waitForTimeout(80);
    for (let step = 1; step <= 8; step++) { await page.mouse.move(center.x + 128 * center.scale * step / 8, center.y); await page.waitForTimeout(16); }
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(400);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect.poll(async () => { const position = (await layers())[0]!.visual.position; return [Math.round(position.x * 100) / 100, position.y]; }).toEqual([.2, 0]);
    await page.waitForTimeout(400);
    expect(await revision()).toBe(before + 1);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
