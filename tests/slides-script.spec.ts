import { expect, test, type APIRequestContext } from '@playwright/test';
import { SLIDES_OUTLINE_SCHEMA } from '../src/core/slides/contract';
import { pageBody, scriptText } from '../src/core/slides/fixtures';
import { emptySlideDocument } from '../src/core/slides/model';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesShot, slidesState } from './slidesHelpers';

/** 貼り付けの経路（HTTP /apply）で、AI の回答が届いた状態を作る。 */
async function applyViaPaste(request: APIRequestContext, id: string, kind: 'outline' | 'pages', payload: unknown): Promise<void> {
  const state = await slidesState(request, id);
  const response = await request.post(`/api/slides/apply?${new URLSearchParams({ id })}`, { data: { documentId: state.document.id, sessionId: state.sessionId,
    expectedRevision: state.document.revision, kind, operationId: crypto.randomUUID(), runId: state.document.generation?.runId, payload } });
  expect(response.ok(), await response.text()).toBe(true);
}
for (const theme of ['light', 'dark'] as const) {
  test(`台本を段落に分け、構成案を確かめて直して確定し、進み具合・中止・続きから作るが出る（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-script-${theme}`, emptySlideDocument('slides-script')), doc = async () => (await slidesState(request, project.id)).document;
    try {
      await openSlides(page, project.id, theme);
      await page.getByRole('button', { name: '台本から作る', exact: true }).first().click();
      const drawer = page.getByRole('complementary', { name: '台本から作る' });
      await drawer.getByLabel('台本', { exact: true }).fill(scriptText(6));
      await drawer.getByRole('button', { name: '段落に分ける' }).click();
      await expect(drawer.getByText('6 段落')).toBeVisible();
      await applyViaPaste(request, project.id, 'outline', { schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages: [
        { key: 's1', layout: 'cover', title: '表紙', sourceParagraphIds: ['p1', 'p2'] }, { key: 's2', layout: 'points', title: '要点', sourceParagraphIds: ['p3', 'p4'] },
        { key: 's3', layout: 'steps', title: '手順', sourceParagraphIds: ['p5', 'p6'] }] });
      const outline = drawer.getByRole('list', { name: '構成案' });
      await expect(outline.getByRole('listitem')).toHaveCount(3);
      await expect(drawer.getByText('全段落 6 / 6 がどれかのページに入っています')).toBeVisible();
      await outline.getByLabel('2 ページ目のレイアウト').selectOption('compare');
      await expect.poll(async () => (await doc()).generation!.outline[1]!.layout).toBe('compare');
      await outline.getByRole('button', { name: '3 ページ目を上へ' }).click();
      await expect.poll(async () => (await doc()).generation!.outline.map(entry => entry.key)).toEqual(['s1', 's3', 's2']);
      await outline.getByRole('button', { name: '1 ページ目を消す' }).click();
      await expect(outline.getByRole('listitem')).toHaveCount(2);
      await expect(drawer.getByText('全段落 6 / 6 がどれかのページに入っています')).toBeVisible();
      await slidesShot(page, `b9-outline-${theme}`);
      await drawer.getByRole('button', { name: 'この構成で作る' }).click();
      await expect(drawer.getByText('0 / 2 ページができました')).toBeVisible();
      await expect.poll(async () => (await doc()).pages.map(item => item.outlineKey)).toEqual(['s3', 's2']);
      await applyViaPaste(request, project.id, 'pages', [pageBody('s3', 'steps')]);
      await expect(drawer.getByText('1 / 2 ページができました')).toBeVisible();
      await drawer.getByRole('button', { name: '中止', exact: true }).click();
      await expect(drawer.getByRole('button', { name: '続きから作る' })).toBeVisible();
      await slidesShot(page, `b9-progress-${theme}`);
      await drawer.getByRole('button', { name: '続きから作る' }).click();
      await expect(drawer.getByRole('button', { name: '中止', exact: true })).toBeVisible();
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
