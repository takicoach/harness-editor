import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * フィクスチャプロジェクト（sample-project）の `.sme/status.json` パス。
 * dev サーバーは playwright.config.ts の HARNESS_PROJECT_ROOT で
 * src/server/__fixtures__ を指すため、このパスで直接読み書きできる。
 */
const STATUS_FILE = join(
  import.meta.dirname,
  '..',
  'src/server/__fixtures__/sample-project/.sme/status.json',
);

// このファイル内のテストは共有フィクスチャの .sme/status.json を書き換えるため、
// 並列実行時の衝突を避けて直列に走らせる。
test.describe.configure({ mode: 'serial' });

test.afterEach(() => {
  // コミット禁止のためテスト内で作成した status.json は必ず削除する。
  // fixture のコミットは行わない方式（既知の並列フレーク対策と同じ理由でここも最小限に）。
  if (existsSync(STATUS_FILE)) rmSync(STATUS_FILE);
});

test('ホーム: プロジェクトカードが並び、ステータスバッジが表示される', async ({ page }) => {
  await page.goto('/');

  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // バッジが表示され、既知のステータスラベルのいずれかを示す
  const badge = card.locator('.status-badge');
  await expect(badge).toBeVisible();
  await expect(badge.locator('.status-badge-label')).toHaveText(/未着手|編集中|書き出し済|レビュー待ち|公開済/);
});

test('ホーム: バッジメニューでレビュー待ちに変更→status.json 書き込み→自動判定に戻す', async ({ page }) => {
  await page.goto('/');

  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  const badge = card.locator('.status-badge');
  await badge.click();

  const menu = card.locator('.home-badge-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'レビュー待ちにする' }).click();

  // 楽観更新でバッジ表示がすぐ変わる
  await expect(badge.locator('.status-badge-label')).toHaveText('レビュー待ち');

  // サーバーが .sme/status.json に stage を書き込んでいる
  await expect
    .poll(() => (existsSync(STATUS_FILE) ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as { stage?: string }).stage : undefined))
    .toBe('review');

  // 自動判定に戻す
  await badge.click();
  const menu2 = card.locator('.home-badge-menu');
  await expect(menu2).toBeVisible();
  await menu2.getByRole('menuitem', { name: '自動判定に戻す' }).click();

  await expect
    .poll(() => (existsSync(STATUS_FILE) ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as { stage?: string | null }).stage : undefined))
    .toBe(null);
});

test('ホーム: カンバン5列が並び、タイムライン・右ドックは非表示（プロジェクトを開くと復帰）', async ({ page }) => {
  await page.goto('/');

  // 既定はパネルビューなのでカンバンへ切り替える
  await page.locator('.home-view-btn', { hasText: '進行ボード' }).click({ timeout: 15_000 });

  // 5列がフロー順に出る
  const cols = page.locator('.home-col');
  await expect(cols).toHaveCount(5, { timeout: 15_000 });
  await expect(page.locator('.home-col-label')).toHaveText(['未着手', '編集中', '書き出し済', 'レビュー待ち', '公開済']);

  // ホームではタイムラインと右ドック（Claude 指示欄）が消えている
  await expect(page.locator('.tl')).toBeHidden();
  await expect(page.locator('.rightdock, .cl')).toBeHidden();

  // カードはいずれかの列の中にいる
  const card = page.locator('.home-col .home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible();

  // バッジをレビュー待ちへ変更 → カードがレビュー待ち列へ移動する
  await card.locator('.status-badge').click();
  await card.locator('.home-badge-menu').getByRole('menuitem', { name: 'レビュー待ちにする' }).click();
  await expect(
    page.locator('.home-col[data-status="review"] .home-card', { hasText: 'sample-project' }),
  ).toBeVisible();

  // プロジェクトを開くとタイムラインが戻る
  await card.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.tl')).toBeVisible();
});

test('ホーム: パネル/カンバンのビュー切替が動き、リロード後も保持される', async ({ page }) => {
  await page.goto('/');

  // 既定はパネルビュー（Notion 風ギャラリー）
  await expect(page.locator('.home-grid')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.home-kanban')).toHaveCount(0);
  await expect(page.locator('.home-grid .home-card', { hasText: 'sample-project' })).toBeVisible();

  // カンバンへ切替
  await page.locator('.home-view-btn', { hasText: '進行ボード' }).click();
  await expect(page.locator('.home-kanban')).toBeVisible();
  await expect(page.locator('.home-grid')).toHaveCount(0);
  await expect(page.locator('.home-col')).toHaveCount(5);

  // リロードしてもカンバンのまま（localStorage 永続）
  await page.reload();
  await expect(page.locator('.home-kanban')).toBeVisible({ timeout: 15_000 });

  // パネルへ戻す
  await page.locator('.home-view-btn', { hasText: '一覧' }).click();
  await expect(page.locator('.home-grid')).toBeVisible();
});

test('サイドバー: 編集中に activity が書かれると「作業中」表示がライブで出て、消すと戻る', async ({ page }) => {
  // 共有 fixture（sample-project）の .sme を書くと、並列中の他テストが開いている
  // 同プロジェクトに外部更新イベントが飛んで干渉する。専用コピーへ隔離する。
  const projectId = `status-live-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const projectDir = join(import.meta.dirname, '..', 'src/server/__fixtures__', projectId);
  const statusFile = join(projectDir, '.sme', 'status.json');
  cpSync(join(dirname(STATUS_FILE), '..'), projectDir, { recursive: true });
  rmSync(join(projectDir, '.sme'), { recursive: true, force: true });
  try {
    await page.goto('/');

    // 隔離プロジェクトを開く（編集画面 = サイドバー表示状態）
    await page.locator('.home-card', { hasText: projectId }).click({ timeout: 15_000 });
    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

    const item = page.locator('.fb-item', { hasText: projectId });
    await expect(item).toBeVisible();
    await expect(item).not.toHaveClass(/fb-working/);

    // 別プロセス（スキル）を模して .sme/status.json に activity を書く → SSE で反映
    mkdirSync(dirname(statusFile), { recursive: true });
    writeFileSync(
      statusFile,
      JSON.stringify({ activity: { label: 'カット中', startedAt: new Date().toISOString() } }),
    );
    await expect(item).toHaveClass(/fb-working/, { timeout: 15_000 });
    await expect(item.locator('.fb-activity')).toHaveText(/カット中/);
    await expect(item.locator('.fb-activity .status-spinner')).toBeVisible();

    // activity を消す → 強調が外れる
    writeFileSync(statusFile, JSON.stringify({}));
    await expect(item).not.toHaveClass(/fb-working/, { timeout: 15_000 });
    await expect(item.locator('.fb-activity')).toHaveCount(0);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
