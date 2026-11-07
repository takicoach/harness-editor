import { test, expect } from '@playwright/test';

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

// ショートを何本も作ると画面の大半がカードになるので、カードの上も新しいプロジェクトを作る場所にする（以前は受け付けず、案内も出なかった）。
test('ホーム: カードの上に落としても、新しいプロジェクトの作成画面が開く', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['00'], 'dropped.mp4', { type: 'video/mp4' }));
    return dt;
  });
  await card.dispatchEvent('drop', { dataTransfer });
  await expect(page.locator('.home-create-dialog')).toBeVisible();
  await expect(page.locator('.home-create-dialog')).toContainText('dropped.mp4');
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

test('ホーム: カードの上でもドロップヒントが出続ける', async ({ page }) => {
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
  await card.dispatchEvent('dragover', { dataTransfer });
  await expect(page.getByTestId('home-drop-hint')).toBeVisible();
});

// 新しい編集画面では、複数の動画を 1 本ずつ別のプロジェクトにする（HomeDashboard.tsx の startCreate。実際に作るところは home-folder-materials.spec.ts）。
// 旧画面の「複数は 1 件目のみ＋通知」は契約が変わったので、2026-10-15 に退役した旧 test の期待を今の仕様で書き直した。
test('ホーム: 複数の動画を落とすと、作るプロジェクトが名前の順に並ぶ作成画面が開き、1 件目だけの通知は出ない', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });
  // 落とす順は名前の順と逆にし、自然順（clip-2 < clip-10）に並べ替わることまで見る。
  const dataTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['00'], 'clip-10.mp4', { type: 'video/mp4' }));
    dt.items.add(new File(['00'], 'clip-2.mov', { type: 'video/quicktime' }));
    return dt;
  });
  await page.dispatchEvent('.home', 'drop', { dataTransfer });

  const dialog = page.locator('.home-create-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.home-create-file-note')).toHaveText('素材: 動画 2 本（1 本ずつ別のプロジェクト）');
  await expect(dialog.locator('.home-create-link-note', { hasText: '動画 2 本を、それぞれ別のプロジェクトとして作ります' })).toBeVisible();
  await expect(dialog.getByRole('list', { name: '作るプロジェクト' }).getByRole('listitem').nth(0)).toContainText('clip-2');
  await expect(page.locator('.home-drop-notice')).toHaveCount(0);
  // 作らずに閉じられる（使い捨てのドロップで案件を増やさない）。
  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
