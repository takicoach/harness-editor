import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';

const REPO = join(import.meta.dirname, '..');
const FIXROOT = join(REPO, 'src/server/__fixtures__');
/**
 * 使い捨てプロジェクト名（ホームのカード検索キーでもある）。テストごとに固有名にする
 * — 同じ名前を作り直すと、直前のテストの後片付け（復元した実体の削除）と競合して
 * cpSync が ENOTEMPTY で落ちることがある（実測フレーク）。
 */
let NAMES: string[] = [];
let seq = 0;
const ROOT_TRASH = join(FIXROOT, '.trash');

// trash.spec.ts と同じ方針: 共有フィクスチャ sample-project は触らず（default project 側の
// spec が afterEach で git clean を掛けるため）、git HEAD から使い捨てプロジェクトを複製する。
function makeDisposableProjects(): void {
  seq += 1;
  NAMES = [`bulk-e2e-${seq}-a`, `bulk-e2e-${seq}-b`];
  const staging = mkdtempSync(join(tmpdir(), 'sme-bulk-'));
  try {
    execSync(`git archive HEAD src/server/__fixtures__/sample-project | tar -x -C "${staging}"`, {
      cwd: REPO,
      stdio: 'ignore',
    });
    for (const name of NAMES) {
      const dir = join(FIXROOT, name);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      cpSync(join(staging, 'src/server/__fixtures__/sample-project'), dir, { recursive: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(() => {
  makeDisposableProjects();
});

test.afterEach(() => {
  for (const name of NAMES) {
    rmSync(join(FIXROOT, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  rmSync(ROOT_TRASH, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 進行ボードを開く（表示モードは localStorage 永続なので毎回明示する）。 */
async function openBoard(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: '進行ボード' }).click();
  for (const name of NAMES) {
    await expect(page.locator('.home-card', { hasText: name })).toBeVisible({ timeout: 15_000 });
  }
}

test('選択モードで2件チェック → 一括でゴミ箱へ → ゴミ箱ビューに2件 → 1件復元でボードへ戻る', async ({ page }) => {
  await openBoard(page);

  await page.getByRole('button', { name: '選択' }).click();
  const bar = page.getByTestId('home-select-bar');
  await expect(bar).toBeVisible();
  for (const name of NAMES) {
    await page.locator('.home-card', { hasText: name }).click();
  }
  await expect(bar).toContainText('2 件選択中');

  await bar.getByRole('button', { name: 'ゴミ箱へ移動' }).click();
  const confirm = page.getByTestId('trash-confirm-dialog');
  await expect(confirm).toContainText('選択した 2 件');
  await expect(confirm.getByTestId('trash-confirm-names')).toContainText(NAMES[0] as string);
  await confirm.getByTestId('trash-confirm-ok').click();

  // カードが消え、実体もルートのゴミ箱へ移る
  for (const name of NAMES) {
    await expect(page.locator('.home-card', { hasText: name })).toHaveCount(0, { timeout: 15_000 });
  }
  await expect.poll(() => existsSync(join(ROOT_TRASH, 'trash-manifest.json'))).toBe(true);
  expect(NAMES.some((n) => existsSync(join(FIXROOT, n)))).toBe(false);
  await expect(page.getByTestId('home-bulk-notice')).toContainText('2 件をゴミ箱へ移動しました');

  // ゴミ箱ビューに 2 件並ぶ（カード一覧）
  await page.locator('.home-trash-open').first().click();
  const view = page.getByTestId('trash-view');
  await expect(view).toBeVisible();
  for (const name of NAMES) {
    await expect(view.locator('.trash-card', { hasText: name })).toBeVisible({ timeout: 10_000 });
  }

  // 1 件だけ復元 → 「戻る」でボードへ帰り、そのカードだけ戻っている
  await view.locator('.trash-card', { hasText: NAMES[0] as string }).locator('.trash-restore').click();
  await expect(view.locator('.trash-card', { hasText: NAMES[0] as string })).toHaveCount(0, { timeout: 10_000 });
  await view.getByRole('button', { name: '戻る' }).click();
  await expect(page.locator('.home-card', { hasText: NAMES[0] as string })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.home-card', { hasText: NAMES[1] as string })).toHaveCount(0);
  expect(existsSync(join(FIXROOT, NAMES[0] as string))).toBe(true);
});

test('選択モード中はカードの列間 D&D が発動しない', async ({ page }) => {
  await openBoard(page);
  const card = page.locator('.home-card', { hasText: NAMES[0] as string });
  // 選択モードに入るとカードは draggable を降りる。
  await expect(card).toHaveAttribute('draggable', 'true');
  await page.getByRole('button', { name: '選択' }).click();
  await expect(card).toHaveAttribute('draggable', 'false');

  // 実ブラウザの HTML5 D&D は mouse では起こせないため、kanban-dnd.spec.ts と同じく
  // DataTransfer を明示した dispatchEvent で本物の drop 経路を通す。
  const before = await card.evaluate((el) => el.closest('.home-col')?.getAttribute('data-status') ?? '');
  const target = page.locator('.home-col[data-status="rendered"]');
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await target.dispatchEvent('drop', { dataTransfer: dt });

  await expect
    .poll(() => card.evaluate((el) => el.closest('.home-col')?.getAttribute('data-status') ?? ''))
    .toBe(before);
  // ステータスの手動固定バッジも付いていない（ドロップが成立していない証拠）。
  await expect(card.locator('.home-card-manual')).toHaveCount(0);

  // 陽性対照: 選択モードを抜ければ同じ手順で本当に列が動く
  // （＝上の「動かない」が、そもそも drop 経路が動かないだけの空アサートではない）。
  await page.getByTestId('home-select-bar').getByRole('button', { name: 'キャンセル' }).click();
  const dt2 = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer: dt2 });
  await target.dispatchEvent('dragover', { dataTransfer: dt2 });
  await target.dispatchEvent('drop', { dataTransfer: dt2 });
  await expect(
    page.locator('.home-col[data-status="rendered"] .home-card', { hasText: NAMES[0] as string }),
  ).toBeVisible({ timeout: 10_000 });
});
