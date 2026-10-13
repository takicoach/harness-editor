import { expect, test } from '@playwright/test';
import { SLIDES_OUTLINE_SCHEMA } from '../src/core/slides/contract';
import { pageBody, scriptText } from '../src/core/slides/fixtures';
import { emptySlideDocument } from '../src/core/slides/model';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesCommand, slidesShot, slidesState } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`依頼文をコピーし、貼った回答を同じ検証で確かめて、合格した分だけ採用する（${theme}）`, async ({ page, request, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const project = createSlidesFixture(`e2e-slides-paste-${theme}`, emptySlideDocument('slides-paste'));
    try {
      await slidesCommand(request, project.id, { type: 'set-script', text: scriptText(6) });
      await openSlides(page, project.id, theme);
      await page.getByRole('navigation', { name: 'スライドの道具' }).getByRole('button', { name: '台本から作る' }).click();
      await page.getByRole('button', { name: '構成案を貼り付けで頼む' }).click();
      const dialog = page.getByRole('dialog', { name: '貼り付けで頼む' });
      await expect(dialog.getByLabel('依頼文')).toHaveValue(/harness-slides-outline\/1[\s\S]*p1: /);
      await dialog.getByRole('button', { name: '依頼文をコピー' }).click();
      await expect(page.getByText(/コピーしました|コピーできませんでした/)).toBeVisible();
      const pages = [{ key: 's1', layout: 'cover', title: '表紙', sourceParagraphIds: ['p1', 'p2', 'p3'] }, { key: 's2', layout: 'points', title: '要点', sourceParagraphIds: ['p4', 'p5'] }];
      await dialog.getByLabel('AI の回答').fill(JSON.stringify({ schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages }));
      await dialog.getByRole('button', { name: '確かめる' }).click();
      await expect(dialog.getByText('段落「p6」がどのページにも入っていません')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'この構成案を使う' })).toBeDisabled();
      pages[1]!.sourceParagraphIds.push('p6');
      await dialog.getByLabel('AI の回答').fill('```json\n' + JSON.stringify({ schema: SLIDES_OUTLINE_SCHEMA, glossary: [], pages }) + '\n```');
      await dialog.getByRole('button', { name: '確かめる' }).click();
      await dialog.getByRole('button', { name: 'この構成案を使う' }).click();
      await expect(dialog).toHaveCount(0);
      await page.getByRole('button', { name: 'この構成で作る' }).click();
      await page.getByRole('button', { name: /次の 2 ページの本文を貼り付けで頼む/ }).click();
      await expect(dialog.getByLabel('依頼文')).toHaveValue(/key が「s1・s2」/);
      await dialog.getByLabel('AI の回答').fill(JSON.stringify([{ ...pageBody('s1', 'cover'), fields: { subtitle: '副題だけ' } }, pageBody('s2', 'points')]));
      await dialog.getByRole('button', { name: '確かめる' }).click();
      await expect(dialog.getByText('[0].fields.title')).toBeVisible();
      await slidesShot(page, `b10-paste-${theme}`);
      await dialog.getByRole('button', { name: '合格したページを採用' }).click();
      await expect.poll(async () => (await slidesState(request, project.id)).document.generation!.pages.map(state => state.status)).toEqual(['pending', 'generated']);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
