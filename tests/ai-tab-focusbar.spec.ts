import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { aiTabShot, connectAiTabMcp, openNativeAi } from './aiTabHelpers';
import { createThumbnailProject } from './thumbnailHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`AI タブ上部は「画面」と「AI が最後に確認」を分けて出す（${theme}）`, async ({ page, baseURL }) => {
    const project = createThumbnailProject(`e2e-ai-bar-${theme}`);
    const mcp = await connectAiTabMcp(baseURL!);
    try {
      await openNativeAi(page, project.id, theme);
      const bar = page.getByLabel('AI が見ている画面');
      await expect(bar).toContainText(`画面: ${project.id}／動画`, { timeout: 10_000 });
      await mcp.call('editor_context');
      await expect(bar).toContainText(`AI が最後に確認: ${project.id}／動画`, { timeout: 10_000 });
      await aiTabShot(page, `t14-focusbar-video-${theme}`);
      await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
      // サムネに切り替えても AI タブは開いたまま（ボタンを押し直す必要はない）。
      const thumbBar = page.getByLabel('AI が見ている画面');
      await expect(thumbBar).toContainText(`画面: ${project.id}／サムネ`, { timeout: 10_000 });
      await expect(thumbBar).toContainText('次の依頼で AI が確かめます');
      await aiTabShot(page, `t14-focusbar-thumbnail-stale-${theme}`);
    } finally { await mcp.close(); await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
