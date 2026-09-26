import { test, expect } from '@playwright/test';
import { useTempProject } from './helpers';

// feat/simplified-ai-tab: 在席2段表示・指示履歴・入力欄・送信を検証していた4テスト
// （指示送信の文脈POST・未接続時の入力欄・接続中の案内文・在席2段表示・詰まった
// processing の打ち切り）は、対象 UI ごと撤去したため削除した。
// サーバー側（受け箱・/api/instructions・/api/agent-status・MCP）は
// 無変更・無テスト削除。代わりに「AI タブを開くとターミナルだけが出る」を新設する。

// 共有 sample-project は smoke.spec.ts の afterEach（git checkout / git clean）が
// 実行中ずっと書き換え続けるため、その窓に重なって開くと壊れた状態を読む
// （実測: 「[telopData.ts] telopData 配列が見つかりません」で editor が止まる）。
// 専用コピーへ隔離する（helpers.ts の useTempProject）。
const projectId = useTempProject('claude-panel-tmp');

test('右ドック: 隠すボタンで折りたたみ、再度開ける', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: projectId() }).click();
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
  await page.locator('.home-card', { hasText: projectId() }).click();
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

  // smoke.spec.ts「右ドック: BGM選択で…」から移設（元は AI タブ内で検証していた）。
  // pty は server 側グローバルシングルトンのため、AI タブを開く spec は必ずこの
  // ai-tab-pty project（playwright.config.ts・workers:1）に置く。smoke.spec.ts は
  // default project で複数 worker 並列実行されるため、そこに置いたままだと
  // claude-terminal.spec.ts の C-1 回帰テストと writer（書き込み接続）を奪い合い、
  // 「別タブで開かれました」takeover の一瞬の遷移中に xterm の描画が入れ替わり、
  // 直前の scrollback と新しい入力エコーが混線して見える形でフレークしていた
  // （実測: フルスイート時のみ・単独/この2ファイルの組でも再現せず＝多 worker 負荷依存）。
  await expect(page.locator('.rightdock-body .clt')).toBeVisible();
  // 縦動画(sample-project=縦)では右ドックを広めに（>=400px）。
  const w = await page.locator('.rightdock').evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThanOrEqual(400);
});
