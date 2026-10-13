import { expect, test } from '@playwright/test';
import { scriptText } from '../src/core/slides/fixtures';
import { emptySlideDocument } from '../src/core/slides/model';
import type { InstructionRecord } from '../src/shared/types';
import { removeTempProject } from './helpers';
import { aiTabShot, connectAiTabMcp, restartFakeAi } from './aiTabHelpers';
import { createSlidesFixture, openSlides, slidesCommand } from './slidesHelpers';

async function lastRecord(request: import('@playwright/test').APIRequestContext, projectId: string): Promise<InstructionRecord | null> {
  const body = await (await request.get(`/api/events/sync?${new URLSearchParams({ id: projectId, ch: 'claude' })}`)).json() as { messages: Array<{ record?: InstructionRecord }> };
  return body.messages.map(message => message.record).filter((record): record is InstructionRecord => !!record).at(-1) ?? null;
}

for (const theme of ['light', 'dark'] as const) {
  test(`スライドの「構成案を AI に頼む」は入力欄に貼るだけで、Enter で作業中、AI の報告で完了（${theme}）`, async ({ page, request, baseURL }) => {
    const project = createSlidesFixture(`e2e-ai-request-${theme}`, emptySlideDocument('ai-request'));
    try {
      await slidesCommand(request, project.id, { type: 'set-script', text: scriptText(4) });
      await openSlides(page, project.id, theme);
      await page.getByRole('button', { name: 'AI の作業', exact: true }).click();
      const panel = page.getByRole('complementary', { name: 'AI の作業' });
      await expect(panel.getByTestId('claude-terminal')).toContainText('FAKE-CLAUDE READY', { timeout: 15_000 });
      await restartFakeAi(page);
      const mcp = await connectAiTabMcp(baseURL!);
      try {
        await expect(panel.locator('.native-slides-ai-state')).toContainText('AI はつながっています', { timeout: 10_000 });
        await page.getByRole('navigation', { name: 'スライドの道具' }).getByRole('button', { name: '台本から作る' }).click();
        await page.getByRole('button', { name: '構成案を AI に頼む' }).click();
        // 端末の幅で全角の文字が折り返すと、行末に空きが入ることがあるので、空白を許して照合する。
        await expect(panel.getByTestId('claude-terminal')).toContainText(/構\s*成\s*案\s*を\s*作\s*っ\s*て\s*（\s*依\s*頼\s*#/);
        await expect(panel.locator('.native-slides-ai-state')).toContainText('Enter で送って');
        await expect.poll(async () => (await lastRecord(request, project.id))?.status).toBe('pending');
        await aiTabShot(page, `t11-slides-request-pasted-${theme}`);
        await panel.getByTestId('claude-terminal').click();
        await page.keyboard.press('Enter');
        await expect.poll(async () => (await lastRecord(request, project.id))?.status).toBe('processing');
        const id = (await lastRecord(request, project.id))!.id;
        expect((await mcp.call('report_instruction_status', { id: `#${id.replace('inst-', '')}`, status: 'done', reply: '構成案を渡しました' })).json).toEqual({ ok: true });
        await expect(panel.locator('.native-slides-ai-state')).toContainText('構成案を渡しました');
      } finally { await mcp.close(); }
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
