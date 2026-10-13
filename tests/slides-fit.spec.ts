import { expect, test } from '@playwright/test';
import { extractFields } from '../src/core/slides/build';
import { applySlideCommand } from '../src/core/slides/commands';
import { splitScript } from '../src/core/slides/contract';
import { pageBody, scriptText } from '../src/core/slides/fixtures';
import { emptySlideDocument, type SlideDocument } from '../src/core/slides/model';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesCommand, slidesShot, slidesState } from './slidesHelpers';

function generated(): SlideDocument {
  let document = emptySlideDocument('slides-fit'); document.script = { paragraphs: splitScript(scriptText(6)) };
  document = applySlideCommand(document, { type: 'set-outline', runId: 'r1', glossary: [], model: null, outline: [
    { key: 's1', layout: 'compare', title: '比較', sourceParagraphIds: ['p1', 'p2', 'p3'] }, { key: 's2', layout: 'points', title: '要点', sourceParagraphIds: ['p4', 'p5', 'p6'] }] });
  document = applySlideCommand(document, { type: 'confirm-outline' });
  return applySlideCommand(document, { type: 'apply-page-bodies', runId: 'r1', failures: [], model: null, bodies: [{ body: pageBody('s1', 'compare'), images: {} }, { body: pageBody('s2', 'points'), images: {} }] });
}
for (const theme of ['light', 'dark'] as const) {
  test(`収まり（分ける・短くする・別のレイアウト）・元の台本・置き換え案の採用（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-fit-${theme}`, generated()), doc = async () => (await slidesState(request, project.id)).document;
    try {
      await openSlides(page, project.id, theme);
      const knobs = page.getByRole('complementary', { name: 'つまみ' });
      await expect(knobs.getByText('OK（すべての文字が枠に収まっています）')).toBeVisible();
      await expect(knobs.getByText('元の台本: 段落 1〜3')).toBeVisible();
      const first = (await doc()).pages[0]!, body = first.layers.find(layer => first.bindings[layer.id]?.slot === 'left-body')!;
      if (body.content.kind !== 'text') throw new Error('本文が文字ではありません');
      await slidesCommand(request, project.id, { type: 'update-layer', pageId: first.id, layerId: body.id, patch: { content: { ...body.content, text: 'あ'.repeat(300) } } });
      await expect(knobs.getByText('文字が多すぎて枠に収まりません')).toBeVisible();
      await expect(knobs.getByRole('button', { name: '分ける' })).toHaveCount(0);
      await expect(knobs.getByRole('button', { name: '短くする' })).toBeVisible();
      await slidesShot(page, `b11-fit-${theme}`);
      await knobs.getByRole('button', { name: '別のレイアウト' }).click();
      await expect(page.getByRole('complementary', { name: 'レイアウト' })).toBeVisible();
      // 手で直したページへの作り直しは置き換え案になる → 採用すると置き換わる。
      const state = await slidesState(request, project.id);
      const applied = await request.post(`/api/slides/apply?${new URLSearchParams({ id: project.id })}`, { data: { documentId: state.document.id, sessionId: state.sessionId,
        expectedRevision: state.document.revision, kind: 'pages', runId: 'r1', regenerate: true, operationId: crypto.randomUUID(), payload: [pageBody('s1', 'compare')] } });
      expect(applied.ok(), await applied.text()).toBe(true);
      await expect(knobs.getByRole('region', { name: '置き換え案' })).toContainText('良い例：肩の力が抜けている');
      await slidesShot(page, `b11-proposal-${theme}`);
      await knobs.getByRole('button', { name: '採用する' }).click();
      await expect.poll(async () => extractFields((await doc()).pages[0]!).left).toEqual({ title: '良い例', body: '肩の力が抜けている' });
      // 箇条書きのページは「分ける」で 2 ページに。
      await page.getByRole('region', { name: 'ページの帯' }).getByRole('button', { name: '2 ページ（要点）' }).click();
      const second = (await doc()).pages[1]!, bullets = second.layers.find(layer => second.bindings[layer.id]?.slot === 'bullets')!;
      if (bullets.content.kind !== 'text') throw new Error('箇条書きが文字ではありません');
      await slidesCommand(request, project.id, { type: 'update-layer', pageId: second.id, layerId: bullets.id,
        patch: { content: { ...bullets.content, text: Array.from({ length: 5 }, (_, i) => `・${i + 1}つ目は${'長い説明'.repeat(11)}`).join('\n') } } });
      await knobs.getByRole('button', { name: '分ける' }).click();
      await expect.poll(async () => (await doc()).pages).toHaveLength(3);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
