import { test, expect } from '@playwright/test';
import { openEditor, useTempProject } from './helpers';

// これらのテストはファイルを保存しない（速度はメモリ上のみ変更）ため、
// afterEach でのファイル削除は不要。git clean は行わない
// （per-segment-speed.spec.ts が保存した speedData.ts を誤って削除する競合を防ぐ）。

// 共有 sample-project は smoke / heavy-job-confirm の afterEach が git checkout/clean で
// 巻き戻すため、その窓に重なると読み込みが壊れる（helpers.ts の useTempProject 参照）。
// このファイルは保存を伴わない読み取り専用の検証なので、専用コピーへ隔離するだけで足りる。
const projectId = useTempProject('speed-stretch-tmp');

test('区間を 0.5x にすると帯が広がり、完成尺が増える', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());

  // タイムラインの残す区間帯が出る（cutData.ts に 2 区間があるため）
  const band = page.locator('.tl-kept-segment').first();
  await expect(band).toBeVisible();

  // 帯の初期幅を記録する（非ゼロであることを先に確認）
  const boxBefore = await band.boundingBox();
  expect(boxBefore).not.toBeNull();
  expect(boxBefore!.width).toBeGreaterThan(0);
  const before = boxBefore!.width;

  // 完成尺の初期テキストを記録する
  const totalLabel = page.locator('.tl-total');
  await expect(totalLabel).toBeVisible();
  const totalBefore = await totalLabel.textContent();

  // 区間をクリックするとインスペクタに区間速度タブが出る
  await band.click();
  const segTab = page.locator('[data-cutsegment]');
  await expect(segTab).toBeVisible();

  // 0.5x プリセットをクリックする（0.5x = スロー → 帯が約2倍に広がる）
  await page.locator('[data-cutsegment] .ins-vi-speed-preset[data-rate="0.5"]').click();

  // 速度値が 0.5 に変わっていることを確認する
  await expect(page.locator('[data-cutsegment] .ins-vi-speed-value')).toContainText('0.5');

  // 帯が広がる（0.5x で約2倍・閾値はマージンを見て 1.5 倍以上）
  await expect.poll(async () => {
    const b = await band.boundingBox();
    return b?.width ?? 0;
  }, { timeout: 5_000 }).toBeGreaterThan(before * 1.5);

  // 完成尺ラベルが変化していることを確認する（poll で CI 遅延を吸収）
  await expect(totalLabel).not.toHaveText(totalBefore!, { timeout: 3_000 });
  const totalAfter = await totalLabel.textContent();
  expect(totalAfter, `完成尺 should have changed from "${totalBefore}"`).not.toBe(totalBefore);

  expect(pageErrors).toEqual([]);
});

test('区間を 2x にすると帯が縮まる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openEditor(page, projectId());

  // タイムラインの残す区間帯を取得して初期幅を記録する
  const band = page.locator('.tl-kept-segment').first();
  await expect(band).toBeVisible();

  const boxBefore = await band.boundingBox();
  expect(boxBefore).not.toBeNull();
  expect(boxBefore!.width).toBeGreaterThan(0);
  const before = boxBefore!.width;

  // 区間をクリックして速度インスペクタを出す
  await band.click();
  await expect(page.locator('[data-cutsegment]')).toBeVisible();

  // 2x プリセットをクリックする（2x = 早送り → 帯が約半分に縮まる）
  await page.locator('[data-cutsegment] .ins-vi-speed-preset[data-rate="2"]').click();

  // 速度値が 2 に変わっていることを確認する
  await expect(page.locator('[data-cutsegment] .ins-vi-speed-value')).toContainText('2');

  // 帯が縮まる（2x で約半分・閾値は 0.8 倍以下）
  await expect.poll(async () => {
    const b = await band.boundingBox();
    return b?.width ?? Infinity;
  }, { timeout: 5_000 }).toBeLessThan(before * 0.8);

  expect(pageErrors).toEqual([]);
});
