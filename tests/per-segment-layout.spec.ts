import { test, expect } from '@playwright/test';
import { openEditor, useTempProject } from './helpers';

// 全体レイアウト・区間レイアウトの「回転・反転」e2e スモーク。
// 保存→ディスク往復の検証は smoke.spec.ts に集約されている規約（全テスト同一ワーカー直列実行
// のため並列ワーカー間の git checkout/clean 競合が起きない）に合わせ、本ファイルは
// ファイル保存を伴わない UI 操作（回転・反転・リセット）のみを検証する。

// 共有 sample-project は smoke / heavy-job-confirm の afterEach が git checkout/clean で
// 巻き戻すため、その窓に重なると読み込みが壊れる（helpers.ts の useTempProject 参照）。
// このファイルは保存を伴わない読み取り専用の検証なので、専用コピーへ隔離するだけで足りる。
const projectId = useTempProject('per-seg-layout-tmp');

test('全体レイアウト: 回転を90度にしてから全画面に戻すと0度に戻る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());

  // メイン動画トラック見出し（ラベル「動画」）を選択
  const mainTrack = page
    .locator('.tl-track-label-clickable')
    .filter({ has: page.locator('.tl-track-name', { hasText: /^動画$/ }) })
    .first();
  await expect(mainTrack).toBeVisible();
  await mainTrack.click();

  // レイアウト section が表示される
  await expect(page.locator('[data-mainlayout]')).toBeVisible();

  // 回転スライダーを 90 に → 表示値が更新される
  const rotation = page.locator('#ins-main-rotation');
  await expect(rotation).toBeVisible();
  await rotation.fill('90');
  await expect(page.locator('.ins-ml-rotation-value')).toHaveValue('90');

  // 全画面に戻す → 回転が 0 に戻る
  await page.locator('#ins-main-layout-reset').click();
  await expect(page.locator('.ins-ml-rotation-value')).toHaveValue('0');

  expect(pageErrors).toEqual([]);
});

test('全体レイアウト: 左右反転をONにしてから全画面に戻すとOFFに戻る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());

  const mainTrack = page
    .locator('.tl-track-label-clickable')
    .filter({ has: page.locator('.tl-track-name', { hasText: /^動画$/ }) })
    .first();
  await expect(mainTrack).toBeVisible();
  await mainTrack.click();
  await expect(page.locator('[data-mainlayout]')).toBeVisible();

  // 左右反転ボタンをクリック → aria-pressed が true になる
  const fliph = page.locator('#ins-main-fliph');
  await expect(fliph).toHaveAttribute('aria-pressed', 'false');
  await fliph.click();
  await expect(fliph).toHaveAttribute('aria-pressed', 'true');

  // 全画面に戻す → aria-pressed が false に戻る
  await page.locator('#ins-main-layout-reset').click();
  await expect(fliph).toHaveAttribute('aria-pressed', 'false');

  expect(pageErrors).toEqual([]);
});

test('区間レイアウト: 大きさを変えると「全体に従うへ戻す」ボタンが出て、押すと消える', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());

  // 区間をクリック → 区間パネルが出る
  const kept = page.locator('.tl-kept-segment').first();
  await expect(kept).toBeVisible();
  await kept.click();
  await expect(page.locator('[data-cutsegment]')).toBeVisible();

  // 初期状態（全体に従う）ではリセットボタンは無い
  await expect(page.locator('#ins-seg-layout-reset')).toHaveCount(0);

  // 大きさスライダーを 2 に → リセットボタンが現れる
  await page.locator('#ins-seg-scale').fill('2');
  await expect(page.locator('#ins-seg-layout-reset')).toBeVisible();

  // リセットボタンを押す → 消える（全体に従うへ戻る）
  await page.locator('#ins-seg-layout-reset').click();
  await expect(page.locator('#ins-seg-layout-reset')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('区間レイアウト: 数値ボックスに手入力して大きさを設定できる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());
  const kept = page.locator('.tl-kept-segment').first();
  await expect(kept).toBeVisible();
  await kept.click();
  await expect(page.locator('[data-cutsegment]')).toBeVisible();

  // 数値ボックスに手入力 → Enter → スライダー反映＋個別設定化（リセットボタン出現）
  const scaleNum = page.locator('#ins-seg-scale-num');
  await scaleNum.fill('1.8');
  await scaleNum.press('Enter');
  await expect(page.locator('#ins-seg-scale')).toHaveValue('1.8');
  await expect(scaleNum).toHaveValue('1.80');
  await expect(page.locator('#ins-seg-layout-reset')).toBeVisible();

  expect(pageErrors).toEqual([]);
});
