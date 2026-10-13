import { test, expect } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { gradientLayer, shapeLayer, textLayer } from '../src/core/thumbnail/fixtures';
import { SequenceStore } from '../src/server/sequence/store';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { canvasToScreen, createThumbnailProject, drag, openThumbnailMode, thumbnailCommand, thumbnailState, clickUntilVisible } from './thumbnailHelpers';

async function callJson<T>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  // 既存の src/server/mcp/server.test.ts と同じ読み方。
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find(item => item.type === 'text')?.text ?? '{}';
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}
interface SessionSummary { sessionId: string; status: string; projectId: string | null; revision: string | null; dirty: boolean }

test('[3] サムネモードで未保存のサムネがあっても、AI の動画編集（editor_apply）が通り、サムネは変わらない', async ({ page, request, baseURL }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-ai');
  const client = new Client({ name: 'thumbnail-acceptance', version: '1.0.0' }), transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL));
  await client.connect(transport);
  try {
    await openThumbnailMode(page, project.id);
    await page.getByRole('complementary', { name: 'テキスト' }).getByRole('button', { name: '見出しを足す', exact: true }).click();
    await expect.poll(async () => (await thumbnailState(request, project.id)).dirty).toBe(true);
    const thumbnailBefore = await thumbnailState(request, project.id);
    const thumbnailFile = join(project.dir, '.harness', 'thumbnail.v1.json'), fileBefore = readFileSync(thumbnailFile, 'utf8');
    // 画面の接続（心拍）が届くまで待つ。サムネが未保存でも、動画側は「未保存なし」のまま。
    let session: SessionSummary | undefined;
    await expect.poll(async () => {
      const listed = await callJson<{ sessions: SessionSummary[] }>(client, 'editor_read', {});
      session = listed.sessions.find(item => item.projectId === project.id && item.status === 'ready');
      return session ? session.dirty : null;
    }, { timeout: 30_000 }).toBe(false);
    const receipt = await callJson<{ runId: string }>(client, 'editor_apply', { sessionId: session!.sessionId, request: {
      schemaVersion: 1, projectId: project.id, operationId: `thumbnail-acceptance-${Date.now()}`, baseRevision: session!.revision, changes: [],
      sequence: { documentId: project.id, commands: [{ type: 'add-track', track: { id: 'ai-track', kind: 'visual', name: 'AIのトラック' } }] } } });
    await expect.poll(async () => (await callJson<{ phase: string }>(client, 'editor_runs', { runId: receipt.runId })).phase, { timeout: 60_000 }).toBe('saved');
    expect(new SequenceStore(project.dir).load()!.document.tracks.map(track => track.id)).toContain('ai-track');
    const thumbnailAfter = await thumbnailState(request, project.id);
    expect(thumbnailAfter.document).toEqual(thumbnailBefore.document);
    expect(thumbnailAfter.dirty).toBe(true);
    expect(readFileSync(thumbnailFile, 'utf8')).toBe(fileBefore);
  } finally {
    await transport.terminateSession().catch(() => undefined); await client.close().catch(() => undefined);
    await page.goto('about:blank'); removeTempProject(project.dir);
    // editor_apply が案件置き場に作る操作台帳（追跡外の残骸）を片付ける。
    rmSync(join(dirname(project.dir), '.sme-editor-operations.json'), { force: true });
  }
});

test('[9] 1 回のドラッグ・つまみの 1 回の操作が元に戻す 1 回分になり、動画側には効かない', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = createThumbnailProject('e2e-thumb-undo');
  const revision = async () => (await thumbnailState(request, project.id)).document.revision;
  const box = async () => (await thumbnailState(request, project.id)).document.pages[0]!.layers[0]!;
  const video = async () => {
    const response = await request.post(`/api/sequence/session?id=${project.id}`, { data: {} });
    expect(response.ok(), await response.text()).toBe(true);
    const state = await response.json() as { document: { revision: number }; canUndo: boolean; savedContentHash: string };
    return { revision: state.document.revision, canUndo: state.canUndo, hash: state.savedContentHash };
  };
  try {
    await openThumbnailMode(page, project.id);
    const videoBefore = await video(), pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: shapeLayer('box') });
    const start = await revision(), center = await canvasToScreen(page, 640, 360);
    await clickUntilVisible(page, center, page.locator('.native-thumbnail-outline[data-layer-id="box"]'));
    await drag(page, center, { x: center.x + 128 * center.scale, y: center.y }, { alt: true });
    await expect.poll(revision).toBe(start + 1);
    // つまみ「大きさ」（5〜400%、今は 100%）を、つまんで右へ動かして離す。
    const slider = page.locator('[data-knob="scale"] input[type="range"]'), track = (await slider.boundingBox())!;
    const from = { x: track.x + track.width * (95 / 395), y: track.y + track.height / 2 };
    await drag(page, from, { x: track.x + track.width * .5, y: from.y });
    await expect.poll(revision).toBe(start + 2);
    expect((await box()).visual.scale).toBeGreaterThan(1.5);
    // 入力欄からフォーカスを外してから元に戻す（キャンバスの空きをクリック＝選択解除）。
    const empty = await canvasToScreen(page, 40, 40);
    await page.mouse.click(empty.x, empty.y);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await box()).visual.scale).toBe(1);
    expect((await box()).visual.position.x).toBeGreaterThan(.1);
    await page.keyboard.press('ControlOrMeta+KeyZ');
    await expect.poll(async () => (await box()).visual.position).toEqual({ x: 0, y: 0 });
    expect((await thumbnailState(request, project.id)).document.pages[0]!.layers).toHaveLength(1);
    expect(await video()).toEqual(videoBefore);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

for (const theme of ['light', 'dark'] as const) for (const width of [1280, 1440]) {
  test(`見た目（A 案＋右のつまみ）: ${theme} ${width}px`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 860 });
    await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
    const project = createThumbnailProject(`e2e-thumb-look-${theme}-${width}`);
    try {
      await openThumbnailMode(page, project.id);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
      await thumbnailCommand(request, project.id, { type: 'batch', commands: [
        { type: 'add-layer', pageId, layer: gradientLayer('shade') },
        { type: 'add-layer', pageId, layer: { ...textLayer('title', '今日の一打'), visual: { position: { x: 0, y: -.4 }, scale: 1, rotation: 0, opacity: 1 } } },
        { type: 'add-layer', pageId, layer: { ...shapeLayer('box'), visual: { position: { x: .5, y: .45 }, scale: 1, rotation: 0, opacity: 1 } } }] });
      await page.getByRole('navigation', { name: 'サムネの道具' }).getByRole('button', { name: 'レイヤー' }).click();
      await page.getByRole('list', { name: '重なり順（上が前面）' }).getByRole('button', { name: '今日の一打', exact: true }).click();
      await expect(page.getByRole('toolbar', { name: '文字の道具' })).toBeVisible();
      await expect(page.getByRole('toolbar', { name: '選んだ物のメニュー' })).toBeVisible();
      // 存在検査: スマホの縮小画像と下の案の縮小画像が実際に届くまで待つ（空枠のまま撮ると見本と比べられない）。
      const loaded = page.locator('.native-thumbnail-phone-image, .native-thumbnail-page-pick img');
      await expect(page.locator('img.native-thumbnail-phone-image')).toHaveCount(1, { timeout: 30_000 });
      await expect(page.locator('.native-thumbnail-page-empty')).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(() => loaded.evaluateAll(items => items.length > 0 && items.every(item => item instanceof HTMLImageElement && item.complete && item.naturalWidth > 0)), { timeout: 30_000 }).toBe(true);
      await page.screenshot({ path: join(shotDir('thumbnail'), `b18-${theme}-${width}.png`) });
      // 横にはみ出さない（ヘッダー・左の列と引き出し・キャンバス・右のつまみ・下の案が収まる）。
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
