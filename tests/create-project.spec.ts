import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeLegacyLinkedProjectFixture } from './fixtures/legacyLinkedProject';

function expectManagedSource(directory:string,source:string):void {
  const saved=JSON.parse(readFileSync(resolve(directory,'.harness/project.v2.json'),'utf8'));
  const document=saved.document??saved;
  expect(document.schemaVersion).toBe(2);expect(document.assets).toHaveLength(1);
  const managed=resolve(directory,document.assets[0].file);
  expect(lstatSync(managed).isSymbolicLink()).toBe(false);
  expect(readFileSync(managed)).toEqual(readFileSync(source));
  expect(existsSync(resolve(directory,'package.json'))).toBe(false);
  expect(existsSync(resolve(directory,'node_modules'))).toBe(false);
}

// ホーム「動画を作成する」の e2e。プロジェクトルート＝__fixtures__ に新規フォルダを
// 作るため、専用名で作成し前後で必ず削除する（他 spec と共有 fixture を汚さない）。
const FIXTURES_ROOT = resolve(import.meta.dirname, '../src/server/__fixtures__');

/**
 * 素材・プロジェクト名に混ぜる **worker 番号**。
 *
 * playwright は 1 ファイルの中のテストを**複数 worker に分けて並列実行**し、
 * `beforeAll` / `afterAll` は **worker ごとに** 走る。だから素材やプロジェクト名を
 * worker 間で共有すると、片方の `afterAll` が**もう片方の実行中の素材を消す**。
 * 実測（本ブランチ・フルスイート 6 ラン目）: `リンク取り込み` の 1 本目が
 * ファイラで `external-source.mp4` を 60s 待って落ちた＝もう一方の worker の
 * `afterAll` が共有素材を消していた。名前に worker 番号を混ぜて所有者を分ける。
 */
const W = process.env['TEST_PARALLEL_INDEX'] ?? '0';
const PROJECT_NAME = `e2e-create-project-tmp-${W}`;
const PROJECT_DIR = resolve(FIXTURES_ROOT, PROJECT_NAME);
const TMP_DIR = resolve(import.meta.dirname, `.create-project-tmp-${W}`);
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

  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });
  expectManagedSource(PROJECT_DIR,SRC_VIDEO);
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
// フォルダ選択も新規作成は管理用コピー。既存の旧リンク案件は別に回帰確認する。
// 走査起点は playwright.config.ts が SME_BROWSE_ROOTS で tests/.browse-root に絞る。
// プロジェクト作成系はこのファイルに集約する（別ファイルで並列に作ると
// fixtures ルートを取り合って他 spec を巻き込む）。
// ---------------------------------------------------------------------------
// 並列テストの作成・削除が別ケースへ影響しないよう名前を分ける。
const LINK_PROJECT_NAMES = [`e2e-link-import-a-${W}`, `e2e-link-import-b-${W}`] as const;
const BROWSE_ROOT = resolve(import.meta.dirname, '.browse-root');
const EXTERNAL_VIDEO_NAME = `external-source-${W}.mp4`;
const EXTERNAL_VIDEO = resolve(BROWSE_ROOT, EXTERNAL_VIDEO_NAME);
/**
 * 「接続先が消える」テスト専用の素材。同 describe 内のテストは**並列に走る**ため、
 * 外付けを外す側が共有素材を消すと、ファイラから選ぶ側が
 * `.mp-file external-source.mp4` を見つけられずタイムアウトする（実測: フルスイート 17 回目）。
 * 消す側には消してよい自前の素材を渡し、共有素材には触らせない。
 */
const BROKEN_LINK_VIDEO = resolve(BROWSE_ROOT, `link-broken-source-${W}.mp4`);

function makeExternalVideo(): void {
  mkdirSync(BROWSE_ROOT, { recursive: true });
  for (const out of [EXTERNAL_VIDEO, BROKEN_LINK_VIDEO]) {
    execSync(
      `ffmpeg -y -f lavfi -i testsrc=duration=1:size=320x240:rate=60 -pix_fmt yuv420p "${out}"`,
      { stdio: 'ignore' },
    );
  }
}

test.describe('リンク取り込み', () => {
  const cleanup = (): void => {
    for (const n of LINK_PROJECT_NAMES) rmSync(resolve(FIXTURES_ROOT, n), { recursive: true, force: true });
  };
  test.beforeAll(() => { cleanup(); makeExternalVideo(); });
  test.afterAll(() => {
    cleanup();
    rmSync(EXTERNAL_VIDEO, { force: true });
    rmSync(BROKEN_LINK_VIDEO, { force: true });
  });

  test('フォルダから選んだ動画を、案内どおり管理用コピーで取り込む', async ({ page }) => {
    await page.goto('/');
    await page.locator('.home-create-link-btn').first().click();

    // ファイラ: 起点 → 動画を選ぶ。
    await expect(page.locator('.mp-dialog')).toBeVisible();
    await page.locator('.mp-root').first().click();
    await page.locator('.mp-file', { hasText: EXTERNAL_VIDEO_NAME }).click();

    // 実際にコピーすることを、作成前に明示する。
    const nameInput = page.locator('.home-create-name');
    await expect(nameInput).toBeVisible();
    await expect(page.locator('.home-create-link-note')).toContainText('編集用のコピー');
    await nameInput.fill(LINK_PROJECT_NAMES[0]);
    await page.locator('.export-start').click();

    await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });
    const dir = resolve(FIXTURES_ROOT, LINK_PROJECT_NAMES[0]);
    expectManagedSource(dir,EXTERNAL_VIDEO);
  });

  test('リンクが切れると警告バナーが出て、音量調整と書き出しは止まる', async ({ page }) => {
    const name = LINK_PROJECT_NAMES[1];
    // Historical fixture construction only: the retired HTTP API must not create
    // new legacy projects. Existing linked-project recovery remains covered.
    writeLegacyLinkedProjectFixture(resolve(FIXTURES_ROOT, name), BROKEN_LINK_VIDEO);

    // 音量調整は原本をプロジェクト内へ複製するためリンク型では拒否される。
    const normalize = await page.request.post(`/api/normalize?id=${encodeURIComponent(name)}`, {
      data: { target: 'standard' },
    });
    expect(normalize.status()).toBe(409);

    // 接続先を消す＝外付けを外した状態（消すのは自分専用の素材のみ）。
    rmSync(BROKEN_LINK_VIDEO, { force: true });

    await page.goto('/?legacy=1');
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
// アップロードは所在によらず管理用コピーを作る。コピーしない旧自動リンクは退役。
// ---------------------------------------------------------------------------
const AUTO_LINK_NAMES = [`e2e-auto-link-hit-${W}`, `e2e-auto-link-miss-${W}`] as const;
const AUTO_LINK_VIDEO = resolve(BROWSE_ROOT, `auto-link-source-${W}.mp4`);
// 起点の外に置いた素材（＝リンク化されない対照）。
const OUTSIDE_VIDEO = resolve(TMP_DIR, 'outside-source.mp4');

test.describe('アップロードの管理用コピー', () => {
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

  test('登録済みフォルダに同一実体があっても案内どおりコピーする', async ({ page }) => {
    const name = AUTO_LINK_NAMES[0];
    await page.goto('/');
    // ファイル選択は「ブラウザが元パスを渡さない」経路そのもの。中身は外付けの実体と同一。
    await page.locator('[data-testid=home-create-file]').setInputFiles(AUTO_LINK_VIDEO);
    await page.locator('.home-create-name').fill(name);
    await page.locator('.export-start').click();
    await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });

    const dir = resolve(FIXTURES_ROOT, name);
    expectManagedSource(dir,AUTO_LINK_VIDEO);
  });

  test('登録済みフォルダに実体が無ければ従来どおりコピーになる', async ({ page }) => {
    const name = AUTO_LINK_NAMES[1];
    await page.goto('/');
    await page.locator('[data-testid=home-create-file]').setInputFiles(OUTSIDE_VIDEO);
    await page.locator('.home-create-name').fill(name);
    await page.locator('.export-start').click();
    await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });

    const dir = resolve(FIXTURES_ROOT, name);
    expectManagedSource(dir,OUTSIDE_VIDEO);
    // リンク化していないプロジェクトには sidecar を生やさない。
    expect(existsSync(resolve(dir, '.sme', 'videoLink.json'))).toBe(false);
  });
});
