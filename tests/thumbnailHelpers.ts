import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type { SequenceDocument } from '../src/core/sequence/model';
import type { ThumbnailCommand } from '../src/core/thumbnail/commands';
import { SequenceStore } from '../src/server/sequence/store';
import type { ThumbnailSessionState } from '../src/server/thumbnail/service';
import { createTempProject } from './helpers';

/** 動画の新形式データ（素材なし・30 コマ）を持つ使い捨て案件。サムネはモードを開いた時に作られる。 */
export function createThumbnailProject(prefix: string, resolution = { width: 1920, height: 1080 }): { id: string; dir: string } {
  const project = createTempProject(prefix);
  const document: SequenceDocument = { schemaVersion: 2, id: project.id, name: project.id, revision: 0, fps: { num: 30, den: 1 }, resolution, sequenceEndFrame: 30,
    background: '#000000', assets: [], tracks: [], clips: [], transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
  new SequenceStore(project.dir).save({ document, executionId: 'initial', expectedSavedRevision: null });
  return project;
}
/** 直近に開いた画面。API で書き込んだ後、画面が最新の版を受け取るまで待つのに使う。 */
let openedPage: Page | null = null;
export async function openThumbnailMode(page: Page, projectId: string, query = ''): Promise<void> {
  openedPage = page;
  await page.goto(`/?project=${projectId}${query}`);
  await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
  await expect(page.locator('.native-thumbnail')).toBeVisible();
}
export async function thumbnailState(request: APIRequestContext, projectId: string): Promise<ThumbnailSessionState> {
  // モードを開いた直後は、画面がサムネの文書を作るまで MISSING_TARGET が返る。作られるまで待ってから読む。
  let response = await request.post(`/api/thumbnail/session?id=${projectId}`, { data: {} });
  for (let attempt = 0; !response.ok() && (await response.text()).includes('MISSING_TARGET') && attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    response = await request.post(`/api/thumbnail/session?id=${projectId}`, { data: {} });
  }
  expect(response.ok(), await response.text()).toBe(true);
  return await response.json() as ThumbnailSessionState;
}
export async function thumbnailCommand(request: APIRequestContext, projectId: string, command: ThumbnailCommand): Promise<ThumbnailSessionState> {
  const state = await thumbnailState(request, projectId);
  // 画面は別の書き込みを「変更の通知 → 状態の取得」で知る。通知が届く前に画面を操作すると、古い版で送って 409 になる（負荷が高いと起きる）。
  // 画面の状態取得の応答を待ってから返す（通知が来ない・画面が忙しい時は待ち切らずに進む）。
  const page = openedPage && !openedPage.isClosed() && openedPage.url().includes(`project=${projectId}`) ? openedPage : null;
  const synced = page?.waitForResponse(item => item.url().includes('/api/thumbnail/session/status'), { timeout: 4000 }).then(() => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))).catch(() => undefined);
  const response = await request.post(`/api/thumbnail/command?id=${projectId}`, { data: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), command } });
  expect(response.ok(), await response.text()).toBe(true);
  await synced;
  return await response.json() as ThumbnailSessionState;
}

/** キャンバス px を画面座標にする（重ね表示の大きさ ÷ 1280 が表示倍率）。 */
export async function canvasToScreen(page: Page, x: number, y: number): Promise<{ x: number; y: number; scale: number }> {
  const box = (await page.locator('.native-thumbnail-overlay').boundingBox())!, scale = box.width / 1280;
  return { x: box.x + x * scale, y: box.y + y * scale, scale };
}
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, modifiers: { alt?: boolean; shift?: boolean } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  if (modifiers.alt) await page.keyboard.down('Alt');
  if (modifiers.shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  // 負荷が高いと、押した直後の描画（つまみの出現・計測）が追いつく前に動かしてしまい、ドラッグが空振りする。間を置く。
  await page.waitForTimeout(80);
  for (let step = 1; step <= 8; step++) { await page.mouse.move(from.x + (to.x - from.x) * step / 8, from.y + (to.y - from.y) * step / 8); await page.waitForTimeout(16); }
  await page.mouse.up();
  if (modifiers.shift) await page.keyboard.up('Shift');
  if (modifiers.alt) await page.keyboard.up('Alt');
}

/** API で足した直後は画面の描画が追いつかず、クリックが空振りすることがある。目印（選択枠など）が出るまで、クリックをやり直す。 */
export async function clickUntilVisible(page: Page, point: { x: number; y: number }, target: Locator): Promise<void> {
  await expect(async () => {
    await page.mouse.click(point.x, point.y);
    await expect(target).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 20_000 });
}
