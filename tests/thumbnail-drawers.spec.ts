import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailState } from './thumbnailHelpers';

test('左のアイコン列と引き出し: 文字を足し、レイヤーで表示・ロック・重なり順、画像を取り込む', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-drawers'), ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  const image = join(project.dir, 'photo.png');
  execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x3366cc:s=320x180', '-frames:v', '1', image]);
  const layers = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers;
  try {
    await openThumbnailMode(page, project.id);
    await expect(page.getByRole('complementary', { name: 'テキスト' })).toBeVisible();
    await page.getByRole('button', { name: '見出しを足す', exact: true }).click();
    await page.getByRole('button', { name: '小見出しを足す', exact: true }).click();
    await expect.poll(async () => (await layers()).map(layer => layer.name)).toEqual(['見出し', '小見出し']);
    const rail = page.getByRole('navigation', { name: 'サムネの道具' });
    await rail.getByRole('button', { name: 'レイヤー' }).click();
    const list = page.getByRole('list', { name: '重なり順（上が前面）' });
    await expect(list.getByRole('button').first()).toHaveText('小見出し');
    await list.getByRole('button', { name: '見出しを隠す', exact: true }).click();
    await list.getByRole('button', { name: '小見出しをロック' }).click();
    await expect.poll(async () => (await layers()).map(layer => [layer.name, layer.hidden, layer.locked])).toEqual([['見出し', true, false], ['小見出し', false, true]]);
    await list.getByRole('button', { name: '小見出しを背面へ' }).click();
    await expect.poll(async () => (await layers()).map(layer => layer.name)).toEqual(['小見出し', '見出し']);
    await rail.getByRole('button', { name: '取り込み' }).click();
    await page.getByLabel('取り込む画像').setInputFiles(image);
    await expect.poll(async () => (await layers())[0]?.content).toMatchObject({ kind: 'image', role: 'photo' });
    await page.locator('.native-thumbnail').screenshot({ path: join(shotDir('thumbnail'), 'b4-drawers.png') });
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
