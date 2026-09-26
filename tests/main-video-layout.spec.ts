import { test, expect } from '@playwright/test';
import { openEditor, useTempProject } from './helpers';

// 共有 sample-project は smoke / heavy-job-confirm の afterEach が git checkout/clean で
// 巻き戻すため、その窓に重なると読み込みが壊れる（helpers.ts の useTempProject 参照）。
// このファイルは保存を伴わない読み取り専用の検証なので、専用コピーへ隔離するだけで足りる。
const projectId = useTempProject('main-layout-tmp');

test('メイン動画レイアウト: 大きさ設定→表示更新→全画面に戻す', async ({ page }) => {
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

  // 大きさスライダーを 1.4 に
  const scale = page.locator('#ins-main-scale');
  await expect(scale).toBeVisible();
  await scale.fill('1.4');
  await expect(page.locator('.ins-ml-scale-value')).toHaveValue('1.40');

  // 全画面に戻す → 1.00 表示に戻る
  await page.locator('#ins-main-layout-reset').click();
  await expect(page.locator('.ins-ml-scale-value')).toHaveValue('1.00');

  expect(pageErrors).toEqual([]);
});

test('メイン動画設定パネルは右ドックの左右枠内に収まる（横はみ出しなし）', async ({ page }) => {
  await openEditor(page, projectId());

  await page
    .locator('.tl-track-label-clickable')
    .filter({ has: page.locator('.tl-track-name', { hasText: /^動画$/ }) })
    .first()
    .click();
  await expect(page.locator('[data-mainlayout]')).toBeVisible();

  // レイアウトの大きさスライダーの右端が右ドックの右端を超えない
  // ＝設定内容が縦に積まれ、横スクロールなしで枠内に収まっている。
  const scaleBox = await page.locator('#ins-main-scale').boundingBox();
  const dockBox = await page.locator('.rightdock').boundingBox();
  expect(scaleBox, 'scale slider box').not.toBeNull();
  expect(dockBox, 'rightdock box').not.toBeNull();
  expect(scaleBox!.x + scaleBox!.width).toBeLessThanOrEqual(dockBox!.x + dockBox!.width + 1);
});

test('メイン動画レイアウト: 数値ボックスに手入力して大きさを設定でき、範囲外はクランプ', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());
  await page
    .locator('.tl-track-label-clickable')
    .filter({ has: page.locator('.tl-track-name', { hasText: /^動画$/ }) })
    .first()
    .click();
  await expect(page.locator('[data-mainlayout]')).toBeVisible();

  // 数値ボックスに手入力 → Enter で確定 → スライダーと表示に反映
  const scaleNum = page.locator('#ins-main-scale-num');
  await scaleNum.fill('2.5');
  await scaleNum.press('Enter');
  await expect(page.locator('#ins-main-scale')).toHaveValue('2.5');
  await expect(scaleNum).toHaveValue('2.50');

  // 範囲外（99）でも 0.1..5 にクランプされる（op 側で安全に制限）
  await scaleNum.fill('99');
  await scaleNum.press('Enter');
  await expect(scaleNum).toHaveValue('5.00');

  expect(pageErrors).toEqual([]);
});
