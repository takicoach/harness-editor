import { test, expect } from '@playwright/test';
import { createTempProject, removeTempProject } from './helpers';

/**
 * プロジェクト切替で未保存編集が消えないこと（G-5・実機での行動テスト）。
 *
 * 左カラムのプロジェクト一覧は**編集中も見えている**ため、そこから別プロジェクトを選ぶと
 * `useEditorProject.selectProject` が新しい EditorProject を読み込み、`useEditSession` が
 * セッションごと作り直す（履歴も savedContent も破棄）。保存を挟まないと、この経路だけ
 * 未保存編集が**警告も出ず**に消える。
 *
 * ソース文字列の正規表現ではなく実機の往復（編集 → 別プロジェクトへ切替 → 戻る）で検査する。
 * 等価な書き換え（`void` の有無・変数名）で赤くならず、別経路で `selectProject` を
 * 直接呼ぶ新コードが入れば赤くなる。
 *
 * 自動保存は e2e では既定 OFF（playwright.config.ts が SME_AUTO_SAVE=0 を渡す）。
 * 「自動保存に助けられて偶然残った」ではないことを、テスト内で /api/config を見て確かめる。
 */

const MARKER = '切替でも消えないテロップ';

let a = { id: '', dir: '' };
let b = { id: '', dir: '' };

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  a = createTempProject('switch-a');
  b = createTempProject('switch-b');
});

test.afterEach(async ({ page }) => {
  // ページを閉じてから消す（開いたままだと削除中のプロジェクトへ要求が飛び ENOTEMPTY になる）。
  await page.close();
  removeTempProject(a.dir);
  removeTempProject(b.dir);
});

test('編集中に別プロジェクトへ切り替えて戻っても編集が残っている', async ({ page }) => {
  // 前提の存在検査: 自動保存 OFF（ON だと「切替時の保存」を検査したことにならない）。
  const cfg = await page.request.get('/api/config');
  expect(((await cfg.json()) as { autoSaveDefaultEnabled?: boolean }).autoSaveDefaultEnabled).toBe(false);

  await page.goto('/');

  // A を開く
  const cardA = page.locator('.home-card', { hasText: a.id });
  await expect(cardA).toBeVisible({ timeout: 15_000 });
  await cardA.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // テロップを 1 件編集して未保存にする。
  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  const editor = page.locator('.tx-row.selected .tx-text-edit');
  await expect(editor).toBeVisible();
  await editor.fill(MARKER);
  await expect(page.locator('.tx-row', { hasText: MARKER })).toHaveCount(1);

  // 左カラムの一覧から B へ切り替える（サイドバーが畳まれていれば開く）。
  if ((await page.locator('.fb-item').count()) === 0) {
    await page.locator('.fb-collapse').first().click();
  }
  const listItemB = page.locator('.fb-item').filter({ hasText: b.id }).first();
  await expect(listItemB).toBeVisible({ timeout: 10_000 });
  await listItemB.click();

  // B が本当に開いた（存在検査。切替が起きていなければ以降の検査は無意味）。
  await expect(page.locator('.fb-item.active').filter({ hasText: b.id })).toHaveCount(1, { timeout: 20_000 });
  await expect(page.locator('.tx-row', { hasText: MARKER })).toHaveCount(0);

  // A へ戻る。
  const listItemA = page.locator('.fb-item').filter({ hasText: a.id }).first();
  await expect(listItemA).toBeVisible({ timeout: 10_000 });
  await listItemA.click();
  await expect(page.locator('.fb-item.active').filter({ hasText: a.id })).toHaveCount(1, { timeout: 20_000 });

  // 修正前はここで 0 件（編集が黙って消えていた）。
  await expect(page.locator('.tx-row', { hasText: MARKER })).toHaveCount(1, { timeout: 10_000 });
});
