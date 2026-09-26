import { test, expect } from '@playwright/test';
import { openEditor, canvasOpaquePixelRatio, useTempProject } from './helpers';

/**
 * 波形の「存在検査」（B-5 差し戻し・G-3）。
 *
 * 従来の `.tl-waveform`/`.ml-row-wave` 系テストは canvas 要素の DOM 存在
 * （toBeAttached/toBeVisible）しか見ておらず、samples が空でも常に PASS していた
 * （フィクスチャの main.mp4/beep.mp3 が実データを持たないスタブだったため、
 * デコードが常に失敗し、canvas は常に「空のまま構造だけ存在」していた）。
 *
 * このテストは getImageData で実際に非透明ピクセルが一定比率以上あることを検査する。
 * 空 canvas（全ピクセル alpha=0）では必ず fail する。
 */

async function toggleTheme(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /モードに切り替え/ }).click();
}

// 共有 sample-project は smoke / heavy-job-confirm の afterEach が git checkout/clean で
// 巻き戻すため、その窓に重なると読み込みが壊れる（helpers.ts の useTempProject 参照）。
// このファイルは保存を伴わない読み取り専用の検証なので、専用コピーへ隔離するだけで足りる。
const projectId = useTempProject('waveform-px-tmp');

const MIN_OPAQUE_RATIO = 0.02; // 短尺サイン波でも数%は塗られる想定。空canvasとの差は歴然。

for (const theme of ['dark', 'light'] as const) {
  test(`素材ライブラリの効果音波形に実ピクセルが描かれる（${theme}）`, async ({ page }) => {
    await openEditor(page, projectId());
    if (theme === 'light') {
      const before = await page.locator('html').getAttribute('data-theme');
      if (before !== 'light') await toggleTheme(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    }

    await page.locator('.lc-tab[data-tab="materials"]').click();
    await page.locator('.ml-tab[data-kind="se"]').click();
    const canvas = page.locator('.ml-list .ml-row').first().locator('canvas.ml-row-wave');
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    // デコード完了（非同期）を待ってから走査する。
    await expect
      .poll(async () => canvasOpaquePixelRatio(canvas), { timeout: 10_000 })
      .toBeGreaterThan(MIN_OPAQUE_RATIO);

    // 失敗時の「理由を見せる」注記が誤って出ていないことも併せて確認する。
    await expect(page.locator('.ml-row-wave-error')).toHaveCount(0);
  });

  test(`タイムライン動画トラックの波形に実ピクセルが描かれる（${theme}）`, async ({ page }) => {
    await openEditor(page, projectId());
    if (theme === 'light') {
      const before = await page.locator('html').getAttribute('data-theme');
      if (before !== 'light') await toggleTheme(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    }

    const canvas = page.locator('.tl-track-cut .tl-waveform');
    await expect(canvas).toBeAttached();
    await expect
      .poll(async () => canvasOpaquePixelRatio(canvas), { timeout: 10_000 })
      .toBeGreaterThan(MIN_OPAQUE_RATIO);

    // デコード失敗の注記が誤って出ていないことも併せて確認する。
    await expect(page.locator('.tl-waveform-hint')).toHaveCount(0);
  });
}
