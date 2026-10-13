import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { canvasToScreen, createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

test('ダブルクリックでその場編集。変換中の Esc・Cmd+Enter では閉じず、Cmd+Enter で確定（元に戻す 1 回）・Esc で取り消し・空で削除', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-text');
  const layers = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers;
  const textOf = async () => { const layer = (await layers())[0]; return layer?.content.kind === 'text' ? layer.content.text : null; };
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('title', 'サムネ') });
    const center = await canvasToScreen(page, 640, 360), field = page.getByRole('textbox', { name: '文字の編集' });
    // 文字の外接箱は描画の計測から来るので、計測が届くまでダブルクリックを繰り返す。
    await expect(async () => { await page.mouse.dblclick(center.x, center.y); await expect(field).toBeVisible({ timeout: 1000 }); }).toPass();
    await expect(field).toHaveValue('サムネ');
    await expect(page.frameLocator('.native-thumbnail iframe[data-native-preview]').locator('[data-native-clip="title"]')).toHaveCount(0);
    // 日本語の変換中: 変換中の文字を置き、変換中の Esc と Cmd+Enter では閉じないこと。
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'きょうの', selectionStart: 4, selectionEnd: 4 });
    for (const key of ['Escape', 'Enter']) {
      await field.evaluate((element, name) => element.dispatchEvent(new KeyboardEvent('keydown', { key: name, metaKey: name === 'Enter', ctrlKey: name === 'Enter',
        isComposing: true, bubbles: true, cancelable: true })), key);
    }
    await expect(field).toBeVisible();
    await page.keyboard.insertText('今日の');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('一打');
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b12-text-edit.png') });
    const before = (await thumbnailState(request, project.id)).document.revision;
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(field).toHaveCount(0);
    await expect.poll(async () => { const layer = (await layers())[0]!; return layer.content.kind === 'text' ? [layer.content.text, layer.name] : null; })
      .toEqual(['今日の\n一打', '今日の 一打']);
    expect((await thumbnailState(request, project.id)).document.revision).toBe(before + 1);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(textOf).toBe('サムネ');
    // Esc は取り消し（記録しない）。
    await page.mouse.dblclick(center.x, center.y);
    await expect(field).toBeVisible();
    const kept = (await thumbnailState(request, project.id)).document.revision;
    await page.keyboard.insertText('消える');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    expect(await textOf()).toBe('サムネ');
    expect((await thumbnailState(request, project.id)).document.revision).toBe(kept);
    // 空にして外をクリックすると消える。取り消しの直後は、隠していた文字を描き直した計測が届くまでダブルクリックを繰り返す。
    await expect(async () => { await page.mouse.dblclick(center.x, center.y); await expect(field).toBeVisible({ timeout: 1000 }); }).toPass();
    await page.keyboard.press('ControlOrMeta+KeyA');
    await page.keyboard.press('Backspace');
    const corner = await canvasToScreen(page, 40, 40);
    await page.mouse.click(corner.x, corner.y);
    await expect.poll(async () => (await layers()).length).toBe(0);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
