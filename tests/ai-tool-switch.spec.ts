/**
 * AI タブのツール切替の e2e。
 *
 * hermetic 性の設計（レビュー Important 1 対応）:
 * - 「使えるツール一覧」（`.clt-tools` の表示可否・ラベル）は `GET /api/ai/tools` の
 *   `installed`/`versionOk` で決まり、これは `findTool`（`which codex` によるグローバル
 *   検出）に依存する。**`SME_CLAUDE_BIN`/`SME_CODEX_BIN` はこの一覧取得には一切効かず、
 *   pty の spawn 経路（`resolveToolForPty`）にしか効かない。** そのため codex が実行機に
 *   グローバル導入されていない環境（オーナーの Windows 検証機・OSS の新規 clone・将来の CI）
 *   では、一覧を素通しにするテストは「2つ使える」状態に到達できず timeout で赤くなる。
 * - これを避けるため、2ツールとも使える前提のテストは `stubTwoToolsInstalled()` で
 *   `/api/ai/tools` の応答を `installed:true, versionOk:true` に固定注入する
 *   （`route.fetch()` で実応答を取ってから `tools` だけ上書き）。
 * - 一方、**切替そのもの（`POST /api/pty/switch` → pty の実 spawn）は差し替えていない。**
 *   `playwright.config.ts` の `SME_CLAUDE_BIN`/`SME_CODEX_BIN` が指す
 *   `tests/fixtures/fake-{claude,codex}.mjs` を実際に spawn する経路（`resolveToolForPty`）を
 *   通るため、実挙動の検証力はこの注入で落ちない。
 * - 「使えるツールが1つ」のケースは逆に `/api/ai/tools` の `tools` を `claude` だけへ絞る
 *   （webServer の env は全テスト共通で変えられないため、テストごとに route で応答を作る）。
 *
 * 注入は必ず `page.goto()` より前に `page.route()` を設定すること（後だと初回フェッチを
 * 取り逃す）。
 */
import { test, expect, type Page } from '@playwright/test';

// pty セッションは server 側シングルトン（エディタ全体で1本）のため、このファイルの
// テストが Codex へ実際に切り替えたまま終わると、後続テスト（このファイル内・他ファイル
// 問わず claude 前提の e2e）が Codex の状態を拾ってしまう（render-button.spec.ts の
// render ジョブ残骸クリーンアップと同型の問題）。各テスト後に claude へ強制的に戻す。
//
// Minor 1: request.post は 4xx/5xx でも throw しない。以前はここを `.catch(() => {})` で
// 握り潰しており、後始末（switchTool）が 409 等で失敗していても誰にも気づかれなかった
// （codex が残ったまま次テストへ進む）。ok() を明示的に検証し、後始末が効いている証跡にする。
test.afterEach(async ({ request }) => {
  const res = await request.post('/api/pty/switch', { data: { tool: 'claude', theme: 'dark' } });
  expect(res.ok()).toBeTruthy();
});

/**
 * `/api/ai/tools` の応答で claude・codex を両方 `installed:true, versionOk:true` に固定する。
 * 実行機に codex がグローバル導入されているかに関わらず「2つ使える」状態の描画経路を
 * 検証できるようにする（ヘッダ Important 1 コメント参照）。必ず `page.goto()` より前に呼ぶこと。
 */
async function stubTwoToolsInstalled(page: Page): Promise<void> {
  await page.route('**/api/ai/tools', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({
      json: {
        ...body,
        tools: (body.tools as { id: string }[]).map((t) =>
          t.id === 'claude' || t.id === 'codex' ? { ...t, installed: true, versionOk: true } : t,
        ),
      },
    });
  });
}

test.describe('AI タブのツール切替', () => {
  test('使えるツールが1つなら切替行が出ない（利用者の画面が変わっていない）', async ({ page }) => {
    await page.route('**/api/ai/tools', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        json: {
          ...body,
          tools: body.tools.filter((t: { id: string }) => t.id === 'claude'),
        },
      });
    });
    await page.goto('/');
    await page.locator('.home-card', { hasText: 'sample-project' }).click();
    await expect(page.locator('.pv-stage')).toBeVisible();
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    const term = page.getByTestId('claude-terminal');
    await expect(term).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.clt-tools')).toHaveCount(0);
    // Minor 4: 切替行が無いことに加え、端末が実際に claude（フィクスチャ）で起動できている
    // ことまで確認する。「利用者の画面が変わっていない」＝端末は従来どおり動く、を押さえる。
    await expect(term).toContainText('FAKE-CLAUDE', { timeout: 15_000 });
  });

  test('2つ使えるとき切替行が出て、押すと確認が出る', async ({ page }) => {
    await stubTwoToolsInstalled(page);
    await page.goto('/');
    await page.locator('.home-card', { hasText: 'sample-project' }).click();
    await expect(page.locator('.pv-stage')).toBeVisible();
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    const tools = page.locator('.clt-tools');
    await expect(tools).toBeVisible({ timeout: 15_000 });
    await expect(tools.getByRole('radio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');

    page.once('dialog', (d) => {
      expect(d.message()).toContain('実行中の編集は中断され');
      void d.accept();
    });
    await tools.getByRole('radio', { name: 'Codex' }).click();
    await expect(tools.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  });

  test('切替後に旧ツールの出力が端末に残らない', async ({ page }) => {
    await stubTwoToolsInstalled(page);
    await page.goto('/');
    await page.locator('.home-card', { hasText: 'sample-project' }).click();
    await expect(page.locator('.pv-stage')).toBeVisible();
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    const term = page.getByTestId('claude-terminal');
    await expect(term).toContainText('FAKE-CLAUDE', { timeout: 15_000 });
    page.once('dialog', (d) => void d.accept());
    await page.locator('.clt-tools').getByRole('radio', { name: 'Codex' }).click();
    await expect(term).toContainText('FAKE-CODEX', { timeout: 15_000 });
    await expect(term).not.toContainText('FAKE-CLAUDE');
  });

  test('確認を断ると切り替わらない', async ({ page }) => {
    await stubTwoToolsInstalled(page);
    await page.goto('/');
    await page.locator('.home-card', { hasText: 'sample-project' }).click();
    await expect(page.locator('.pv-stage')).toBeVisible();
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    await expect(page.locator('.clt-tools')).toBeVisible({ timeout: 15_000 });
    page.once('dialog', (d) => void d.dismiss());
    await page.locator('.clt-tools').getByRole('radio', { name: 'Codex' }).click();
    await expect(page.locator('.clt-tools').getByRole('radio', { name: 'Claude' }))
      .toHaveAttribute('aria-checked', 'true');
  });

  test('別セッションでツール切替が起きると、この接続へ stale 通知が届く（sessionId 束縛の検証）', async ({ page, request }) => {
    await page.goto('/');
    await page.locator('.home-card', { hasText: 'sample-project' }).click();
    await expect(page.locator('.pv-stage')).toBeVisible();
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    await expect(page.getByTestId('claude-terminal')).toBeVisible({ timeout: 15_000 });

    // レビュー Important 2: 「別タブで切り替える」をブラウザで2枚目のページを開いて模すと、
    // 2枚目が開いた時点で AiTerminal が自動で /api/pty/ensure → WS 接続まで進み、
    // *この*（1枚目の）接続の writer を奪って takeover 経路に落ちる。takeover と stale は
    // 別のボタン文言判定（/開き直す|もう一度接続/）に同じくマッチしてしまうため、2枚目を
    // 開くだけで stale 機構を検証したことにならない恒真アサーションになっていた。
    // → 2枚目のページを開かず、このページを writer に保ったまま request.post で
    //   /api/pty/switch を直接叩く。ptySession.switchTool() は invalidateWriter() を
    //   真っ先に呼ぶため、これが「今の writer（＝このページ）」に {type:'stale'} を送る
    //   経路を正しく通す（ptyApi.ts の invalidateWriter/attachWriter コメント参照）。
    const res = await request.post('/api/pty/switch', { data: { tool: 'codex', theme: 'dark' } });
    expect(res.ok()).toBeTruthy();

    // takeover と stale は原因が違う（AiTerminal.tsx の takeoverReason）ため、ボタンの有無
    // だけでなく stale 専用の文言で判定する。ここを takeover と同じボタン判定だけに戻すと、
    // stale 送信（ptyApi.ts の `ws.send(JSON.stringify({ type: 'stale' }))`）を丸ごと消しても
    // このテストは落ちなくなる（恒真化の再発）。
    await expect(page.locator('.clt-exit')).toContainText(
      '別のタブで AI ツールが切り替えられたため、この接続は無効になりました。',
      { timeout: 15_000 },
    );
    await expect(page.getByRole('button', { name: /開き直す|もう一度接続/ })).toBeVisible();
  });

  test('Codex を選ぶと日本語の案内が出る', async ({ page }) => {
    await stubTwoToolsInstalled(page);
    await page.goto('/');
    await page.locator('.home-card', { hasText: 'sample-project' }).click();
    await expect(page.locator('.pv-stage')).toBeVisible();
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    await expect(page.locator('.clt-tools')).toBeVisible({ timeout: 15_000 });
    page.once('dialog', (d) => void d.accept());
    await page.locator('.clt-tools').getByRole('radio', { name: 'Codex' }).click();
    // Minor 2: codex 選択時の固定案内（.clt-note）と notes[] 由来の警告（.clt-note.clt-note-warn）
    // は同じベースクラスを共有する。`~/.codex` が無い実行機では警告 note も同時に出て要素が
    // 2つになり、`.clt-note` 単体だと strict mode 違反で落ちる。警告を除外して絞り込む。
    await expect(page.locator('.clt-note:not(.clt-note-warn)')).toContainText('Enter を押せば進めます', {
      timeout: 15_000,
    });
  });
});
