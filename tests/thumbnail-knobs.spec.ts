import { test, expect, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';
import { gradientLayer, textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

async function slide(page: Page, range: Locator, from: number, to: number) {
  await range.scrollIntoViewIfNeeded();
  const box = (await range.boundingBox())!;
  await page.mouse.move(box.x + box.width * from, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++) await page.mouse.move(box.x + box.width * (from + (to - from) * step / 6), box.y + box.height / 2);
  await page.mouse.up();
}

test('つまみの 1 回の操作は元に戻す 1 回。数値のダブルクリックで初期値、サムネ全体の暗さで帯が入る', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-knobs');
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('title', '確認') });
    await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: 'レイヤー' }).click();
    await page.getByRole('list', { name: '重なり順（上が前面）' }).getByRole('button', { name: '確認', exact: true }).click();
    const knobs = page.getByRole('complementary', { name: 'つまみ' });
    await expect(knobs.getByText('選択中: 確認')).toBeVisible();
    const before = (await thumbnailState(request, project.id)).document.revision;
    await slide(page, knobs.locator('[data-knob="font-size"] input[type=range]'), .2, .6);
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.revision).toBe(before + 1);
    const resized = (await thumbnailState(request, project.id)).document.pages[0]!.layers[0]!;
    expect(resized.content.kind === 'text' && resized.content.appearance.fontSize).not.toBe(120);
    await knobs.locator('[data-knob="font-size"] output').dblclick();
    await expect.poll(async () => { const layer = (await thumbnailState(request, project.id)).document.pages[0]!.layers[0]!; return layer.content.kind === 'text' && layer.content.appearance.fontSize; }).toBe(140);
    await slide(page, knobs.locator('[data-knob="shade"] input[type=range]'), 0, .6);
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers.map(layer => layer.content.kind)).toEqual(['gradient', 'text']);
    await knobs.evaluate(element => { element.scrollTop = 0; });
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b5-knobs.png') });
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('「初期値に戻す」は何も選んでいなくても押せ、サムネ全体（暗さ・色の組み合わせ）を 1 回で戻す。選んでいれば選んだ物も一緒に戻り、元に戻す 1 回でそろって戻る', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-reset');
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id, title = textLayer('title', '戻す');
    if (title.content.kind !== 'text') throw new Error('文字ではありません');
    title.content.appearance = { ...title.content.appearance, skewDeg: 12 };
    await thumbnailCommand(request, project.id, { type: 'batch', commands: [{ type: 'add-layer', pageId, layer: gradientLayer('shade') }, { type: 'add-layer', pageId, layer: title },
      { type: 'shift-page-hue', pageId, degrees: 60 }] });
    const knobs = page.getByRole('complementary', { name: 'つまみ' }), reset = knobs.getByRole('button', { name: '初期値に戻す' });
    await expect(knobs.getByText('選択中: なし')).toBeVisible();
    await expect(knobs.locator('[data-knob="hue"] input[type=range]')).toHaveValue('60');
    const before = (await thumbnailState(request, project.id)).document;
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.revision).toBe(before.revision + 1);
    let after = (await thumbnailState(request, project.id)).document.pages[0]!;
    expect(after.hueShift).toBe(0);
    expect(after.layers.map(layer => layer.id)).toEqual(['title']);
    expect(after.layers[0]!.content.kind === 'text' && after.layers[0]!.content.appearance.skewDeg).toBe(12);
    await expect(knobs.locator('[data-knob="hue"] input[type=range]')).toHaveValue('0');
    // 元に戻す 1 回で、暗さの帯と色の組み合わせがそろって戻る。
    await page.getByRole('button', { name: '元に戻す' }).click();
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.pages[0]!.hueShift).toBe(60);
    expect((await thumbnailState(request, project.id)).document.pages[0]!.layers.map(layer => layer.id)).toEqual(['shade', 'title']);
    // 文字を選んでいれば、その文字のつまみ（傾き）も同じ 1 回で戻る。
    await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: 'レイヤー' }).click();
    await page.getByRole('list', { name: '重なり順（上が前面）' }).getByRole('button', { name: '戻す', exact: true }).click();
    await expect(knobs.getByText('選択中: 戻す')).toBeVisible();
    const selected = (await thumbnailState(request, project.id)).document.revision;
    await reset.click();
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.revision).toBe(selected + 1);
    after = (await thumbnailState(request, project.id)).document.pages[0]!;
    expect([after.hueShift, after.layers.length, after.layers[0]!.content.kind === 'text' && after.layers[0]!.content.appearance.skewDeg]).toEqual([0, 1, undefined]);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
