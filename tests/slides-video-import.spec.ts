import { expect, test, type APIRequestContext } from '@playwright/test';
import type { SequenceDocument } from '../src/core/sequence/model';
import type { SlideImportRecord } from '../src/core/slides/videoImport';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesCommand, slidesShot, slidesState } from './slidesHelpers';
import { createThumbnailProject } from './thumbnailHelpers';

async function imports(request: APIRequestContext, videoId: string): Promise<SlideImportRecord[]> {
  const response = await request.get(`/api/slides-imports?${new URLSearchParams({ id: videoId })}`);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json() as { imports: SlideImportRecord[] }).imports;
}
for (const theme of ['light', 'dark'] as const) {
  test(`選んだページを動画案件へ取り込み、動画の画面で末尾に置く。スライドを直しても取り込んだ画像は変わらない（${theme}）`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const video = createThumbnailProject(`e2e-slides-video-${theme}`), slides = createSlidesFixture(`e2e-slides-to-video-${theme}`);
    try {
      await openSlides(page, slides.id, theme);
      await page.getByRole('button', { name: '書き出し', exact: true }).click();
      await page.getByRole('dialog', { name: '書き出し' }).getByRole('button', { name: '動画案件に取り込む…' }).click();
      const dialog = page.getByRole('dialog', { name: '動画案件に取り込む' });
      await dialog.getByLabel('取り込み先の動画案件').selectOption(video.id);
      await expect(dialog.getByRole('checkbox')).toHaveCount(2);
      await slidesShot(page, `b14-import-${theme}`);
      await dialog.getByRole('button', { name: '2 ページを取り込む' }).click();
      await expect(dialog.getByRole('status')).toContainText('2 ページの画像を届けました', { timeout: 90_000 });
      const [record] = await imports(request, video.id);
      expect(record).toMatchObject({ placed: null, slides: { projectId: slides.id, documentId: 'slides-1' } });
      expect(record!.pages.map(item => item.number)).toEqual([1, 2]);
      // スライドを直しても、取り込んだ記録（素材の指紋・版）は変わらない。
      const state = await slidesState(request, slides.id), cover = state.document.pages[0]!, title = cover.layers.find(layer => cover.bindings[layer.id]?.slot === 'title')!;
      if (title.content.kind !== 'text') throw new Error('題が文字ではありません');
      await slidesCommand(request, slides.id, { type: 'update-layer', pageId: cover.id, layerId: title.id, patch: { content: { ...title.content, text: '直した題' } } });
      expect(await imports(request, video.id)).toEqual([record]);
      // 動画の画面: 届いた案内から末尾に置く。
      await page.goto(`/?project=${video.id}`);
      const notice = page.locator('.native-slides-import-notice');
      await expect(notice).toContainText('2 ページの画像が届いています');
      await slidesShot(page, `b14-video-notice-${theme}`);
      await notice.getByRole('button', { name: '末尾に置く' }).click();
      await expect(notice).toHaveCount(0);
      const [placed] = await imports(request, video.id);
      expect(placed!.placed?.clipIds).toHaveLength(2);
      const opened = await request.post(`/api/sequence/session?id=${video.id}`, { data: {} });
      const document = (await opened.json() as { document: SequenceDocument }).document;
      expect(document.tracks.map(track => track.name)).toContain('スライド');
      expect(document.clips.filter(clip => placed!.placed!.clipIds.includes(clip.id)).map(clip => [clip.startFrame, clip.durationFrames])).toEqual([[30, 150], [180, 150]]);
    } finally { await page.goto('about:blank'); removeTempProject(slides.dir); removeTempProject(video.dir); }
  });
}
