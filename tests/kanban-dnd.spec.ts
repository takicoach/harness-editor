import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';

const STATUS_FILE = join(
  import.meta.dirname,
  '..',
  'src/server/__fixtures__/sample-project/.sme/status.json',
);

test.describe.configure({ mode: 'serial' });

test.afterEach(() => {
  if (existsSync(STATUS_FILE)) rmSync(STATUS_FILE);
});

async function openKanban(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.locator('.home-view-btn', { hasText: '進行ボード' }).click({ timeout: 15_000 });
  await expect(page.locator('.home-col')).toHaveCount(6);
}

test('進行ボード: カードを別列へドラッグ → stage 固定・手動バッジ・status.json 書込', async ({ page }) => {
  await openKanban(page);
  const card = page.locator('.home-col .home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible();

  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  const telopCol = page.locator('.home-col[data-status="telop"]');
  await telopCol.dispatchEvent('dragover', { dataTransfer });
  await telopCol.dispatchEvent('drop', { dataTransfer });

  // カードがテロップ列へ移動し、手動バッジが出る
  await expect(
    page.locator('.home-col[data-status="telop"] .home-card', { hasText: 'sample-project' }),
  ).toBeVisible();
  await expect(page.locator('.home-card .home-card-manual')).toBeVisible();

  // サーバへ手動 stage が永続化される
  await expect
    .poll(() =>
      existsSync(STATUS_FILE)
        ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as { stage?: string }).stage
        : undefined,
    )
    .toBe('telop');
});

test('進行ボード: idle 列への手動移動も受理される（全6値）', async ({ page }) => {
  await openKanban(page);
  const card = page.locator('.home-col .home-card', { hasText: 'sample-project' });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  const idleCol = page.locator('.home-col[data-status="idle"]');
  await idleCol.dispatchEvent('dragover', { dataTransfer });
  await idleCol.dispatchEvent('drop', { dataTransfer });
  await expect(
    page.locator('.home-col[data-status="idle"] .home-card', { hasText: 'sample-project' }),
  ).toBeVisible();
  await expect
    .poll(() =>
      existsSync(STATUS_FILE)
        ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as { stage?: string }).stage
        : undefined,
    )
    .toBe('idle');
});

test('進行ボード: 削除アイコンを掴んでもカードはドラッグされない（実ポインタ操作）', async ({ page }) => {
  await openKanban(page);
  const card = page.locator('.home-col .home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible();
  const colStatus = await card.locator('xpath=ancestor::div[@data-status][1]').getAttribute('data-status');
  // 移動先はカードが今いる列以外（1 列目が同じなら 2 列目を使う）。
  const targetStatus = colStatus === 'idle' ? 'telop' : 'idle';

  // ホバーで削除アイコンを出し、その上で実際にマウスを押して別列までドラッグする。
  await card.hover();
  const delBtn = card.locator('.home-card-delete');
  await expect(delBtn).toBeVisible();
  const from = await delBtn.boundingBox();
  const targetCol = page.locator(`.home-col[data-status="${targetStatus}"]`);
  const to = await targetCol.boundingBox();
  if (from === null || to === null) throw new Error('bounding box を取得できませんでした');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();

  // カードは元の列に留まり、手動バッジも status.json も生まれない。
  await expect(
    page.locator(`.home-col[data-status="${colStatus}"] .home-card`, { hasText: 'sample-project' }),
  ).toBeVisible();
  await expect(page.locator('.home-card .home-card-manual')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(existsSync(STATUS_FILE)).toBe(false);
});

test('進行ボード: 同一列内 drop は何も起こさない（列間移動専用）', async ({ page }) => {
  await openKanban(page);
  const card = page.locator('.home-col .home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible();
  // カードが現在いる列を特定して同じ列へ drop
  const colStatus = await card
    // 祖先の列 div（`home-col-cards` にも contains(@class,"home-col") が当たるため data-status で絞る）
    .locator('xpath=ancestor::div[@data-status][1]')
    .getAttribute('data-status');
  const sameCol = page.locator(`.home-col[data-status="${colStatus}"]`);
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer });
  await sameCol.dispatchEvent('dragover', { dataTransfer });
  await sameCol.dispatchEvent('drop', { dataTransfer });
  // 手動バッジは付かず、status.json も書かれない
  await expect(page.locator('.home-card .home-card-manual')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(existsSync(STATUS_FILE)).toBe(false);
});
