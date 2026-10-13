import { expect, test } from '@playwright/test';
import { removeTempProject } from './helpers';
import { connectAiTabMcp, openNativeAi, restartFakeAi } from './aiTabHelpers';
import { createThumbnailProject } from './thumbnailHelpers';

const change = (projectId: string, editorSessionId: string) => ({ sessionId: editorSessionId, request: { schemaVersion: 1, projectId, operationId: `acceptance-${projectId}-${Date.now()}`,
  baseRevision: 'stale-revision', changes: [{ type: 'set_telop_text', elementId: 'caption', before: 'before', after: 'after', sourceFrameRange: { start: 0, end: 30 } }] } });

test('合格条件の仕組み: 開いて打つだけで依頼時点が正しい案件になり、切り替えた後も別の案件には書き込まない', async ({ page, context, baseURL }) => {
  const a = createThumbnailProject('e2e-ai-accept-a'), b = createThumbnailProject('e2e-ai-accept-b');
  const mcp = await connectAiTabMcp(baseURL!);
  try {
    // 1. AI タブを開く → 最初の依頼（あいさつ）が 1 回入る。
    await openNativeAi(page, a.id);
    const term = await restartFakeAi(page);
    await expect(term).toContainText('FAKE-CLAUDE PROMPT 動画', { timeout: 15_000 });
    // 2. 打つ前: 画面は A（動画）。依頼は、偽の AI を終わらせた時の Enter（restartFakeAi）だけが A で残っている。
    const before = (await mcp.call('editor_context')).json;
    expect(before).toMatchObject({ screen: { projectId: a.id, mode: 'video', target: { kind: 'video' } }, request: { projectId: a.id, mode: 'video' }, switchedSinceRequest: false });
    const restartAt = before.request.at as number;
    // 3. 「この動画の冒頭を詰めて」と打って Enter → 依頼時点は A（動画）。
    await term.click();
    await page.keyboard.type('この動画の冒頭を詰めて');
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await mcp.call('editor_context')).json.request?.at as number).toBeGreaterThan(restartAt);
    expect((await mcp.call('editor_context')).json.request).toMatchObject({ projectId: a.id, mode: 'video' });
    const editorSessionId = before.screen.target.editorSessionId as string;
    // 4. A への書き込みは対象確認を通る（版が古いので別の理由で断られるが、TARGET_NOT_REQUESTED ではない）。
    const toA = await mcp.call('editor_apply', change(a.id, editorSessionId));
    expect(toA.json.code).not.toBe('TARGET_NOT_REQUESTED');
    // 5. サムネに切り替えた直後も、同じ案件なので書ける。editor_context はモードの移動だけを知らせる。
    await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect.poll(async () => (await mcp.call('editor_context')).json.modeChangedSinceRequest).toBe(true);
    expect((await mcp.call('editor_apply', change(a.id, editorSessionId))).json.code).not.toBe('TARGET_NOT_REQUESTED');
    // 6. 別の画面で B を開いて AI タブを開く（主画面が B に移る）。依頼し直していないので、B への書き込みは断る。
    const second = await context.newPage();
    await openNativeAi(second, b.id);
    const switched = (await mcp.call('editor_context')).json;
    expect(switched).toMatchObject({ screen: { projectId: b.id }, request: { projectId: a.id }, switchedSinceRequest: true });
    const toB = await mcp.call('editor_apply', change(b.id, 'any-session'));
    expect(toB).toMatchObject({ isError: true, json: { code: 'TARGET_NOT_REQUESTED', recovery: { action: 'confirm_with_user' } } });
    // 7. B の画面で依頼し直す（Enter）と、依頼時点は B になる（切り替えた直後でも正しい案件へ）。
    const secondTerm = second.getByTestId('claude-terminal');
    await secondTerm.click();
    await second.keyboard.type('冒頭を詰めて');
    await second.keyboard.press('Enter');
    await expect.poll(async () => (await mcp.call('editor_context')).json.request?.projectId).toBe(b.id);
    expect((await mcp.call('editor_apply', change(b.id, 'any-session'))).json.code).not.toBe('TARGET_NOT_REQUESTED');
    await second.close();
  } finally { await mcp.close(); await page.goto('about:blank'); removeTempProject(a.dir); removeTempProject(b.dir); }
});
