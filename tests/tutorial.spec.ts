import { test, expect } from '@playwright/test';
import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const FIXTURES_ROOT = resolve(import.meta.dirname, '../src/server/__fixtures__');
const SAMPLE_DIR = resolve(FIXTURES_ROOT, 'sample-project');

// エディタ操作テストはテロップ追加＋保存で fixture を書き換えるため、sample-project を
// 他 spec と取り合わないよう専用コピーへ隔離する（learning-diff.spec と同じ作法・
// フルラン並列時の保存衝突フレーク対策）。prefix tutorial-tmp は .gitignore 済み。
let projectId = '';
let projectDir = '';

test.beforeEach(() => {
  projectId = `tutorial-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  projectDir = resolve(FIXTURES_ROOT, projectId);
  cpSync(SAMPLE_DIR, projectDir, { recursive: true });
});

test.afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

test('チュートリアル: e2e 環境（SME_TUTORIAL=0）では自動開始しない', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });
  // 新規コンテキスト（localStorage 空）でもオーバーレイは出ない。
  await page.waitForTimeout(800);
  await expect(page.locator('.tut')).toHaveCount(0);
});

test('チュートリアル: ホームの？から開始し、ホーム系ステップを進んで finish まで到達できる', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });

  await page.locator('.tb-tutorial-btn').click();
  await expect(page.locator('[data-testid="help-dialog"]')).toBeVisible();
  await page.locator('.help-replay-btn').click();
  await expect(page.locator('.tut[data-step="welcome"]')).toBeVisible();

  // はじめる → ホーム紹介
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="home-intro"]')).toBeVisible();
  await expect(page.locator('.tut-text')).toContainText('ホーム画面');

  // 次へ → MCP 接続案内（未接続なので接続手順の案内文が出る・埋め込みターミナル導線）
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="mcp"]')).toBeVisible();
  await expect(page.locator('.tut-text')).toContainText('ボタンを押すだけで');
  await expect(page.locator('.tut-mcp')).toContainText('AI と接続する（Claude Code を導入）');

  // 次へ → 進行ボード → 次へ → 動画を作成（実操作待ち・次へボタン無し）
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="board"]')).toBeVisible();
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="create"]')).toBeVisible();
  await expect(page.locator('.tut-next')).toHaveCount(0);

  // 動画が無い人の逃げ道: スキップ → エディタ系を飛ばして finish（⚙案内の文言）
  await page.locator('.tut-skip').click();
  await expect(page.locator('.tut[data-step="finish"]')).toBeVisible();
  await expect(page.locator('.tut-text')).toContainText('チュートリアル図鑑');

  // おわる → 消える＋完了フラグ
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut')).toHaveCount(0);
  const done = await page.evaluate(() => localStorage.getItem('sme-tutorial-done'));
  expect(done).not.toBeNull();
});

test('チュートリアル: エディタで再実行→＋追加からテロップ追加で🎉→保存で自動前進→完了', async ({ page }) => {
  await page.goto('/');
  // 隔離コピーのプロジェクトを開く（保存まで行うため sample-project 本体は触らない）。
  await page.locator('.home-card', { hasText: projectId }).click({ timeout: 15_000 });
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // ⚙メニュー →「チュートリアル図鑑」→「もう一度最初から見る」で再実行
  await page.locator('.tb-settings-btn').click();
  await page.locator('.tb-tutorial-item').click();
  await expect(page.locator('[data-testid="help-dialog"]')).toBeVisible();
  await page.locator('.help-replay-btn').click();
  await expect(page.locator('.tut[data-step="welcome"]')).toBeVisible();

  // はじめる → ホーム系はすべて飛んでエディタ紹介から
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="editor-left"]')).toBeVisible();
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="ai-tab"]')).toBeVisible();
  await expect(page.locator('.tut-text')).toContainText('何でも聞いてみてね');
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="timeline"]')).toBeVisible();
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="add-button"]')).toBeVisible();
  await expect(page.locator('.tut-text')).toContainText('＋ 追加');
  await page.locator('.tut-next').click();

  // テロップ追加体験（実操作ゲート）: オーバーレイはクリック透過なので実ボタンを押せる。
  await expect(page.locator('.tut[data-step="telop-try"]')).toBeVisible();
  await expect(page.locator('.tut-next')).toHaveCount(0);
  await page.locator('.tl-add-menu-btn').click();
  await page.locator('.tl-telop-add').click();

  // 追加検知 → お祝いステップ（紙吹雪）
  await expect(page.locator('.tut[data-step="telop-done"]')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.tut-confetti')).toBeVisible();
  await page.locator('.tut-next').click();

  // 保存ステップ: テロップ追加で dirty のはず → 実際に保存すると自動前進
  await expect(page.locator('.tut[data-step="save"]')).toBeVisible();
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save').click();

  // 書き出しステップ（説明のみ・ボタンは押さない） → レイアウト
  await expect(page.locator('.tut[data-step="render"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tut-text')).toContainText('書き出し');
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="layout"]')).toBeVisible();

  // レイアウト → 完了
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut[data-step="finish"]')).toBeVisible();
  await expect(page.locator('.tut-text')).toContainText('何でも聞いてみてね');
  await page.locator('.tut-next').click();
  await expect(page.locator('.tut')).toHaveCount(0);
});
