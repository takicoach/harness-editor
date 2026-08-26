import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, expect } from '@playwright/test';

/**
 * フィクスチャプロジェクト（sample-project）の `.sme/status.json` パス。
 * dev サーバーは playwright.config.ts の HARNESS_PROJECT_ROOT で
 * src/server/__fixtures__ を指すため、このパスで直接読み書きできる。
 */
const STATUS_FILE = join(
  import.meta.dirname,
  '..',
  'src/server/__fixtures__/sample-project/.sme/status.json',
);

// このファイル内のテストは共有フィクスチャの .sme/status.json を書き換えるため、
// 並列実行時の衝突を避けて直列に走らせる。
test.describe.configure({ mode: 'serial' });

test.afterEach(() => {
  // コミット禁止のためテスト内で作成した status.json は必ず削除する。
  // fixture のコミットは行わない方式（既知の並列フレーク対策と同じ理由でここも最小限に）。
  if (existsSync(STATUS_FILE)) rmSync(STATUS_FILE);
});

test('ホーム: プロジェクトカードが並び、ステータスバッジが表示される', async ({ page }) => {
  await page.goto('/');

  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  // バッジが表示され、既知のステータスラベルのいずれかを示す
  const badge = card.locator('.status-badge');
  await expect(badge).toBeVisible();
  await expect(badge.locator('.status-badge-label')).toHaveText(/未着手|文字起こし|カット|テロップ|SE・BGM|書き出し済/);
});

test('ホーム: カードに保存先の絶対パスが出る（サーバの dir が実際に届いている）', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const path = card.getByTestId('home-card-path');
  await expect(path).toContainText('保存先');
  // 実プロジェクトルート（フィクスチャ）配下の絶対パスであること。
  await expect(path).toHaveAttribute('title', dirname(dirname(STATUS_FILE)));
});

test('ホーム: バッジメニューでテロップに変更→status.json 書き込み→自動判定に戻す', async ({ page }) => {
  await page.goto('/');

  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  const badge = card.locator('.status-badge');
  await badge.click();

  const menu = card.locator('.home-badge-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'テロップにする' }).click();

  // 楽観更新でバッジ表示がすぐ変わる
  await expect(badge.locator('.status-badge-label')).toHaveText('テロップ');

  // サーバーが .sme/status.json に stage を書き込んでいる
  await expect
    .poll(() => (existsSync(STATUS_FILE) ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as { stage?: string }).stage : undefined))
    .toBe('telop');

  // 自動判定に戻す
  await badge.click();
  const menu2 = card.locator('.home-badge-menu');
  await expect(menu2).toBeVisible();
  await menu2.getByRole('menuitem', { name: '自動判定に戻す' }).click();

  await expect
    .poll(() => (existsSync(STATUS_FILE) ? (JSON.parse(readFileSync(STATUS_FILE, 'utf8')) as { stage?: string | null }).stage : undefined))
    .toBe(null);
});

test('ホーム: カンバン6列が並び、タイムライン・右ドックは非表示（プロジェクトを開くと復帰）', async ({ page }) => {
  await page.goto('/');

  // 既定はパネルビューなのでカンバンへ切り替える
  await page.locator('.home-view-btn', { hasText: '進行ボード' }).click({ timeout: 15_000 });

  // 6列が工程順に出る
  const cols = page.locator('.home-col');
  await expect(cols).toHaveCount(6, { timeout: 15_000 });
  await expect(page.locator('.home-col-label')).toHaveText([
    '未着手',
    '文字起こし',
    'カット',
    'テロップ',
    'SE・BGM',
    '書き出し済',
  ]);

  // ホームではタイムラインと右ドック（Claude 指示欄）が消えている
  await expect(page.locator('.tl')).toBeHidden();
  await expect(page.locator('.rightdock, .cl')).toBeHidden();

  // カードはいずれかの列の中にいる
  const card = page.locator('.home-col .home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible();

  // バッジをテロップへ変更 → カードがテロップ列へ移動する
  await card.locator('.status-badge').click();
  await card.locator('.home-badge-menu').getByRole('menuitem', { name: 'テロップにする' }).click();
  await expect(
    page.locator('.home-col[data-status="telop"] .home-card', { hasText: 'sample-project' }),
  ).toBeVisible();

  // プロジェクトを開くとタイムラインが戻る
  await card.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.tl')).toBeVisible();
});

test('進行ボード: 列の 2 枚目のカードでもバッジメニューが下のカードに潜らない', async ({ page }) => {
  // カードは `.home-card:hover { transform }` でスタッキングコンテキストを作る。
  // その中の `.dd-menu`（z-index:60）は**カードの外へ張り出す**ため、DOM 順で後ろの
  // 兄弟カードの下に描かれうる（間欠再現）。**後続の兄弟がいるカード**でしか出ないので、
  // 列に 3 枚並べて 2 枚目を操作する（1 枚目だと後続が無い構成でも通ってしまう）。
  const ids = [0, 1].map(
    (i) => `zorder-tmp-${i}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  );
  const dirs = ids.map((id) => join(import.meta.dirname, '..', 'src/server/__fixtures__', id));
  for (const dir of dirs) {
    cpSync(join(dirname(STATUS_FILE), '..'), dir, { recursive: true });
    rmSync(join(dir, '.sme'), { recursive: true, force: true });
  }
  try {
    await page.goto('/');
    await page.locator('.home-view-btn', { hasText: '進行ボード' }).click({ timeout: 15_000 });

    // 追加したカードが入った列（＝sample-project と同じ工程の列）を掴む。
    const anchor = page.locator('.home-card', { hasText: ids[0] as string });
    await expect(anchor).toBeVisible({ timeout: 15_000 });
    const col = page.locator('.home-col').filter({ has: anchor });
    const cards = col.locator('.home-card');
    expect(await cards.count(), '列に 3 枚以上並んでいない（後続兄弟の検査にならない）')
      .toBeGreaterThanOrEqual(3);

    // 2 枚目のバッジメニューを開く（この時点でカードは hover 状態）。
    const second = cards.nth(1);
    await second.locator('.status-badge').click();
    const menu = second.locator('.home-badge-menu');
    await expect(menu).toBeVisible();

    // メニューはカードの下端より下まで伸びる。**次のカードに重なる位置の項目**を検査する
    // （メニュー上端の項目はカード内に収まっており、覆われないので検査にならない）。
    const probe = menu.getByRole('menuitem', { name: '自動判定に戻す' });
    await expect(probe).toBeVisible();
    const hit = await probe.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const owner = el.closest('.home-card') as HTMLElement;
      const all = Array.from(document.querySelectorAll('.home-col .home-card')) as HTMLElement[];
      const next = all[all.indexOf(owner) + 1];
      const nr = next?.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        inViewport: r.bottom <= window.innerHeight,
        overlapsNextCard: nr !== undefined && r.bottom > nr.top && r.top < nr.bottom,
        topmostIsMenuItem: top !== null && top.closest('.home-badge-menu') !== null,
        topmost: top === null ? 'null' : top.className,
      };
    });
    // まず「検査が成立している」ことを確かめる（重なっていない配置なら常に緑になる）。
    expect(hit.inViewport, '検査対象の項目が画面外（配置が変わった）').toBe(true);
    expect(hit.overlapsNextCard, '検査対象の項目が次のカードに重なっていない（検査にならない）').toBe(true);
    // 本題: その点の最前面がメニュー項目であること（カードが上に乗っていない）。
    expect(hit.topmostIsMenuItem, `最前面が ${hit.topmost}（メニューが下のカードに潜っている）`).toBe(true);

    // 実クリックでも届くこと（Playwright は hit target を検査する）。届けば onClick でメニューが閉じる。
    await probe.click({ timeout: 5_000 });
    await expect(menu).toHaveCount(0);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});

test('ホーム: パネル/カンバンのビュー切替が動き、リロード後も保持される', async ({ page }) => {
  await page.goto('/');

  // 既定はパネルビュー（Notion 風ギャラリー）
  await expect(page.locator('.home-grid')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.home-kanban')).toHaveCount(0);
  await expect(page.locator('.home-grid .home-card', { hasText: 'sample-project' })).toBeVisible();

  // カンバンへ切替
  await page.locator('.home-view-btn', { hasText: '進行ボード' }).click();
  await expect(page.locator('.home-kanban')).toBeVisible();
  await expect(page.locator('.home-grid')).toHaveCount(0);
  await expect(page.locator('.home-col')).toHaveCount(6);

  // リロードしてもカンバンのまま（localStorage 永続）
  await page.reload();
  await expect(page.locator('.home-kanban')).toBeVisible({ timeout: 15_000 });

  // パネルへ戻す
  await page.locator('.home-view-btn', { hasText: '一覧' }).click();
  await expect(page.locator('.home-grid')).toBeVisible();
});

test('サイドバー: 編集中に activity が書かれると「作業中」表示がライブで出て、消すと戻る', async ({ page }) => {
  // 共有 fixture（sample-project）の .sme を書くと、並列中の他テストが開いている
  // 同プロジェクトに外部更新イベントが飛んで干渉する。専用コピーへ隔離する。
  const projectId = `status-live-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const projectDir = join(import.meta.dirname, '..', 'src/server/__fixtures__', projectId);
  const statusFile = join(projectDir, '.sme', 'status.json');
  cpSync(join(dirname(STATUS_FILE), '..'), projectDir, { recursive: true });
  rmSync(join(projectDir, '.sme'), { recursive: true, force: true });
  try {
    await page.goto('/');

    // 隔離プロジェクトを開く（編集画面 = サイドバー表示状態）
    await page.locator('.home-card', { hasText: projectId }).click({ timeout: 15_000 });
    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

    const item = page.locator('.fb-item', { hasText: projectId });
    await expect(item).toBeVisible();
    await expect(item).not.toHaveClass(/fb-working/);

    // 別プロセス（スキル）を模して .sme/status.json に activity を書く → SSE で反映
    mkdirSync(dirname(statusFile), { recursive: true });
    writeFileSync(
      statusFile,
      JSON.stringify({ activity: { label: 'カット中', startedAt: new Date().toISOString() } }),
    );
    await expect(item).toHaveClass(/fb-working/, { timeout: 15_000 });
    await expect(item.locator('.fb-activity')).toHaveText(/カット中/);
    await expect(item.locator('.fb-activity .status-spinner')).toBeVisible();

    // activity を消す → 強調が外れる
    writeFileSync(statusFile, JSON.stringify({}));
    await expect(item).not.toHaveClass(/fb-working/, { timeout: 15_000 });
    await expect(item.locator('.fb-activity')).toHaveCount(0);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test('ホーム: カードに工程ステッパーが出て、fixture の実ファイル状態と一致する', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  const steps = card.locator('.home-card-steps .home-step');
  await expect(steps).toHaveCount(5);
  // sample-project fixture: transcript.json あり / cutData あり / telopData エントリあり /
  // seData あり / out/video.mp4 なし
  await expect(card.locator('.home-step[data-step="transcribe"]')).toHaveAttribute('data-done', 'true');
  await expect(card.locator('.home-step[data-step="rendered"]')).toHaveAttribute('data-done', 'false');

  // 属性だけでなく実寸で読めることを確かめる（0 幅に潰れた状態でも属性検査は通ってしまうため）。
  for (const key of ['transcribe', 'rendered']) {
    const box = await card.locator(`.home-step[data-step="${key}"] .home-step-label`).boundingBox();
    expect(box, `${key} のラベルが可視でない`).not.toBeNull();
    expect(box!.width).toBeGreaterThan(8);
    expect(box!.height).toBeGreaterThan(4);
  }
});

test('ホーム: 手動 stage 設定で「手動」バッジが出て、自動判定に戻すと消える', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(card).toBeVisible({ timeout: 15_000 });

  await card.locator('.status-badge').click();
  await card.locator('.home-badge-menu').getByRole('menuitem', { name: 'テロップにする' }).click();
  await expect(card.locator('.home-card-manual')).toBeVisible();

  await card.locator('.status-badge').click();
  await card.locator('.home-badge-menu').getByRole('menuitem', { name: '自動判定に戻す' }).click();
  await expect(card.locator('.home-card-manual')).toHaveCount(0);
});
