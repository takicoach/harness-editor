import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { aiFocusView, aiTabShot } from './aiTabHelpers';
import { createThumbnailProject, openThumbnailMode } from './thumbnailHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`サムネの画面の右端から AI を開ける。開いた画面は主画面でモードはサムネ（${theme}）`, async ({ page, request }) => {
    const project = createThumbnailProject(`e2e-ai-thumb-${theme}`);
    try {
      await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
      await openThumbnailMode(page, project.id);
      const column = page.getByRole('complementary', { name: 'AI' });
      await column.getByRole('button', { name: '✦ AI で編集する' }).click();
      const term = column.getByTestId('claude-terminal');
      await expect(term).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });
      await expect(page.getByTestId('claude-terminal')).toHaveCount(1);
      await expect.poll(async () => (await aiFocusView(request)).primary?.screen).toMatchObject({ projectId: project.id, mode: 'thumbnail' });
      await aiTabShot(page, `t4-thumbnail-ai-open-${theme}`);
      await column.getByRole('button', { name: 'AI を閉じる' }).click();
      await expect(page.getByTestId('claude-terminal')).toHaveCount(0);
      await aiTabShot(page, `t4-thumbnail-ai-closed-${theme}`);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
