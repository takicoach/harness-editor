import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { useTempProject } from './helpers';
import { shotDir } from './shotDir';

/**
 * 保存時の通知（クランプ／再生できる範囲が残っていない）の**積み方**の回帰テスト（H-3(e)）。
 *
 * X-2 で 2 種類の通知が 1 つの面に同居できるようになったが、改行区切りの各行が隙間なく
 * 積まれていたため、別件の 2 通知が地続きの 1 文に見えていた（X-2 レビューの minor）。
 * 件ごとに余白と区切り線を入れる。
 *
 * 通知の**中身**（どういう時に何件出るか）はサーバ側で決まり、
 * src/server/saveProject.ts と src/app/useEditSession.test.ts が既に pin している。
 * ここで見たいのは「2 件出た時の見え方」なので、保存応答（PUT /api/project）だけを
 * 実サーバの応答に 2 種類のフィールドを足す形で差し替え、クライアント〜CSS は実物を通す
 * （render-button.spec.ts が失敗応答を page.route で作るのと同じ流儀）。
 */
const projectId = useTempProject('save-clamp-tmp');

test.use({ viewport: { width: 1600, height: 1000 } });

for (const theme of ['light', 'dark'] as const) {
  test(`H-3(e): 保存通知が 2 件のとき隙間と区切りを持って積まれる（${theme}）`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('sme-theme', t as string), theme);
    await page.goto('/');
    const card = page.locator('.home-card', { hasText: projectId() });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();
    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

    // 実サーバの保存応答に、2 種類の通知フィールドを足して返す。
    // id は実在しない番号にする（存在しても状態は変わらないが、編集内容へ副作用を出さない）。
    await page.route('**/api/project?*', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      body['clampedVideoInserts'] = [{ id: 9001, originalEnd: 120 }];
      body['unplayableVideoInserts'] = [{ id: 9002, file: 'broken.mp4' }];
      return route.fulfill({ response: res, json: body });
    });

    // 何か編集して保存する（保存ボタンは dirty のときだけ押せる）。
    await page.locator('.tx-row').first().click();
    await page.locator('.tl-telop').first().click();
    await page.keyboard.press('ArrowRight');
    const save = page.locator('.tb-save.enabled');
    await expect(save).toBeVisible({ timeout: 10_000 });
    await save.click();

    // 存在検査: 通知が 2 件とも実在し、面積を持つ。
    const items = page.locator('.tb-save-clamp-notice .tb-save-clamp-item');
    await expect(items).toHaveCount(2, { timeout: 15_000 });
    const boxes = await items.evaluateAll((els) =>
      els.map((el) => {
        const b = el.getBoundingClientRect();
        return {
          top: b.top,
          bottom: b.bottom,
          w: b.width,
          h: b.height,
          borderTop: getComputedStyle(el).borderTopWidth,
        };
      }),
    );
    for (const b of boxes) {
      expect(b.w).toBeGreaterThan(100);
      expect(b.h).toBeGreaterThan(10);
    }
    // 2 件目は 1 件目から離れており、区切り線を持つ（地続きの 1 文に見えない）。
    const gap = boxes[1]!.top - boxes[0]!.bottom;
    expect(gap, '2 件の通知が隙間なく積まれている').toBeGreaterThanOrEqual(4);
    expect(boxes[0]!.borderTop, '1 件目に区切り線が出ている').toBe('0px');
    expect(parseFloat(boxes[1]!.borderTop), '2 件目に区切り線が無い').toBeGreaterThan(0);

    // H-3: この通知も右ドックのタブ帯を覆わない（以前は position:fixed で上に浮いていた）。
    const overlap = await page.evaluate(() => {
      const n = document.querySelector('.tb-save-clamp-notice')!.getBoundingClientRect();
      const t = document.querySelector('.rightdock-tabs')!.getBoundingClientRect();
      const w = Math.min(n.right, t.right) - Math.max(n.left, t.left);
      const h = Math.min(n.bottom, t.bottom) - Math.max(n.top, t.top);
      return w > 0 && h > 0 ? w * h : 0;
    });
    expect(overlap, '保存通知が右ドックのタブ帯を覆っている').toBe(0);
    await page.locator('.rightdock-tab[data-tab="settings"]').click({ timeout: 5_000 });
    await expect(page.locator('.rightdock-tab[data-tab="settings"]')).toHaveClass(/active/);

    const texts = await items.allInnerTexts();
    expect(texts[0]).toContain('自動調整');
    expect(texts[1]).toContain('再生できる範囲が残っていません');

    await page.screenshot({
      path: join(shotDir('H-3'), `save-clamp-notice-${theme}.png`),
      animations: 'disabled',
    });
  });
}
