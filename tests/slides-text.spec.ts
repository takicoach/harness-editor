import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { clickUntilVisible } from './thumbnailHelpers';
import { createSlidesFixture, openSlides, slidesCanvasToScreen, slidesShot, slidesState } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`文字の道具の帯で箇条書き・揃え・書体を変える（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-text-${theme}`);
    const bullets = async () => { const page2 = (await slidesState(request, project.id)).document.pages[1]!; return { layer: page2.layers.find(layer => layer.id === 'page-2-bullets')!, binding: page2.bindings['page-2-bullets'] }; };
    try {
      await openSlides(page, project.id, theme);
      await page.getByRole('region', { name: 'ページの帯' }).getByRole('button', { name: '2 ページ（要点）' }).click();
      const bar = page.getByRole('toolbar', { name: '文字の道具' });
      // 箇条書きは上揃え・左揃えなので、枠の左上寄り（文字のある所）を押す。
      await clickUntilVisible(page, await slidesCanvasToScreen(page, 300, 330), bar);
      await expect(bar.getByRole('button', { name: '箇条書き' })).toHaveAttribute('aria-pressed', 'true');
      await bar.getByRole('button', { name: '箇条書き' }).click();
      await expect.poll(async () => { const { layer } = await bullets(); return layer.content.kind === 'text' ? layer.content.text : ''; }).toBe('左手から握る\n親指は少し右\n力は 3 割');
      await bar.getByRole('button', { name: '中央揃え' }).click();
      await expect.poll(async () => { const { layer } = await bullets(); return layer.content.kind === 'text' ? layer.content.appearance.align : ''; }).toBe('center');
      await bar.getByLabel('書体').selectOption('zen-kaku-gothic-new');
      await expect.poll(async () => (await bullets()).binding).toEqual({ slot: 'bullets', color: 'text' });
      await slidesShot(page, `b6-text-${theme}`);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}

test('上揃えの文字をダブルクリックで直すと、入力欄は実際の文字の位置（枠の上端）に出る', async ({ page, request }) => {
  const project = createSlidesFixture('e2e-slides-edit-top');
  try {
    await openSlides(page, project.id, 'light');
    await page.getByRole('region', { name: 'ページの帯' }).getByRole('button', { name: '2 ページ（要点）' }).click();
    const doc = (await slidesState(request, project.id)).document, layer = doc.pages[1]!.layers.find(item => item.id === 'page-2-bullets')!;
    const field = page.getByRole('textbox', { name: '文字の編集' }), point = await slidesCanvasToScreen(page, 300, 330);
    await expect(async () => { await page.mouse.dblclick(point.x, point.y); await expect(field).toBeVisible({ timeout: 1000 }); }).toPass();
    // 上揃えは層の位置が枠の上端。入力欄の上端もそこになる（半分ずれていれば 100px 以上外れる）。
    const top = await slidesCanvasToScreen(page, 0, 540 * (1 + layer.visual.position.y)), box = (await field.boundingBox())!;
    expect(Math.abs(box.y - top.y)).toBeLessThan(4);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
