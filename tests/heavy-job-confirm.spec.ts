import { test, expect } from '@playwright/test';
import { cancelRenderJob, openEditor, useTempProject } from './helpers';

// 重ジョブ負荷確認ダイアログ（HeavyJobConfirmDialog）の e2e。
//
// webServer は playwright.config.ts の共有インスタンス（複数 spec が並列に使う）のため、
// 実際に SME_MAX_HEAVY_JOBS=1 で「本当に重ジョブを1本走らせて2本目を試す」形にすると、
// 他 spec が並列実行中に走らせている別種の重ジョブ（denoise/normalize/transcribe 等）と
// 干渉してグローバルな同時実行数が偶発的にしきい値へ達し、無関係な spec がフレークする
// リスクがある（activeCount はプロジェクト非依存でサーバ全体シングルトン）。
// そのため render-button.spec.ts の失敗注入と同じ流儀（page.route で POST /api/render を
// 差し替え）で、サーバの 409 confirmation-required 応答を決定的に再現する。
// これにより「サーバが 409 confirmationRequired を返す→クライアントがダイアログを出す→
// force=1 で再送する／中止する」という Task 5 のクライアント側契約を、他 spec に影響を
// 与えず検証できる。

// 共有 sample-project は smoke.spec.ts の afterEach（git checkout / git clean）が
// 実行中ずっと書き換え続けるため、その窓に重なって開くと壊れた状態を読む
// （実測: 「[telopData.ts] telopData 配列が見つかりません」で editor が止まる）。
// 専用コピーへ隔離する（helpers.ts の useTempProject）。
const projectId = useTempProject('heavy-job-tmp');

test.afterEach(async ({ request }) => {
  // render ジョブマネージャは server 側シングルトン。テスト完了前に残ると
  // 次テストが running/done を拾ってしまうため、残ジョブを破棄する
  // （render-button.spec.ts と同型のクリーンアップ）。
  // 1 回投げるだけだと、まだジョブ登録が済んでいない瞬間の DELETE が 404 で捨てられ、
  // 直後に登録されたジョブが止まらないまま走り続ける（残骸が間欠的に出る原因）。
  // 登録が済むまで短く送り直す。
  await cancelRenderJob(request, projectId());
});

/** 書き出しボタン → プリセットダイアログ → 開始、まで進める共通ヘルパ（render-button.spec.ts と同型）。 */
async function startExport(page: import('@playwright/test').Page) {
  await page.locator('.tb-render-btn').click();
  const dialog = page.locator('[data-testid="export-dialog"]');
  await expect(dialog).toBeVisible();
  await page.locator('[data-testid="export-start"]').click();
  await expect(dialog).toHaveCount(0);
}

/**
 * POST /api/render を差し替える: force=1 が付いていない最初のリクエストは
 * 409 confirmation-required（サーバの実応答形と同じ）を返し、force=1 付きの
 * 再送は実サーバへ通す（route.continue）。SSE の GET / DELETE は素通し。
 */
async function mockConfirmationRequired(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/render?*', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') {
      await route.continue();
      return;
    }
    const url = new URL(req.url());
    if (url.searchParams.get('force') === '1') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'confirmation-required',
        confirmationRequired: true,
        running: 1,
        recommendedMax: 1,
      }),
    });
  });
}

test('render 実行中に見立てた409で確認ダイアログが表示され、[やめておく]で開始されない', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await mockConfirmationRequired(page);
  await openEditor(page, projectId());

  await startExport(page);

  // ダイアログの文言・running 本数（◯=1）が表示される。
  const dialog = page.locator('[data-testid="heavy-job-confirm-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('現在1本の重い処理が実行中です');
  await expect(dialog).toContainText('メモリ/CPU 不足でパソコン全体が極端に遅くなる恐れがあります');

  // [やめておく] → ダイアログが消え、書き出しボタンへ戻る（実際にジョブは開始されず、
  // 実行中グループは出ない＝再送されなかったことの確認）。
  await dialog.locator('button', { hasText: 'やめておく' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.tb-render-btn')).toBeVisible();
  await expect(page.locator('.tb-render-running')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('[それでも実行] で force=1 付き再送により書き出しが開始される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await mockConfirmationRequired(page);
  await openEditor(page, projectId());

  await startExport(page);

  const dialog = page.locator('[data-testid="heavy-job-confirm-dialog"]');
  await expect(dialog).toBeVisible();

  const forcedReqPromise = page.waitForRequest(
    (req) =>
      req.url().includes('/api/render') &&
      req.method() === 'POST' &&
      req.url().includes('force=1'),
  );

  // [それでも実行] → force=1 付きで再送 → 実サーバ（SME_RENDER_MOCK）が受理し実行中になる。
  await dialog.locator('button', { hasText: 'それでも実行' }).click();
  const forcedReq = await forcedReqPromise;
  expect(forcedReq.url()).toContain('force=1');

  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.tb-render-running')).toBeVisible({ timeout: 10_000 });

  expect(pageErrors).toEqual([]);
});
