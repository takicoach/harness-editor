import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// 書き出しボタンの e2e。webServer は SME_RENDER_MOCK=1（実プロセス非起動）で起動しており、
// mock は SME_RENDER_MOCK_DELAY_MS=4000 の間に 25%→50%→75%→100% を 1s 刻みで emit する。
// 失敗シナリオだけは server 全体で有効化される SME_RENDER_MOCK_FAIL を使わず、
// convert 失敗テストと同じ page.route 流儀で POST /api/render を 500 に差し替えて再現する
// （webServer が単一インスタンスのため、失敗モードを 1 テストだけに閉じ込められない）。

const FIXTURE_DIR = resolve(import.meta.dirname, '../src/server/__fixtures__/sample-project');

// render ジョブマネージャは server 側シングルトンのため、テストが完了前に終わると
// 走りっぱなしのジョブが同 projectId で残り、次テストが done/running を拾ってしまう。
// 各テスト後に DELETE で残ジョブを破棄する（smoke の transcribe クリーンアップと同型）。
test.afterEach(async ({ request }) => {
  await request.delete('/api/render?id=sample-project').catch(() => {});
});

// 自動保存シナリオはフィクスチャを書き換えるため、pristine へ戻す。
test.afterEach(() => {
  try {
    execSync(`git checkout -- "${FIXTURE_DIR}"`, { stdio: 'ignore' });
    execSync(`git clean -fdx "${FIXTURE_DIR}"`, { stdio: 'ignore' });
  } catch {
    // git 管理外環境（CI キャッシュなど）では無視する
  }
});

/** プロジェクトを開いてプレビューがマウントされるまで待つ共通ヘルパ。 */
async function openSampleProject(page: import('@playwright/test').Page) {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
}

/** 書き出しボタン → プリセットダイアログ → 開始、まで進める共通ヘルパ。 */
async function startExport(page: import('@playwright/test').Page) {
  await page.locator('.tb-render-btn').click();
  const dialog = page.locator('[data-testid="export-dialog"]');
  await expect(dialog).toBeVisible();
  await page.locator('[data-testid="export-start"]').click();
  await expect(dialog).toHaveCount(0);
}

test('書き出しボタンで進捗が進み、完了すると Finder 表示ボタンが出る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openSampleProject(page);

  // idle: 書き出しボタンが有効。
  await expect(page.locator('.tb-render-btn')).toBeVisible();
  await startExport(page);

  // running: 実行中グループが出る。
  const running = page.locator('.tb-render-running');
  await expect(running).toBeVisible();

  // 進捗％が表示される（mock は 1s 刻みで 25%→…）。percent 確定でリング中央に「N%」が出る。
  await expect(page.locator('.tb-render-running .tb-render-ring-wrap')).toBeVisible({
    timeout: 8_000,
  });
  await expect(page.locator('.tb-render-running .tb-render-ring-pct')).toContainText(/\d+%/, {
    timeout: 8_000,
  });
  // ラベルは省略されず（「書き出…」と切れない）フルテキストで出る。
  const ringLabel = page.locator('.tb-render-running .tb-render-ring-label');
  await expect(ringLabel).toContainText(/書き出し中|準備中|バンドル中|仕上げ中/, {
    timeout: 8_000,
  });
  // 実寸ゲート: 表示幅に収まっている（＝ellipsis で切れていない）ことをピクセルで確認する。
  // 文字列の存在だけでは CSS の省略表示を検出できない（本改修の元バグがまさにそれ）。
  const overflow = await ringLabel.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);

  // 完了: 「✅ 完了」＋「Finderで表示」ボタンが出る（クリックはしない＝Finder は e2e 検証不能）。
  await expect(page.locator('.tb-render-done')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.tb-render-done .tb-render-label')).toContainText('完了');
  await expect(page.locator('.tb-render-reveal')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('書き出し実行中にキャンセルすると idle（書き出しボタン）へ戻る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openSampleProject(page);

  await startExport(page);
  const running = page.locator('.tb-render-running');
  await expect(running).toBeVisible();

  // 実行中（完了は 4s 後）に × でキャンセル。
  await page.locator('.tb-render-running .tb-render-x').click();

  // idle へ戻る（書き出しボタンが再び出て、実行中グループは消える）。
  await expect(page.locator('.tb-render-btn')).toBeVisible({ timeout: 10_000 });
  await expect(running).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('未保存の変更があると書き出しは自動保存してから開始する', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openSampleProject(page);

  // テロップを編集して dirty 化する。
  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  const editor = page.locator('.tx-row.selected .tx-text-edit');
  await expect(editor).toBeVisible();
  await editor.fill('書き出し自動保存テスト');
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 書き出し（ダイアログ経由）→ まず保存が走って dirty が消える（保存成功後に render 開始）。
  await startExport(page);
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // 保存後に render が開始している（実行中グループが出る）。
  await expect(page.locator('.tb-render-running')).toBeVisible({ timeout: 10_000 });

  expect(pageErrors).toEqual([]);
});

test('書き出しが失敗するとエラー表示が出て閉じられる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  // POST /api/render を 500 に差し替える（SSE の GET / DELETE は素通し）。
  await page.route('**/api/render?*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'render-failed' }),
      });
      return;
    }
    await route.continue();
  });

  await openSampleProject(page);

  await startExport(page);

  // エラー表示（「書き出し失敗」）が出る。
  const errorBox = page.locator('.tb-render-error');
  await expect(errorBox).toBeVisible({ timeout: 10_000 });
  await expect(errorBox.locator('.tb-render-label')).toContainText('書き出し失敗');

  // × で閉じると idle（書き出しボタン）へ戻る。
  await errorBox.locator('.tb-render-x').click();
  await expect(page.locator('.tb-render-btn')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('軽量プリセットを選ぶと POST body に 720p/light が載り、選択が記憶される', async ({ page }) => {
  await openSampleProject(page);

  await page.locator('.tb-render-btn').click();
  const dialog = page.locator('[data-testid="export-dialog"]');
  await expect(dialog).toBeVisible();

  // 3番目のプリセット＝軽量・確認用（720p）を選択。
  await dialog.locator('.export-preset', { hasText: '軽量' }).click();

  const reqPromise = page.waitForRequest(
    (req) => req.url().includes('/api/render') && req.method() === 'POST',
  );
  await page.locator('[data-testid="export-start"]').click();
  const req = await reqPromise;
  expect(req.postDataJSON()).toEqual({ resolution: '720p', quality: 'light' });

  await expect(page.locator('.tb-render-running')).toBeVisible();

  // localStorage に記憶され、次回ダイアログの初期選択になる。
  const stored = await page.evaluate(() => localStorage.getItem('sme:render-preset'));
  expect(JSON.parse(stored!)).toEqual({ resolution: '720p', quality: 'light' });
});
