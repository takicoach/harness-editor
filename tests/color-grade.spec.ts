import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { openEditor, useTempProject } from './helpers';
import { shotDir } from './shotDir';
import { decodePngRgba } from '../src/server/pngRgba';

/**
 * F-2 カラー補正の実ブラウザ検証。
 *
 * ここで測るのは **プレビュー側**（実 Chromium）:
 *   - UI から 4 項目を動かせる
 *   - プレビューの DOM に補正フィルタが**実在する**（存在検査）
 *   - 補正なしに戻すと**フィルタが消える**（無補正の案件で絵が変わらない条件）
 *
 * 書き出し側の画素は scripts/verify-color-grade-pixels.ts が実 `remotion render` で測り、
 * プレビューと書き出しの DOM 一致は src/preview/colorGradeDomParity.test.tsx が固定する。
 */
const projectId = useTempProject('color-grade-tmp');

/**
 * 「そのスクショに映像が実在するか」の存在検査（ゴールプロンプト §4.2）。
 *
 * 前ラウンドの証拠スクショ（preview-graded.png）は動画が 1 枚も描かれておらず真っ黒だった。
 * DOM アサーション（filter がある・values が 20 個）は全部 PASS していたので、
 * **画面に絵があるか**は別に測るしかない。プレビュー領域を撮って相異なる色数を数える。
 * 空（黒＋枠線だけ）の絵は数十色、実映像（カラーバー）は数千色になるので歴然と分かれる。
 */
async function previewDistinctColors(stage: import('@playwright/test').Locator): Promise<number> {
  const png = await stage.screenshot();
  const { data, width, height } = decodePngRgba(png);
  const seen = new Set<number>();
  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    seen.add((data[o]! << 16) | (data[o + 1]! << 8) | data[o + 2]!);
  }
  return seen.size;
}

/** 実映像が描かれていると判断する色数の下限（空スクショ = 数十色との差は歴然）。 */
const MIN_PREVIEW_COLORS = 300;

/** プレビューに映像が描かれるまで待ってからスクショを撮る（空スクショを撮り続けない）。 */
async function shootPreview(
  stage: import('@playwright/test').Locator,
  path: string,
  label: string,
): Promise<void> {
  await expect
    .poll(async () => previewDistinctColors(stage), {
      timeout: 15_000,
      message: `${label}: プレビューに映像が描かれない（空スクショ）`,
    })
    .toBeGreaterThan(MIN_PREVIEW_COLORS);
  await stage.screenshot({ path });
}

async function selectMainVideo(page: import('@playwright/test').Page): Promise<void> {
  await page
    .locator('.tl-track-label-clickable')
    .filter({ has: page.locator('.tl-track-name', { hasText: /^動画$/ }) })
    .first()
    .click();
  await expect(page.locator('[data-colorgrade]')).toBeVisible();
}

test('カラー補正: 4項目を動かせて、プレビューに補正フィルタが実在する', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());
  await selectMainVideo(page);

  // 補正前はフィルタが無い（＝無補正の案件は素通し）。
  await expect(page.locator('#sme-main-color-grade')).toHaveCount(0);

  for (const [id, value] of [
    ['brightness', '30'],
    ['contrast', '-20'],
    ['saturation', '45'],
    ['temperature', '-35'],
  ] as const) {
    const slider = page.locator(`#ins-color-${id}`);
    await expect(slider).toBeVisible();
    await slider.fill(value);
    await expect(page.locator(`.ins-color-${id}-value`)).toHaveValue(value);
  }

  // 存在検査: filter 定義と、それを参照している要素が実際に画面にある。
  const filterDef = page.locator('#sme-main-color-grade');
  await expect(filterDef).toHaveCount(1);
  await expect(filterDef).toHaveAttribute('color-interpolation-filters', 'sRGB');
  const values = await page.locator('#sme-main-color-grade feColorMatrix').getAttribute('values');
  expect(values, 'feColorMatrix の values').not.toBeNull();
  expect(values!.split(' ')).toHaveLength(20);
  // 恒等行列のままなら「UI は動いたが絵に何もしていない」＝食い違いの温床。
  expect(values).not.toBe('1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0');

  const filtered = page.locator('[data-sme-color-grade] > div[style*="filter"]').first();
  await expect(filtered).toHaveCount(1);

  // 検品用スクショ（補正あり）。プレビュー領域だけを撮る。
  // 撮る前に「映像が実在するか」を検査する（空スクショを証拠にしない）。
  const shots = shotDir('F-2');
  const stage = page.locator('.pv-stage').first();
  await shootPreview(stage, join(shots, 'preview-graded.png'), '補正あり');

  // 目視で分かる強い補正（彩度 -100 ＝白黒）でも撮る。
  await page.locator('#ins-color-reset').click();
  await page.locator('#ins-color-saturation').fill('-100');
  await expect(page.locator('.ins-color-saturation-value')).toHaveValue('-100');
  await shootPreview(stage, join(shots, 'preview-desaturated.png'), '彩度-100');

  await page.locator('#ins-color-reset').click();
  await expect(page.locator('.ins-color-brightness-value')).toHaveValue('0');
  // 無補正へ戻したら DOM からフィルタも消える。
  await expect(page.locator('#sme-main-color-grade')).toHaveCount(0);
  await shootPreview(stage, join(shots, 'preview-neutral.png'), '無補正');
  // 設定面の証拠。パネルが縦に長く、既定のビューポートでは見出しが切れて
  // 「何の設定か」が写らない（＝証拠にならない）ので、収まる高さにしてから撮る。
  const panel = page.locator('[data-colorgrade]');
  await expect(panel.locator('.ins-title')).toHaveText('カラー補正（メイン動画・サブ動画）');
  const view = page.viewportSize();
  await page.setViewportSize({ width: view?.width ?? 1440, height: 1400 });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.locator('.ins-title')).toBeInViewport();
  await panel.screenshot({ path: join(shots, 'inspector-colorgrade.png') });
  if (view !== null) await page.setViewportSize(view);

  expect(pageErrors).toEqual([]);
});

test('カラー補正: 数値ボックスの手入力は ±100 でクランプされる', async ({ page }) => {
  await openEditor(page, projectId());
  await selectMainVideo(page);

  const num = page.locator('#ins-color-saturation-num');
  await num.fill('999');
  await num.press('Enter');
  await expect(page.locator('.ins-color-saturation-value')).toHaveValue('100');

  await num.fill('-999');
  await num.press('Enter');
  await expect(page.locator('.ins-color-saturation-value')).toHaveValue('-100');
});

test('カラー補正の設定パネルは右ドックの枠内に収まる（横はみ出しなし）', async ({ page }) => {
  await openEditor(page, projectId());
  await selectMainVideo(page);

  const sliderBox = await page.locator('#ins-color-brightness').boundingBox();
  const dockBox = await page.locator('.rightdock').boundingBox();
  expect(sliderBox, 'brightness slider box').not.toBeNull();
  expect(dockBox, 'rightdock box').not.toBeNull();
  expect(sliderBox!.x + sliderBox!.width).toBeLessThanOrEqual(dockBox!.x + dockBox!.width + 1);
});
