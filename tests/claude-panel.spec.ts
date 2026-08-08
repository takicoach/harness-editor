import { test, expect } from '@playwright/test';

// feat/simplified-ai-tab: 在席2段表示・指示履歴・入力欄・送信を検証していた4テスト
// （指示送信の文脈POST・未接続時の入力欄・接続中の案内文・在席2段表示・詰まった
// processing の打ち切り）は、対象 UI ごと撤去したため削除した（.sdd/simplified-ai-tab-report.md
// に削除一覧と理由）。サーバー側（受け箱・/api/instructions・/api/agent-status・MCP）は
// 無変更・無テスト削除。代わりに「AI タブを開くとターミナルだけが出る」を新設する。

test('右ドック: 隠すボタンで折りたたみ、再度開ける', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage')).toBeVisible();
  await expect(page.locator('.rightdock-tabs')).toBeVisible();
  // 隠す
  await page.locator('.rightdock-collapse').click();
  await expect(page.locator('html')).toHaveAttribute('data-claude', 'closed');
  await expect(page.locator('.rightdock-tabs')).toHaveCount(0);
  await expect(page.locator('.rightdock-collapsed')).toBeVisible();
  // 開く
  await page.locator('.rightdock-expand').click();
  await expect(page.locator('html')).toHaveAttribute('data-claude', 'open');
  await expect(page.locator('.rightdock-tabs')).toBeVisible();
});

test('AI タブ: ターミナルだけが表示され、旧・指示欄や在席表示は無い（簡素化の回帰ガード）', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage')).toBeVisible();
  await page.locator('.rightdock-tab[data-tab="ai"]').click();

  // AiTerminal のコンテナ（.clt）はどの phase でも即描画される（導入状態を問わない安定セレクタ）。
  await expect(page.locator('.rightdock-body .clt')).toBeVisible({ timeout: 10_000 });

  // 撤去したはずの旧 UI が復活していないことを確認する。
  await expect(page.locator('.cl-agent-status')).toHaveCount(0);
  await expect(page.locator('.cl-history')).toHaveCount(0);
  await expect(page.locator('.cl-input')).toHaveCount(0);
  await expect(page.locator('.cl-textarea')).toHaveCount(0);
  await expect(page.locator('.cl-term-head')).toHaveCount(0);
});
