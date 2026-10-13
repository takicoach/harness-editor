import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { aiTabShot, connectAiTabMcp, openNativeAi, restartFakeAi } from './aiTabHelpers';
import { createThumbnailProject } from './thumbnailHelpers';

for (const theme of ['light', 'dark'] as const) {
  test(`AI タブに「導入 → ログイン → 接続の確認 → 使える」を出し、MCP がつながると案内を畳む（${theme}）`, async ({ page, baseURL }) => {
    const project = createThumbnailProject(`e2e-ai-ready-${theme}`);
    try {
      await openNativeAi(page, project.id, theme);
      await restartFakeAi(page);
      const ready = page.getByRole('region', { name: 'AI を使うまで' });
      await expect(ready.getByRole('status')).toContainText('接続を確かめています');
      await expect(ready.getByRole('listitem').filter({ hasText: '接続の確認' })).toHaveAttribute('data-state', 'current');
      await expect(ready).toContainText('この AI タブが必要です');
      await aiTabShot(page, `t13-ready-connecting-${theme}`);
      const mcp = await connectAiTabMcp(baseURL!);
      try {
        // 使えるようになったら案内は畳み、端末に場所を譲る。
        await expect(ready).toHaveCount(0, { timeout: 10_000 });
        await expect(page.getByTestId('claude-terminal')).toBeVisible();
        await aiTabShot(page, `t13-ready-ok-${theme}`);
      } finally { await mcp.close(); }
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
