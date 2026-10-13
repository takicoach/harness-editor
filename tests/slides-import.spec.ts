import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { applySlideCommand } from '../src/core/slides/commands';
import { slidesFixture } from '../src/core/slides/fixtures';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';
import { removeTempProject } from './helpers';
import { clickUntilVisible } from './thumbnailHelpers';
import { createSlidesFixture, openSlides, slidesCanvasToScreen, slidesShot, slidesState } from './slidesHelpers';

const ffmpeg = resolveFfmpegBin();
for (const theme of ['light', 'dark'] as const) {
  test(`画像を取り込むと画像枠に入り、キャンバスで選んで差し替えられる。文字と図形も足せる（${theme}）`, async ({ page, request }) => {
    test.skip(!ffmpeg.ok, 'FFmpeg が必要です');
    const work = mkdtempSync(join(tmpdir(), 'slides-import-e2e-')), red = join(work, 'red.png'), blue = join(work, 'blue.png');
    if (ffmpeg.ok) for (const [file, color] of [[red, '0xff0000'], [blue, '0x0000ff']] as const) execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=400x300`, '-frames:v', '1', file]);
    const project = createSlidesFixture(`e2e-slides-import-${theme}`, applySlideCommand(slidesFixture(), { type: 'add-page', pageId: 'page-3', layout: 'image-text' }));
    const imageLayer = async () => { const page3 = (await slidesState(request, project.id)).document.pages[2]!; return page3.layers.find(layer => page3.bindings[layer.id]?.slot === 'image')!; };
    try {
      await openSlides(page, project.id, theme);
      await page.getByRole('region', { name: 'ページの帯' }).getByRole('button', { name: '3 ページ（画像＋説明）' }).click();
      const rail = page.getByRole('navigation', { name: 'スライドの道具' });
      await rail.getByRole('button', { name: '取り込み' }).click();
      await page.getByLabel('取り込む画像').setInputFiles(red);
      await expect.poll(async () => (await imageLayer()).content.kind).toBe('image');
      const first = await imageLayer();
      await clickUntilVisible(page, await slidesCanvasToScreen(page, 1400, 630), page.getByRole('toolbar', { name: '画像の道具' }));
      await page.getByLabel('置き換える画像').setInputFiles(blue);
      await expect.poll(async () => { const layer = await imageLayer(); return layer.content.kind === 'image' && first.content.kind === 'image' && layer.content.assetId !== first.content.assetId; }).toBe(true);
      expect((await imageLayer()).visual).toEqual(first.visual);
      await rail.getByRole('button', { name: 'テキスト' }).click();
      await page.getByRole('button', { name: '箇条書きを足す' }).click();
      await rail.getByRole('button', { name: '素材' }).click();
      await page.getByRole('button', { name: '矢印を足す' }).click();
      await expect.poll(async () => (await slidesState(request, project.id)).document.pages[2]!.layers.map(layer => layer.name).slice(-2)).toEqual(['箇条書き', '矢印']);
      await expect(page.getByRole('toolbar', { name: '図形の道具' })).toBeVisible();
      await slidesShot(page, `b8-import-${theme}`);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); rmSync(work, { recursive: true, force: true }); }
  });
}
