import { expect, test } from '@playwright/test';
import { scriptText } from '../src/core/slides/fixtures';
import { emptySlideDocument } from '../src/core/slides/model';
import { removeTempProject } from './helpers';
import { aiFocusView, aiTabShot, openNativeAi } from './aiTabHelpers';
import { createSlidesFixture, openSlides, slidesCommand } from './slidesHelpers';
import { createThumbnailProject } from './thumbnailHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`AI タブを開いた画面が主画面になり、別の画面で AI を開くと主画面が移る（${theme}）`, async ({ page, context, request }) => {
    const video = createThumbnailProject('e2e-ai-focus'), slides = createSlidesFixture('e2e-ai-focus-slides', emptySlideDocument('ai-focus'));
    try {
      await openNativeAi(page, video.id, theme);
      await expect.poll(async () => (await aiFocusView(request)).primary?.screen?.projectId).toBe(video.id);
      expect((await aiFocusView(request)).primary?.screen).toMatchObject({ mode: 'video', target: { kind: 'video' } });
      await aiTabShot(page, `t3-video-${theme}`);
      await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
      await expect.poll(async () => (await aiFocusView(request)).primary?.screen?.mode).toBe('thumbnail');
      const second = await context.newPage();
      await slidesCommand(request, slides.id, { type: 'set-script', text: scriptText(3) });
      await openSlides(second, slides.id, theme);
      await second.getByRole('button', { name: 'AI の作業', exact: true }).click();
      await expect(second.getByTestId('claude-terminal')).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await aiFocusView(request)).primary?.screen).toMatchObject({ projectId: slides.id, mode: 'slides', target: { kind: 'slides' } });
      await aiTabShot(second, `t3-slides-${theme}`);
      await second.close();
    } finally { await page.goto('about:blank'); removeTempProject(video.dir); removeTempProject(slides.dir); }
  });
}
