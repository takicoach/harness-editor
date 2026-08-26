import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const REPO = join(import.meta.dirname, '..');
const FIXROOT = join(REPO, 'src/server/__fixtures__');
/** 使い捨てプロジェクト名（ホームのカード検索キーでもある）。 */
const PROJECT_NAME = 'trash-e2e-proj';
const PROJECT = join(FIXROOT, PROJECT_NAME);
const TRASH = join(PROJECT, '.trash');
const ROOT_TRASH = join(FIXROOT, '.trash');

// このファイルは「untracked ファイルを作って消す」ことそのものを検証する。
// 共有フィクスチャ sample-project は、default project 側の複数 spec（smoke /
// render-button / motion / heavy-job-confirm）が afterEach で
// `git clean -fdx <sample-project>` を掛けており、**別 project の並列 worker が
// 走っている最中に untracked ファイルを消し飛ばす**（実測: フルスイートで
// tmp-restore.mp3 が消え 2 回連続で赤。単体では 4/4 緑）。したがって
// sample-project は使わず、その掃除の射程外にある使い捨てプロジェクトを毎回作る。
// 中身は git HEAD から取り出す — 作業ツリーの sample-project は上記 spec の
// 変換テスト等で一時的に cutData.ts が消えた状態を通過するため、そこからコピーすると
// 壊れた複製を掴む（同じ実測で「カットモデル未確定」バナーを観測）。
function makeDisposableProject(): void {
  rmSync(PROJECT, { recursive: true, force: true });
  const staging = mkdtempSync(join(tmpdir(), 'sme-trash-'));
  try {
    execSync(`git archive HEAD src/server/__fixtures__/sample-project | tar -x -C "${staging}"`, {
      cwd: REPO,
      stdio: 'ignore',
    });
    cpSync(join(staging, 'src/server/__fixtures__/sample-project'), PROJECT, { recursive: true });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// 同一の使い捨てプロジェクト名を使い回すため直列実行。
test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  makeDisposableProject();
});

test.afterEach(() => {
  rmSync(PROJECT, { recursive: true, force: true });
  rmSync(ROOT_TRASH, { recursive: true, force: true });
});

/** 使い捨てプロジェクトをホームから開く（helpers.openEditor の sample-project 版）。 */
async function openProject(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: PROJECT_NAME });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
}

async function openMaterials(page: Page, kind: 'se' | 'image' | 'bgm' | 'video' = 'se'): Promise<void> {
  await openProject(page);
  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator(`.ml-tab[data-kind="${kind}"]`).click();
}

test('素材削除: 使用中素材は使用箇所数つきで警告し、既定ボタンはキャンセル（必須ケース）', async ({ page }) => {
  await openMaterials(page, 'se');
  // beep.mp3 は fixture の seData.ts で1箇所使用中
  const row = page.locator('.ml-row', { hasText: 'beep.mp3' });
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator('.ml-row-delete').click();

  const dialog = page.getByTestId('trash-confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('使われています');
  await expect(dialog).toContainText('1');
  // 既定フォーカスはキャンセル
  await expect(dialog.locator('.hjc-dismiss')).toBeFocused();
  // Enter（既定ボタン）で削除されないこと
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.ml-row', { hasText: 'beep.mp3' })).toBeVisible();
  expect(existsSync(join(PROJECT, 'public', 'se', 'beep.mp3'))).toBe(true);
});

test('素材削除: 未使用素材は通常確認 → ゴミ箱へ移動し一覧から消える', async ({ page }) => {
  writeFileSync(join(PROJECT, 'public', 'se', 'tmp-restore.mp3'), 'dummy', 'utf8');
  await openMaterials(page, 'se');
  const row = page.locator('.ml-row', { hasText: 'tmp-restore.mp3' });
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator('.ml-row-delete').click();

  const dialog = page.getByTestId('trash-confirm-dialog');
  await expect(dialog).toContainText('ゴミ箱へ移動します');
  await dialog.getByTestId('trash-confirm-ok').click();

  await expect(page.locator('.ml-row', { hasText: 'tmp-restore.mp3' })).toHaveCount(0);
  await expect
    .poll(() => existsSync(join(PROJECT, 'public', 'se', 'tmp-restore.mp3')))
    .toBe(false);
  expect(existsSync(join(TRASH, 'trash-manifest.json'))).toBe(true);
});

test('素材削除: 使用中警告（2段目）でも既定フォーカスはキャンセルで、Enter では削除されない', async ({ page }) => {
  writeFileSync(join(PROJECT, 'public', 'se', 'tmp-restore.mp3'), 'dummy', 'utf8');
  // サーバ走査で新たに使用箇所が見つかった状況（409 in-use）を再現する。
  const deleteCalls: string[] = [];
  await page.route('**/api/material*', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback();
      return;
    }
    deleteCalls.push(route.request().url());
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'in-use', count: 2 }),
    });
  });

  await openMaterials(page, 'se');
  const row = page.locator('.ml-row', { hasText: 'tmp-restore.mp3' });
  await row.hover();
  await row.locator('.ml-row-delete').click();

  // 1段目（通常確認）→ 削除を押すと 409 で 2段目（使用中警告）へ昇格する。
  const dialog = page.getByTestId('trash-confirm-dialog');
  await expect(dialog).toContainText('ゴミ箱へ移動します');
  await dialog.getByTestId('trash-confirm-ok').click();
  await expect(dialog).toContainText('2 箇所使われています');

  // 2段目でも既定フォーカスはキャンセル（再マウントされている）。
  await expect(dialog.locator('.hjc-dismiss')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  // force=1 の追い打ち削除が飛んでいないこと（DELETE は1回だけ）。
  expect(deleteCalls).toHaveLength(1);
  expect(existsSync(join(PROJECT, 'public', 'se', 'tmp-restore.mp3'))).toBe(true);
});

test('ゴミ箱: 「空にする」で全件が実体ごと消える', async ({ page }) => {
  writeFileSync(join(PROJECT, 'public', 'se', 'tmp-a.mp3'), 'a', 'utf8');
  writeFileSync(join(PROJECT, 'public', 'se', 'tmp-b.mp3'), 'b', 'utf8');
  await openMaterials(page, 'se');
  for (const name of ['tmp-a.mp3', 'tmp-b.mp3']) {
    const row = page.locator('.ml-row', { hasText: name });
    await row.hover();
    await row.locator('.ml-row-delete').click();
    await page.getByTestId('trash-confirm-dialog').getByTestId('trash-confirm-ok').click();
    await expect(page.locator('.ml-row', { hasText: name })).toHaveCount(0);
  }

  await page.locator('.ml-trash-open').click();
  const dialog = page.getByTestId('trash-dialog');
  await expect(dialog.locator('.trash-item')).toHaveCount(2);
  await dialog.locator('.trash-empty-all').click();
  const confirm = page.getByTestId('trash-confirm-dialog');
  await expect(confirm).toContainText('元に戻せません');
  await confirm.getByTestId('trash-confirm-ok').click();

  await expect(dialog.locator('.trash-item')).toHaveCount(0);
  // tombstone（実体）も残らない
  await expect
    .poll(() => readdirSync(TRASH).filter((n) => !n.startsWith('trash-manifest')).length)
    .toBe(0);
});

test('ゴミ箱: 復元で元パスに元通り・完全削除で消える（必須ケース）', async ({ page }) => {
  writeFileSync(join(PROJECT, 'public', 'se', 'tmp-restore.mp3'), 'dummy', 'utf8');
  await openMaterials(page, 'se');

  // 削除 → ゴミ箱へ
  const row = page.locator('.ml-row', { hasText: 'tmp-restore.mp3' });
  await row.hover();
  await row.locator('.ml-row-delete').click();
  await page.getByTestId('trash-confirm-dialog').getByTestId('trash-confirm-ok').click();
  await expect(page.locator('.ml-row', { hasText: 'tmp-restore.mp3' })).toHaveCount(0);

  // ゴミ箱を開いて復元
  await page.locator('.ml-trash-open').click();
  const dialog = page.getByTestId('trash-dialog');
  await expect(dialog).toBeVisible();
  const item = dialog.locator('.trash-item', { hasText: 'tmp-restore.mp3' });
  await expect(item).toBeVisible();
  await item.locator('.trash-restore').click();
  await expect(dialog.locator('.trash-item', { hasText: 'tmp-restore.mp3' })).toHaveCount(0);
  await dialog.locator('.export-cancel').click();

  // 元パスへ戻り、一覧にも復帰する
  await expect
    .poll(() => existsSync(join(PROJECT, 'public', 'se', 'tmp-restore.mp3')))
    .toBe(true);
  await expect(page.locator('.ml-row', { hasText: 'tmp-restore.mp3' })).toBeVisible({ timeout: 10_000 });
});

test('ゴミ箱: 完全削除は確認（既定キャンセル）を経て実体ごと消える', async ({ page }) => {
  writeFileSync(join(PROJECT, 'public', 'se', 'tmp-restore.mp3'), 'dummy', 'utf8');
  await openMaterials(page, 'se');
  const row = page.locator('.ml-row', { hasText: 'tmp-restore.mp3' });
  await row.hover();
  await row.locator('.ml-row-delete').click();
  await page.getByTestId('trash-confirm-dialog').getByTestId('trash-confirm-ok').click();

  await page.locator('.ml-trash-open').click();
  const dialog = page.getByTestId('trash-dialog');
  await dialog.locator('.trash-item', { hasText: 'tmp-restore.mp3' }).locator('.trash-purge').click();
  const confirm = page.getByTestId('trash-confirm-dialog');
  await expect(confirm).toContainText('元に戻せません');
  await confirm.getByTestId('trash-confirm-ok').click();
  await expect(dialog.locator('.trash-item', { hasText: 'tmp-restore.mp3' })).toHaveCount(0);
});

test('プロジェクト削除: カードメニューからゴミ箱へ移動 → ルートのゴミ箱から復元できる', async ({ page }) => {
  // ゴミ箱カードのサムネイル配信（GET /api/trash/video）が実際に飛ぶことを見る。
  const thumbRequests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/trash/video')) thumbRequests.push(r.url());
  });
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: PROJECT_NAME });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // バッジメニュー → ゴミ箱へ移動 → 確認（既定キャンセルの検証は素材側で済み。ここは confirm）
  await card.locator('.status-badge').click();
  await card.locator('.home-badge-menu').getByRole('menuitem', { name: 'ゴミ箱へ移動' }).click();
  const confirm = page.getByTestId('trash-confirm-dialog');
  await expect(confirm).toContainText(PROJECT_NAME);
  await confirm.getByTestId('trash-confirm-ok').click();

  // カードが消え、ルートの .trash に tombstone がある
  await expect(page.locator('.home-card', { hasText: PROJECT_NAME })).toHaveCount(0);
  await expect.poll(() => existsSync(join(ROOT_TRASH, 'trash-manifest.json'))).toBe(true);
  expect(existsSync(PROJECT)).toBe(false);

  // ホームのゴミ箱ビュー（全画面）から復元 → 「戻る」でホームへ
  await page.locator('.home-trash-open').click();
  const view = page.getByTestId('trash-view');
  await expect(view).toBeVisible();

  // サムネイル枠がホームカードと同じ実寸（16:9）で出ること。空 div ではなく
  // 実際に箱を持っていることを boundingBox で確かめる。
  const trashCard = view.locator('.trash-card', { hasText: PROJECT_NAME });
  const thumb = trashCard.locator('.home-card-thumb');
  await expect(thumb).toBeVisible();
  const box = await thumb.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(80);
  expect(box!.height).toBeGreaterThan(40);
  // 16:9 枠（誤差 2px）。ホームカードと同じ意匠であることの機械判定。
  expect(Math.abs(box!.width / box!.height - 16 / 9)).toBeLessThan(0.05);
  // 配信は entryId だけで呼ぶ（パスを送らない）。
  await expect.poll(() => thumbRequests.length).toBeGreaterThan(0);
  expect(thumbRequests[0]).toMatch(
    /\/api\/trash\/video\?entryId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

  await trashCard.locator('.trash-restore').click();
  await view.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('.home-card', { hasText: PROJECT_NAME })).toBeVisible({ timeout: 10_000 });
  expect(existsSync(PROJECT)).toBe(true);
});
