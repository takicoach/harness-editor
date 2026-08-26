import { test, expect } from '@playwright/test';

test('ホーム: 動画ファイルのドロップで作成モーダルが開く（複数は1件目のみ + 通知）', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });

  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['00'], 'dropped.mp4', { type: 'video/mp4' }));
    dt.items.add(new File(['00'], 'second.mov', { type: 'video/quicktime' }));
    return dt;
  });
  await page.dispatchEvent('.home', 'drop', { dataTransfer });

  await expect(page.locator('.home-create-dialog')).toBeVisible();
  await expect(page.locator('.home-create-file-note')).toContainText('dropped.mp4');
  const notice = page.locator('.home-drop-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('1件目のみ');
  // 作成モーダルのスクリム（.export-overlay）の下に沈んでいないこと。toBeVisible() は
  // 重なりを見ないので実測する（バッチE レビュー指摘②の回帰）。通知は pointer-events:none
  // なので elementFromPoint では検出できない（ヒットテストから外れる）。代わりに
  // 「同じスタッキングコンテキストに属していること」を確認したうえで z-index を比べる
  // — 同一コンテキスト内なら z-index の大小が描画順そのもの。
  const stack = await page.evaluate(() => {
    const creates = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      return (
        (cs.position !== 'static' && cs.zIndex !== 'auto') ||
        cs.transform !== 'none' ||
        cs.filter !== 'none' ||
        Number(cs.opacity) < 1 ||
        cs.isolation === 'isolate' ||
        cs.mixBlendMode !== 'normal'
      );
    };
    const contextOf = (el: Element): Element => {
      let cur = el.parentElement;
      while (cur !== null && cur !== document.documentElement) {
        if (creates(cur)) return cur;
        cur = cur.parentElement;
      }
      return document.documentElement;
    };
    const n = document.querySelector('.home-drop-notice');
    const o = document.querySelector('.export-overlay');
    if (n === null || o === null) return null;
    return {
      sameContext: contextOf(n) === contextOf(o),
      noticeZ: Number(getComputedStyle(n).zIndex),
      overlayZ: Number(getComputedStyle(o).zIndex),
    };
  });
  expect(stack).not.toBeNull();
  expect(stack!.sameContext).toBe(true);
  expect(stack!.noticeZ).toBeGreaterThan(stack!.overlayZ);
  await page.locator('.export-cancel').click();
});

test('ホーム: 動画以外の拡張子は通知だけ出してモーダルを開かない', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    return dt;
  });
  await page.dispatchEvent('.home', 'drop', { dataTransfer });
  await expect(page.locator('.home-drop-notice')).toBeVisible();
  await expect(page.locator('.home-create-dialog')).toHaveCount(0);
});

test('ホーム: カードの上へのドロップは新規作成にしない（明示的ドロップ領域のみ）', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['00'], 'dropped.mp4', { type: 'video/mp4' }));
    return dt;
  });
  await card.dispatchEvent('drop', { dataTransfer });
  await page.waitForTimeout(300);
  await expect(page.locator('.home-create-dialog')).toHaveCount(0);
});

test('ホーム: ドロップ通知はポインタを奪わない（5秒間ボタンが押せなくならない）', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
    return dt;
  });
  await page.dispatchEvent('.home', 'drop', { dataTransfer });
  const notice = page.locator('.home-drop-notice');
  await expect(notice).toBeVisible();

  // 通知の中心でヒットテストすると、通知**以外**（下の要素）が返る＝クリックを奪っていない。
  // pointer-events:auto に戻すとここが .home-drop-notice を返して落ちる。
  const box = await notice.boundingBox();
  expect(box).not.toBeNull();
  const hit = await page.evaluate(
    ([x, y]: [number, number]) => document.elementFromPoint(x, y)?.className ?? '',
    [box!.x + box!.width / 2, box!.y + box!.height / 2] as [number, number],
  );
  expect(String(hit)).not.toContain('home-drop-notice');
});

test('ホーム: 受理しないカードの上ではドロップヒントを出さない', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['00'], 'dropped.mp4', { type: 'video/mp4' }));
    return dt;
  });
  // 空きスペースへ入るとヒントが出る
  await page.dispatchEvent('.home-head', 'dragenter', { dataTransfer });
  await expect(page.getByTestId('home-drop-hint')).toBeVisible();
  // カードの上へ移ると、受理しない場所なのでヒントは消える
  await card.dispatchEvent('dragover', { dataTransfer });
  await expect(page.getByTestId('home-drop-hint')).toHaveCount(0);
});
