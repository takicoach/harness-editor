import { expect, test, type Page } from '@playwright/test';
import { removeTempProject } from './helpers';
import { aiTabShot, connectAiTabMcp, restartFakeAi } from './aiTabHelpers';
import { createThumbnailProject, openThumbnailMode, thumbnailCommand } from './thumbnailHelpers';

async function openAiColumn(page: Page) {
  await page.getByRole('complementary', { name: 'AI' }).getByRole('button', { name: '✦ AI で編集する' }).click();
  return restartFakeAi(page);
}

for (const theme of ['light', 'dark'] as const) {
  test(`欄から入力欄に貼られ、Enter の前は送られない。Enter で作業中、確定で案が増えて完了（${theme}）`, async ({ page, request, baseURL }) => {
    const project = createThumbnailProject(`thumb-ai-${theme}`);
    try {
      await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
      await openThumbnailMode(page, project.id);
      const terminal = await openAiColumn(page), mcp = await connectAiTabMcp(baseURL!);
      try {
        const knobs = page.getByRole('complementary', { name: 'つまみ' });
        const panel = knobs.getByRole('region', { name: 'AI に頼む' });
        await knobs.getByRole('button', { name: 'AI に頼む' }).click();
        await knobs.getByRole('radio', { name: '新しい案を作る' }).check();
        await knobs.getByRole('textbox', { name: 'ひとこと' }).fill('飛距離の回');
        // 接続の表示が追い付くまで待つ（つながるとボタン名が「AI タブに入れる」になる）。
        await expect(knobs.getByRole('button', { name: 'AI タブに入れる' })).toBeVisible({ timeout: 15_000 });
        await aiTabShot(page, `t8-thumbnail-ai-form-${theme}`);
        await knobs.getByRole('button', { name: 'AI タブに入れる' }).click();
        await expect(terminal).toContainText(/サ\s*ム\s*ネ\s*:\s*新\s*し\s*い\s*案/);
        await expect(panel.getByRole('status')).toContainText('送信待ち');
        await aiTabShot(page, `t8-thumbnail-ai-pending-${theme}`);
        await terminal.click(); await page.keyboard.press('Enter');
        await expect(panel.getByRole('status')).toContainText('作業中');
        await aiTabShot(page, `t8-thumbnail-ai-working-${theme}`);
        const latest = await (await request.get(`/api/ai/thumbnail-requests?id=${project.id}`)).json();
        const read = (await mcp.call('thumbnail_read', { projectId: project.id, requestId: latest.request.requestId })).json;
        const applied = (await mcp.call('thumbnail_apply', { projectId: project.id, requestId: latest.request.requestId, operationId: 'e2e-1', baseRevision: read.document.revision,
          ops: [{ type: 'add-layer', pageId: 'new', layer: { id: 'ai-t1', content: { kind: 'text', text: '飛ぶ' } } }] })).json;
        expect(applied.status).toBe('saved');
        await expect(page.getByRole('list', { name: '案' }).getByRole('listitem')).toHaveCount(2);
        await expect(panel.getByRole('status')).toContainText('完了');
        await aiTabShot(page, `t8-thumbnail-ai-done-${theme}`);
      } finally { await mcp.close(); }
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}

for (const theme of ['light', 'dark'] as const) test(`案が 3 つで新しい案は、入れ替える案を選ぶまで貼れない（${theme}）`, async ({ page, request, baseURL }) => {
  const project = createThumbnailProject(`thumb-ai-full-${theme}`);
  try {
    await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
    await openThumbnailMode(page, project.id);
    await thumbnailCommand(request, project.id, { type: 'add-page', pageId: 'page-b', name: '案B' });
    await thumbnailCommand(request, project.id, { type: 'add-page', pageId: 'page-c', name: '案C' });
    await openAiColumn(page);
    const mcp = await connectAiTabMcp(baseURL!);
    try {
      const knobs = page.getByRole('complementary', { name: 'つまみ' });
      await knobs.getByRole('button', { name: 'AI に頼む' }).click();
      await knobs.getByRole('radio', { name: '新しい案を作る' }).check();
      await expect(knobs.getByRole('combobox', { name: '入れ替える案' })).toBeVisible();
      await expect(knobs.getByRole('button', { name: /^AI タブ(に入れる|を開く)$/ })).toBeDisabled();
      await aiTabShot(page, `t8-thumbnail-ai-replace-needed-${theme}`);
      await knobs.getByRole('combobox', { name: '入れ替える案' }).selectOption({ label: '案C' });
      await expect(knobs.getByRole('button', { name: 'AI タブに入れる' })).toBeEnabled({ timeout: 15_000 });
    } finally { await mcp.close(); }
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('選んでいる案を直す依頼は、その案の名前で入力欄に貼られる', async ({ page, baseURL }) => {
  const project = createThumbnailProject('thumb-ai-edit');
  try {
    await openThumbnailMode(page, project.id);
    const terminal = await openAiColumn(page), mcp = await connectAiTabMcp(baseURL!);
    try {
      const knobs = page.getByRole('complementary', { name: 'つまみ' });
      await knobs.getByRole('button', { name: 'AI に頼む' }).click();
      await knobs.getByRole('radio', { name: /選んでいる案を直す/ }).check();
      await expect(knobs.getByRole('button', { name: 'AI タブに入れる' })).toBeEnabled({ timeout: 15_000 });
      await knobs.getByRole('button', { name: 'AI タブに入れる' }).click();
      await expect(terminal).toContainText(/案\s*A\s*を\s*直\s*し\s*て/);
      await expect(knobs.getByRole('region', { name: 'AI に頼む' }).getByRole('status')).toContainText('送信待ち');
    } finally { await mcp.close(); }
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('端末に直接頼んだ依頼（thumbnail_begin）も、ボタンを押さなくても欄の状態に出て、確定で完了になる', async ({ page, baseURL }) => {
  const project = createThumbnailProject('thumb-ai-direct');
  try {
    await openThumbnailMode(page, project.id);
    const terminal = await openAiColumn(page), mcp = await connectAiTabMcp(baseURL!);
    try {
      const panel = page.getByRole('complementary', { name: 'つまみ' }).getByRole('region', { name: 'AI に頼む' });
      await expect(panel.getByRole('status')).toHaveCount(0);
      // 利用者が端末に直接打って頼む（依頼時点の確認は、この Enter で記録される）。
      await terminal.click(); await page.keyboard.type('サムネの新しい案を作って'); await page.keyboard.press('Enter');
      const begun = await mcp.call('thumbnail_begin', { projectId: project.id, kind: 'new' });
      expect(begun.isError).toBe(false);
      await expect(panel.getByRole('status')).toContainText('作業中', { timeout: 15_000 });
      await aiTabShot(page, 't8-thumbnail-ai-direct-working-light');
      const read = (await mcp.call('thumbnail_read', { projectId: project.id, requestId: begun.json.requestId })).json;
      const applied = (await mcp.call('thumbnail_apply', { projectId: project.id, requestId: begun.json.requestId, operationId: 'e2e-direct-1', baseRevision: read.document.revision,
        ops: [{ type: 'add-layer', pageId: 'new', layer: { id: 'ai-t1', content: { kind: 'text', text: '飛ぶ' } } }] })).json;
      expect(applied.status).toBe('saved');
      await expect(panel.getByRole('status')).toContainText('完了', { timeout: 15_000 });
      await aiTabShot(page, 't8-thumbnail-ai-direct-done-light');
    } finally { await mcp.close(); }
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('つまみを畳んでも「AI に頼む」の入口が残り、動いている依頼を点で知らせる。押すとつまみが開いて欄が出る', async ({ page, baseURL }) => {
  const project = createThumbnailProject('thumb-ai-collapsed');
  try {
    await openThumbnailMode(page, project.id);
    const terminal = await openAiColumn(page), mcp = await connectAiTabMcp(baseURL!);
    try {
      const knobs = page.getByRole('complementary', { name: 'つまみ' });
      await knobs.getByRole('button', { name: 'つまみを畳む' }).click();
      const shortcut = knobs.getByRole('button', { name: /^AI に頼む/ });
      await expect(shortcut).toBeVisible();
      await expect(shortcut).not.toHaveAttribute('data-state');
      // 畳んだまま端末から直接頼むと、照会が止まらず入口に状態が出る。
      await terminal.click(); await page.keyboard.type('サムネの新しい案を作って'); await page.keyboard.press('Enter');
      const begun = await mcp.call('thumbnail_begin', { projectId: project.id, kind: 'new' });
      expect(begun.isError).toBe(false);
      await expect(shortcut).toHaveAttribute('aria-label', /作業中/, { timeout: 15_000 });
      await expect(shortcut).toHaveAttribute('data-state', 'working');
      const box = await shortcut.boundingBox(), column = await knobs.boundingBox();
      expect(box && column && box.x >= column.x && box.x + box.width <= column.x + column.width).toBe(true);
      await aiTabShot(page, 't8-thumbnail-ai-collapsed-light');
      await shortcut.click();
      await expect(knobs.getByRole('button', { name: 'つまみを畳む' })).toBeVisible();
      await expect(knobs.getByRole('region', { name: 'AI に頼む' }).getByRole('textbox', { name: 'ひとこと' })).toBeVisible();
      await expect(knobs.getByRole('region', { name: 'AI に頼む' }).getByRole('status')).toContainText('作業中');
    } finally { await mcp.close(); }
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
