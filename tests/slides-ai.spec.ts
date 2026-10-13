import { expect, test } from '@playwright/test';
import { scriptText } from '../src/core/slides/fixtures';
import { emptySlideDocument } from '../src/core/slides/model';
import { restartFakeAi } from './aiTabHelpers';
import { removeTempProject } from './helpers';
import { createSlidesFixture, openSlides, slidesCommand, slidesShot } from './slidesHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`AI がつながっていないときは依頼を送らず、再接続か貼り付けへの切り替えを案内する（${theme}）`, async ({ page, request }) => {
    const project = createSlidesFixture(`e2e-slides-ai-${theme}`, emptySlideDocument('slides-ai')), sent: string[] = [];
    page.on('request', item => { if (item.method() === 'POST' && new URL(item.url()).pathname === '/api/ai/requests') sent.push(item.url()); });
    try {
      await slidesCommand(request, project.id, { type: 'set-script', text: scriptText(4) });
      await openSlides(page, project.id, theme);
      await page.getByRole('button', { name: 'AI の作業', exact: true }).click();
      const panel = page.getByRole('complementary', { name: 'AI の作業' });
      await expect(panel.getByTestId('claude-terminal')).toBeVisible({ timeout: 15_000 });
      await restartFakeAi(page);
      await expect(panel.locator('.native-slides-ai-state')).toContainText('AI がつながっていません');
      await page.getByRole('navigation', { name: 'スライドの道具' }).getByRole('button', { name: '台本から作る' }).click();
      await page.getByRole('button', { name: '構成案を AI に頼む' }).click();
      await expect(panel.getByRole('button', { name: '貼り付けに切り替える' })).toBeVisible();
      await slidesShot(page, `b12-ai-offline-${theme}`);
      expect(sent).toEqual([]);
      await panel.getByRole('button', { name: '貼り付けに切り替える' }).click();
      await expect(page.getByRole('dialog', { name: '貼り付けで頼む' }).getByLabel('依頼文')).toHaveValue(/harness-slides-outline\/1/);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
