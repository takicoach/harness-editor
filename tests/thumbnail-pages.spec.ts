import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

test('下部の案: 複製で増やし（最大 3）、名前を変え、並べ替え、削除する。縮小画像が出る', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-pages');
  const names = async () => (await thumbnailState(request, project.id)).document.pages.map(item => item.name);
  try {
    await openThumbnailMode(page, project.id);
    const first = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId: first, layer: textLayer('t', '案の確認') });
    const pages = page.getByRole('list', { name: '案' });
    await page.getByRole('button', { name: '＋ 案を追加' }).click();
    await expect.poll(names).toEqual(['案A', '案B']);
    await page.getByRole('button', { name: '空の案' }).click();
    await expect.poll(names).toEqual(['案A', '案B', '案C']);
    await expect(page.getByRole('button', { name: '＋ 案を追加' })).toBeDisabled();
    await pages.getByText('案B', { exact: true }).dblclick();
    await page.getByLabel('案の名前').fill('ためし');
    await page.getByLabel('案の名前').press('Enter');
    await expect.poll(names).toEqual(['案A', 'ためし', '案C']);
    await pages.locator('li').nth(2).dragTo(pages.locator('li').nth(0));
    await expect.poll(names).toEqual(['案C', '案A', 'ためし']);
    await pages.getByRole('button', { name: '案Cを削除' }).click();
    await expect.poll(names).toEqual(['案A', 'ためし']);
    await expect(pages.locator('img').first()).toHaveAttribute('src', /\/api\/thumbnail\/preview\/image\?/, { timeout: 60_000 });
    await page.getByRole('button', { name: '全体表示' }).click();
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b6-pages.png') });
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('下部の案: 「メインにする」でメインの案を切り替える。並べ替えてもメインは変わらず、元に戻すで戻る', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-main');
  const current = async () => (await thumbnailState(request, project.id)).document;
  const main = async () => { const document = await current(); return document.mainPageId ?? document.pages[0]!.id; };
  try {
    await openThumbnailMode(page, project.id);
    const first = (await current()).pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId: first, layer: textLayer('t', 'メイン') });
    const pages = page.getByRole('list', { name: '案' });
    await page.getByRole('button', { name: '＋ 案を追加' }).click();
    await expect.poll(async () => (await current()).pages.length).toBe(2);
    const second = (await current()).pages[1]!.id;
    // 既定は先頭の案がメイン。
    await expect(pages.locator('li').nth(0).locator('.native-thumbnail-page-main')).toHaveText('メイン');
    await expect(pages.locator('.native-thumbnail-page-main')).toHaveCount(1);
    await pages.getByRole('button', { name: '案Bをメインにする' }).click();
    await expect.poll(main).toBe(second);
    await expect(pages.locator('li').nth(1).locator('.native-thumbnail-page-main')).toHaveText('メイン');
    await expect(pages.getByRole('button', { name: '案Aをメインにする' })).toBeVisible();
    await expect(pages.locator('.native-thumbnail-page-main')).toHaveCount(1);
    // 並べ替えてもメインは案B のまま（ID で持つ）。
    await pages.locator('li').nth(1).dragTo(pages.locator('li').nth(0));
    await expect.poll(async () => (await current()).pages.map(item => item.name)).toEqual(['案B', '案A']);
    expect(await main()).toBe(second);
    await expect(pages.locator('li').nth(0).locator('.native-thumbnail-page-main')).toHaveText('メイン');
    // 元に戻す 2 回（並べ替え → メインの切り替え）で、先頭の案A がメインに戻る。
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await current()).pages.map(item => item.name)).toEqual(['案A', '案B']);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(main).toBe(first);
    await expect(pages.locator('li').nth(0).locator('.native-thumbnail-page-main')).toHaveText('メイン');
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
