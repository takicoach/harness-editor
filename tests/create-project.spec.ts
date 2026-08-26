import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// ホーム「動画を作成する」の e2e。プロジェクトルート＝__fixtures__ に新規フォルダを
// 作るため、専用名で作成し前後で必ず削除する（他 spec と共有 fixture を汚さない）。
const FIXTURES_ROOT = resolve(import.meta.dirname, '../src/server/__fixtures__');
const PROJECT_NAME = 'e2e-create-project-tmp';
const PROJECT_DIR = resolve(FIXTURES_ROOT, PROJECT_NAME);
const TMP_DIR = resolve(import.meta.dirname, '.create-project-tmp');
const SRC_VIDEO = resolve(TMP_DIR, 'source.mp4');

test.beforeAll(() => {
  // ffprobe が実際に読める 1 秒のテスト動画を生成する（60fps・320x240 横型）。
  mkdirSync(TMP_DIR, { recursive: true });
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=60 -pix_fmt yuv420p "${SRC_VIDEO}"`,
    { stdio: 'ignore' },
  );
});

test.beforeEach(() => {
  rmSync(PROJECT_DIR, { recursive: true, force: true });
});

test.afterEach(() => {
  rmSync(PROJECT_DIR, { recursive: true, force: true });
});

test.afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test('ホームから動画を選んで新規プロジェクトを作成し、エディタで開く', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-create-btn').first()).toBeVisible();

  // Finder ダイアログの代わりに hidden input へ直接ファイルを渡す。
  await page.locator('[data-testid=home-create-file]').setInputFiles(SRC_VIDEO);

  // 名前確認モーダル: 日付-ファイル名の初期値が入っている → 専用名へ書き換え。
  const nameInput = page.locator('.home-create-name');
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveValue(/^\d{4}-\d{2}-\d{2}-source$/);
  await nameInput.fill(PROJECT_NAME);
  await page.locator('.export-start').click();

  // 作成完了 → そのままエディタが開く（タイムラインの＋追加ボタンで判定）。
  await expect(page.locator('.tl-add-menu-btn')).toBeVisible({ timeout: 30_000 });

  // サーバー側にも実体ができている（テンプレ骨格＋動画＋videoConfig 反映）。
  expect(existsSync(resolve(PROJECT_DIR, 'public', 'main.mp4'))).toBe(true);
  expect(existsSync(resolve(PROJECT_DIR, 'src', 'videoConfig.ts'))).toBe(true);
});

test('同名プロジェクトがあるとモーダル内にエラーを表示する', async ({ page }) => {
  mkdirSync(PROJECT_DIR, { recursive: true });
  await page.goto('/');
  await page.locator('[data-testid=home-create-file]').setInputFiles(SRC_VIDEO);
  await page.locator('.home-create-name').fill(PROJECT_NAME);
  await page.locator('.export-start').click();
  await expect(page.locator('.home-create-error')).toContainText('すでにあります');
  // モーダルは開いたまま（名前を直してリトライできる）。
  await expect(page.locator('.home-create-name')).toBeEnabled();
});


// ---------------------------------------------------------------------------
// 外付けストレージ想定の「リンクで取り込む」（コピーせず symlink）。
// 走査起点は playwright.config.ts が SME_BROWSE_ROOTS で tests/.browse-root に絞る。
// プロジェクト作成系はこのファイルに集約する（別ファイルで並列に作ると
// fixtures ルートを取り合って他 spec を巻き込む）。
// ---------------------------------------------------------------------------
// テストごとに別名にする。作成直後に走る npm install がディレクトリを掴んでいる間に
// 消すと復活することがあり、名前を使い回すと次のテストが 409（同名あり）で落ちるため。
const LINK_PROJECT_NAMES = ['e2e-link-import-a', 'e2e-link-import-b'] as const;
const BROWSE_ROOT = resolve(import.meta.dirname, '.browse-root');
const EXTERNAL_VIDEO = resolve(BROWSE_ROOT, 'external-source.mp4');

function makeExternalVideo(): void {
  mkdirSync(BROWSE_ROOT, { recursive: true });
  execSync(
    `ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=60 -pix_fmt yuv420p "${EXTERNAL_VIDEO}"`,
    { stdio: 'ignore' },
  );
}

test.describe('リンク取り込み', () => {
  const cleanup = (): void => {
    for (const n of LINK_PROJECT_NAMES) rmSync(resolve(FIXTURES_ROOT, n), { recursive: true, force: true });
  };
  test.beforeAll(() => { cleanup(); makeExternalVideo(); });
  test.afterAll(() => { cleanup(); rmSync(EXTERNAL_VIDEO, { force: true }); });

  test('フォルダから選んだ動画をコピーせずリンクで取り込む', async ({ page }) => {
    await page.goto('/');
    await page.locator('.home-create-link-btn').first().click();

    // ファイラ: 起点 → 動画を選ぶ。
    await expect(page.locator('.mp-dialog')).toBeVisible();
    await page.locator('.mp-root').first().click();
    await page.locator('.mp-file', { hasText: 'external-source.mp4' }).click();

    // 名前確認モーダルに「リンクで取り込みます」と接続先が出る。
    const nameInput = page.locator('.home-create-name');
    await expect(nameInput).toBeVisible();
    await expect(page.locator('.home-create-link-note')).toContainText('external-source.mp4');
    await nameInput.fill(LINK_PROJECT_NAMES[0]);
    await page.locator('.export-start').click();

    await expect(page.locator('.tl-add-menu-btn')).toBeVisible({ timeout: 30_000 });

    // 実体はコピーされず symlink＋接続先が記録されている。
    const dir = resolve(FIXTURES_ROOT, LINK_PROJECT_NAMES[0]);
    expect(lstatSync(resolve(dir, 'public', 'main.mp4')).isSymbolicLink()).toBe(true);
    const record = JSON.parse(
      readFileSync(resolve(dir, '.sme', 'videoLink.json'), 'utf8'),
    ) as { target: string };
    expect(record.target).toBe(EXTERNAL_VIDEO);
  });

  test('リンクが切れると警告バナーが出て、音量調整と書き出しは止まる', async ({ page }) => {
    const name = LINK_PROJECT_NAMES[1];
    const create = await page.request.post(
      `/api/create-project-link?name=${encodeURIComponent(name)}&path=${encodeURIComponent(EXTERNAL_VIDEO)}`,
    );
    expect(create.ok(), await create.text()).toBe(true);

    // 音量調整は原本をプロジェクト内へ複製するためリンク型では拒否される。
    const normalize = await page.request.post(`/api/normalize?id=${encodeURIComponent(name)}`, {
      data: { target: 'standard' },
    });
    expect(normalize.status()).toBe(409);

    // 接続先を消す＝外付けを外した状態。
    rmSync(EXTERNAL_VIDEO, { force: true });

    await page.goto('/');
    await page.locator('.home-card', { hasText: name }).click();
    await expect(page.locator('.vl-banner')).toContainText('元動画が見つかりません', { timeout: 20_000 });

    // 書き出しは開始前に止まる。
    const render = await page.request.post(`/api/render?id=${encodeURIComponent(name)}`, {
      data: { resolution: 'full', quality: 'high' },
    });
    expect(render.status()).toBe(409);

  });
});

// ---------------------------------------------------------------------------
// D&D／ファイル選択の自動リンク化。ブラウザは元パスを渡さないため、サーバが
// 登録済みブラウズルート（SME_BROWSE_ROOTS＝tests/.browse-root）から同一実体を
// 探し、確証が取れたらコピーをやめて symlink 取り込みへ切り替える。
// ---------------------------------------------------------------------------
const AUTO_LINK_NAMES = ['e2e-auto-link-hit', 'e2e-auto-link-miss'] as const;
const AUTO_LINK_VIDEO = resolve(BROWSE_ROOT, 'auto-link-source.mp4');
// 起点の外に置いた素材（＝リンク化されない対照）。
const OUTSIDE_VIDEO = resolve(TMP_DIR, 'outside-source.mp4');

test.describe('アップロードの自動リンク化', () => {
  const cleanup = (): void => {
    for (const n of AUTO_LINK_NAMES) rmSync(resolve(FIXTURES_ROOT, n), { recursive: true, force: true });
  };
  test.beforeAll(() => {
    cleanup();
    mkdirSync(BROWSE_ROOT, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
    // 内容が違う 2 本（testsrc と smptebars）。同名同サイズの偶然一致を作らない。
    execSync(
      `ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -pix_fmt yuv420p "${AUTO_LINK_VIDEO}"`,
      { stdio: 'ignore' },
    );
    execSync(
      `ffmpeg -y -f lavfi -i smptebars=duration=3:size=320x240:rate=30 -pix_fmt yuv420p "${OUTSIDE_VIDEO}"`,
      { stdio: 'ignore' },
    );
  });
  test.afterAll(() => {
    cleanup();
    rmSync(AUTO_LINK_VIDEO, { force: true });
    rmSync(OUTSIDE_VIDEO, { force: true });
  });

  test('登録済みフォルダに同一実体があればコピーせずリンクになる', async ({ page }) => {
    const name = AUTO_LINK_NAMES[0];
    await page.goto('/');
    // ファイル選択は「ブラウザが元パスを渡さない」経路そのもの。中身は外付けの実体と同一。
    await page.locator('[data-testid=home-create-file]').setInputFiles(AUTO_LINK_VIDEO);
    await page.locator('.home-create-name').fill(name);
    await page.locator('.export-start').click();
    await expect(page.locator('.tl-add-menu-btn')).toBeVisible({ timeout: 30_000 });

    const dir = resolve(FIXTURES_ROOT, name);
    expect(lstatSync(resolve(dir, 'public', 'main.mp4')).isSymbolicLink()).toBe(true);
    const record = JSON.parse(
      readFileSync(resolve(dir, '.sme', 'videoLink.json'), 'utf8'),
    ) as { target: string };
    expect(record.target).toBe(AUTO_LINK_VIDEO);
  });

  test('登録済みフォルダに実体が無ければ従来どおりコピーになる', async ({ page }) => {
    const name = AUTO_LINK_NAMES[1];
    await page.goto('/');
    await page.locator('[data-testid=home-create-file]').setInputFiles(OUTSIDE_VIDEO);
    await page.locator('.home-create-name').fill(name);
    await page.locator('.export-start').click();
    await expect(page.locator('.tl-add-menu-btn')).toBeVisible({ timeout: 30_000 });

    const dir = resolve(FIXTURES_ROOT, name);
    expect(lstatSync(resolve(dir, 'public', 'main.mp4')).isSymbolicLink()).toBe(false);
    // リンク化していないプロジェクトには sidecar を生やさない。
    expect(existsSync(resolve(dir, '.sme', 'videoLink.json'))).toBe(false);
  });
});
