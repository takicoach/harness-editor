import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { openNativeAi, restartFakeAi } from './aiTabHelpers';
import { createThumbnailProject } from './thumbnailHelpers';

const promptCount = async (text: Promise<string | null>) => ((await text) ?? '').match(/FAKE-CLAUDE PROMPT/g)?.length ?? 0;

test('AI タブを開くと待機ボタン無しで起動し、最初の依頼は起動 1 回につき 1 回だけ（再読み込み・別ウィンドウでは増えない）', async ({ page, context }) => {
  const project = createThumbnailProject('e2e-ai-autostart');
  try {
    await openNativeAi(page, project.id);
    const term = await restartFakeAi(page);
    await expect(term).toContainText('FAKE-CLAUDE PROMPT 動画', { timeout: 15_000 });
    await expect(page.getByRole('button', { name: /待機を開始/ })).toHaveCount(0);
    expect(await promptCount(term.textContent())).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: '✦ AI で編集する' }).click();
    await expect(page.getByTestId('claude-terminal')).toContainText('FAKE-CLAUDE PROMPT 動画', { timeout: 15_000 });
    expect(await promptCount(page.getByTestId('claude-terminal').textContent())).toBe(1);
    const second = await context.newPage();
    const secondTerm = await openNativeAi(second, project.id);
    await expect(secondTerm).toContainText('FAKE-CLAUDE PROMPT 動画');
    expect(await promptCount(secondTerm.textContent())).toBe(1);
    await second.close();
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
