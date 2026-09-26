import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createTempProject, PRISTINE_SAMPLE_PROJECT, removeTempProject } from './helpers';

/** ＋追加メニューを開いて項目をクリックする（UI リフレッシュでメニュー集約されたため）。 */
async function clickAddMenuItem(page: Page, selector: string): Promise<void> {
  await page.locator('.tl-add-menu-btn').click();
  await page.locator(selector).click();
}

// スモークが保存操作でフィクスチャを書き換えた場合に pristine へ戻す。
// git checkout -- <dir> で tracked ファイルの変更を戻し、
// git clean -fdx <dir> で untracked な新規ファイル（cutData.ts 等）と
// gitignore 済み sidecar（cut-baseline.json / cutLearning.json）を削除する。
const FIXTURE_DIR = resolve(import.meta.dirname, '../src/server/__fixtures__/sample-project');
const FIXTURES_ROOT = resolve(import.meta.dirname, '../src/server/__fixtures__');

test.afterEach(() => {
  try {
    execSync(`git checkout -- "${FIXTURE_DIR}"`, { stdio: 'ignore' });
    // -x も付けて gitignore 済みの sidecar（cut-baseline.json / cutLearning.json）まで消す。
    // これを消さないと、保存系テストが実フィクスチャに残した sidecar を
    // saveProject.test.ts の withProjectCopy が拾い、別テストを汚染する。
    execSync(`git clean -fdx "${FIXTURE_DIR}"`, { stdio: 'ignore' });
  } catch {
    // git 管理外環境（CI キャッシュなど）では無視する
  }
});

test('エディタが起動し、プロジェクトを開いてプレビューがマウントされる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    // フィクスチャの main.mp4 は 62 バイトのスタブのため Remotion が MediaPlaybackError を
    // スローする。これは UI の問題ではないのでフィルタアウトする。
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');

  // 6ゾーンシェルが出る
  await expect(page.locator('.app')).toBeVisible();

  // フォルダブラウザにフィクスチャプロジェクトが並ぶ
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });

  // 開く
  await item.click();

  // プレビュー（Remotion Player）がマウントされる
  await expect(page.locator('.pv-stage')).toBeVisible();
  // Remotion Player は内部で <audio display:none> を複数挿入するため、
  // ワイルドカードの .first() ではなく __remotion-player div を待つ。
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 読込エラー表示が出ていない
  await expect(page.locator('.pv .sme-error')).toHaveCount(0);

  // 文字起こしパネルに行が出る
  await expect(page.locator('.tx-row').first()).toBeVisible();

  // JS の未捕捉例外が無い
  expect(pageErrors).toEqual([]);
});

test('タイムラインが表示され、カットつまみのドラッグとズームができる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // タイムライン本体が出る（ルーラー＋トラック）。
  await expect(page.locator('.tl-ruler')).toBeVisible();
  await expect(page.locator('.tl-track-cut')).toBeVisible();
  await expect(page.locator('.tl-track-telop')).toBeVisible();

  // 総尺ラベルが出る。
  await expect(page.locator('.tl-total')).toBeVisible();

  // ズームインボタンでトラック幅が広がる。
  const scroll = page.locator('.tl-scroll');
  const widthBefore = await scroll.evaluate((el) => el.getBoundingClientRect().width);
  await page.locator('.tl-zoom button[title^="ズームイン"]').click();
  const widthAfter = await scroll.evaluate((el) => el.getBoundingClientRect().width);
  expect(widthAfter).toBeGreaterThan(widthBefore);

  // 単語をカットしてカットブロックを出す（タイムラインのつまみドラッグ前提）。
  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  const chip = page.locator('.tx-row.selected .tx-chip').first();
  if (await chip.count() > 0) {
    await chip.click();
    // 動画トラックにカットブロックが出る。
    const cut = page.locator('.tl-cut').first();
    await expect(cut).toBeVisible();

    // カット終了端のつまみをドラッグする。
    const handle = cut.locator('.tl-handle.end');
    const box = await handle.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2, { steps: 4 });
      // ドラッグ中ツールチップが出る。
      await expect(page.locator('.tl-tooltip')).toBeVisible();
      await page.mouse.up();
    }
  }

  // JS の未捕捉例外が無い。
  expect(pageErrors).toEqual([]);
});

test('テロップを選択し文字を直し、単語をカットし、Undo・保存ができる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 最初の行を選択 → 編集テキストエリアが出る
  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  const editor = page.locator('.tx-row.selected .tx-text-edit');
  await expect(editor).toBeVisible();

  // 文字を直す → 未保存インジケータが出る
  await editor.fill('スモーク編集テスト');
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 保存ボタンが有効になる
  const saveBtn = page.locator('.tb-save.enabled');
  await expect(saveBtn).toBeVisible();

  // Undo で「保存済み」へ戻る
  await page.locator('.tb-icon-btn[title*="元に戻す"]').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible();

  // インスペクタにテロップスタイル節が出る（設定タブ。未導入=CTA ボタン、導入済み=スタイル一覧）。
  await firstRow.click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await expect(page.locator('.rightdock-body .ins').locator('.ins-pack-install, .ins-style-grid').first()).toBeVisible();

  // 文字起こしタブへ戻る（選択は維持）。単語チップがあればカットできる（無い場合はスキップ）。
  await page.locator('.rightdock-tab[data-tab="transcript"]').click();
  // このテストは word timing データを持つ sample-project フィクスチャを前提とする。
  // チップが無いフィクスチャに差し替えると保存前後の前提が崩れるため注意。
  const chip = page.locator('.tx-row.selected .tx-chip').first();
  if (await chip.count() > 0) {
    await chip.click();
    await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();
  }

  // 保存を実行 → 保存後「保存済み」に戻る（保存に成功するかエラー表示が出ないこと）
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

// 変換バナー系4件は cutData.ts を生 fs で unlink/生成し、afterEach で
// git checkout -- / git clean -fdx により FIXTURE_DIR（sample-project）を巻き戻す。
//
// 根本原因（実測・フルスイート時のみ再現）: webServer は全 worker で単一プロセス共有であり、
// server 側の watchProject() は開いているプロジェクトの cutData.ts を chokidar で監視して
// 「外部更新」を検知する。この4テストが sample-project 上で行う生 unlink / git checkout /
// git clean はどれも selfWrite 経由ではない外部変更として watchProject に見えるため、
// default project は複数 worker が異なる spec ファイルを並列実行しており、その瞬間に
// 別の worker が同じ sample-project を開いていると（render-button.spec.ts の保存フロー、
// timeline-speed-stretch.spec.ts の .tl-kept-segment 読み取り等）、無関係なそのテストの
// 足元で cutData.ts が消えたり戻ったりし、外部更新の検知・再読込に巻き込まれて落ちる。
// フルスイートでは「どの3件が落ちるか」が実行順で変わる（実測: 単独実行では100 passed、
// production 側では代わりに本 describe の最後のテストが落ちた）のはこの共有可変状態の証拠。
//
// 対策: この4テストは共有 sample-project を一切 mutate せず、beforeEach で
// tests/learning-diff.spec.ts と同型の使い捨てコピー（`conv-tmp-*`、.gitignore 済み）へ
// 隔離する。他 spec が同時に sample-project を開いていても、この4テストの cutData.ts
// 増減がそちらの watchProject に見えることは無くなる。
test.describe('変換バナー（cutData.ts 不在系・専用フィクスチャ隔離）', () => {
  let convId = '';
  let convDir = '';

  test.beforeEach(() => {
    convId = `conv-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    convDir = resolve(FIXTURES_ROOT, convId);
    // 複製元は pristine スナップショット（helpers.ts の PRISTINE_SAMPLE_PROJECT）。
    // 共有 sample-project から複製すると、他 spec の git checkout/clean と重なった回に
    // 壊れたコピーができる（実測: 開いたエディタが telopData.ts の読み込みで停止）。
    cpSync(PRISTINE_SAMPLE_PROJECT, convDir, { recursive: true });
    // 複製直後に cutData.ts を削除して「不在プロジェクト」の初期状態にする。
    try { unlinkSync(resolve(convDir, 'src', 'cutData.ts')); } catch { /* 既に無い */ }
  });

  test.afterEach(() => {
    rmSync(convDir, { recursive: true, force: true });
  });

  test('cutData.ts 不在プロジェクトで変換バナーが出て、変換すると消える', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => {
      const msg = String(err);
      if (msg.includes('MediaPlaybackError')) return;
      pageErrors.push(msg);
    });

    await page.goto('/');
    const item = page.locator('.home-card', { hasText: convId });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.click();

    // cutData.ts を削除済みのためバナーが出る。
    // プレビューマウントに依存しないことを確認するため、ここで先にアサートする。
    const banner = page.locator('.conv-banner');
    await expect(banner).toBeVisible();

    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

    // バナー表示中もプレビュー領域が潰れていないことを確認する（グリッド退行の検知）。
    const pvStageBox = await page.locator('.pv-stage').boundingBox();
    expect(pvStageBox).not.toBeNull();
    expect(pvStageBox!.height).toBeGreaterThan(250);

    // 変換を実行 → 再読込後にバナーが消える。
    await page.locator('.conv-banner-btn').click();
    await expect(banner).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

    expect(pageErrors).toEqual([]);
  });

  test('変換が失敗するとエラーが表示され、ボタンが再び押せる', async ({ page }) => {
    // 変換 API を遮断して失敗パスを再現する。
    await page.route('**/api/convert-burned-in*', (r) => r.abort());

    await page.goto('/');
    const item = page.locator('.home-card', { hasText: convId });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.click();

    const banner = page.locator('.conv-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });

    await page.locator('.conv-banner-btn').click();
    await expect(page.locator('.conv-banner-error')).toBeVisible();
    await expect(page.locator('.conv-banner-btn')).toBeEnabled();
  });

  test('変換中に別プロジェクトへ切り替えると、遅れて届いたエラーは表示されない', async ({ page }) => {
    // 変換 API を gate で保留し、プロジェクト切替の完了後に失敗を着地させる
    // （固定 sleep だと遅いマシンで着地が切替より先になり、競合を再現できないまま緑になる）。
    let releaseConvert!: () => void;
    const convertGate = new Promise<void>((r) => { releaseConvert = r; });
    await page.route('**/api/convert-burned-in*', async (r) => {
      await convertGate;
      await r.abort();
    });

    await page.goto('/');
    const sample = page.locator('.home-card', { hasText: convId });
    await expect(sample).toBeVisible({ timeout: 15_000 });
    await sample.click();

    const banner = page.locator('.conv-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    const convertFailed = page.waitForEvent('requestfailed', {
      predicate: (req) => req.url().includes('/api/convert-burned-in'),
      timeout: 15_000,
    });
    await page.locator('.conv-banner-btn').click();

    // 別プロジェクトへの切替完了を確認してからエラーを着地させる
    // （misaligned-project も cutData 無し＝バナーが出る。こちらは静的フィクスチャで
    // どのテストも書き換えないため共有のままで安全）。
    // 編集中の切替はサイドバー（.fb-item）経由（ホームはサイドバー非表示だが、ここはエディタ表示中）。
    const misaligned = page.locator('.fb-item', { hasText: 'misaligned-project' });
    await misaligned.click();
    await expect(misaligned).toHaveClass(/active/, { timeout: 20_000 });
    releaseConvert();
    await convertFailed;

    // エラー着地後も、切替先のバナーには前プロジェクトのエラーが出ない。
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(300);
    await expect(page.locator('.conv-banner-error')).toHaveCount(0);
  });

  test('変換中に別プロジェクトへ切り替えると、変換成功後も切替先に留まる', async ({ page }) => {
    // 変換 API を gate で保留し、プロジェクト切替の完了後に成功を着地させる。
    let releaseConvert!: () => void;
    const convertGate = new Promise<void>((r) => { releaseConvert = r; });
    await page.route('**/api/convert-burned-in*', async (r) => {
      await convertGate;
      await r.continue();
    });

    await page.goto('/');
    const sample = page.locator('.home-card', { hasText: convId });
    await expect(sample).toBeVisible({ timeout: 15_000 });
    await sample.click();

    const banner = page.locator('.conv-banner');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    const convertDone = page.waitForResponse(
      (res) => res.url().includes('/api/convert-burned-in'),
      { timeout: 15_000 },
    );
    await page.locator('.conv-banner-btn').click();

    // 別プロジェクトへの切替完了を確認してから成功を着地させる。
    // 編集中の切替はサイドバー（.fb-item）経由（ホームはサイドバー非表示だが、ここはエディタ表示中）。
    const misaligned = page.locator('.fb-item', { hasText: 'misaligned-project' });
    await misaligned.click();
    await expect(misaligned).toHaveClass(/active/, { timeout: 20_000 });
    releaseConvert();
    const convertRes = await convertDone;
    expect(convertRes.ok()).toBe(true);

    // 変換自体は成功している（プロジェクト直下に cutData.ts が生成された）ことを固定した上で、
    // 成功が着地しても前プロジェクトへ勝手に引き戻されないことを確認する。
    await expect.poll(() => existsSync(resolve(convDir, 'cutData.ts')), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(300);
    await expect(misaligned).toHaveClass(/active/);
    await expect(page.locator('.fb-item', { hasText: convId })).not.toHaveClass(/active/);
  });
});

test('テロップを選択するとプレビューに操作ボックスが出て、ドラッグできる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // テロップ未選択時は操作ボックスが無い。
  await expect(page.locator('.pv-telop-box')).toHaveCount(0);

  // 最初の行を選択 → 操作ボックスと四隅ハンドルが出る。
  await page.locator('.tx-row').first().click();
  const box = page.locator('.pv-telop-box');
  await expect(box).toBeVisible();
  await expect(page.locator('.pv-handle')).toHaveCount(4);

  // フィクスチャの Telop.tsx は react-dom を default / named の両形式で直接
  // import しており、import map (runtime/react-dom.ts) 経由で同一インスタンスに
  // 解決されたことを data 属性で観測する（R-10: react-dom 未検証パスの回帰防止）。
  await expect(
    page.locator('.__remotion-player [data-reactdom-ok]').first()
  ).toHaveAttribute('data-reactdom-ok', 'yes', { timeout: 10_000 });

  // 本体をドラッグする → ガイド線が一時表示され、位置が変化する。
  // 掴む点は枠の中心ではなく**移動ドラッグ面**（.pv-telop-grab）。2026-08-19 の実測方式で
  // 枠が実際の文字の高さ（薄い）になり、下端がプレイヤーのコントロール帯にかかると
  // 掴み面は枠の上へ逃げる（帯を侵さない設計）。枠中心は掴み面の外に出うる。
  const bBefore = await box.boundingBox();
  expect(bBefore).not.toBeNull();
  const grabBox = await page.locator('.pv-telop-grab').boundingBox();
  expect(grabBox).not.toBeNull();
  if (grabBox) {
    const gx = grabBox.x + grabBox.width / 2;
    const gy = grabBox.y + grabBox.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx + 40, gy - 30, { steps: 5 });
    await expect(page.locator('.pv-guide').first()).toBeVisible();
    await page.mouse.up();
  }
  // ドラッグ後に位置が変化したことを検証する（5px 以上の変化を期待）。
  const bAfter = await box.boundingBox();
  expect(bAfter).not.toBeNull();
  expect(
    Math.abs(bAfter!.x - bBefore!.x) + Math.abs(bAfter!.y - bBefore!.y)
  ).toBeGreaterThanOrEqual(5);

  // 四隅ハンドルでスケールドラッグする。
  const handle = page.locator('.pv-handle.se');
  const hb = await handle.boundingBox();
  expect(hb).not.toBeNull();
  // スケールドラッグ前のサイズを記録する。
  const boxBeforeScale = await box.boundingBox();
  expect(boxBeforeScale).not.toBeNull();
  if (hb) {
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2 + 30, hb.y + hb.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
  }
  // ドラッグ後にサイズが変化したことを検証する（5px 以上の変化を期待）。
  const boxAfterScale = await box.boundingBox();
  expect(boxAfterScale).not.toBeNull();
  expect(
    Math.abs(boxAfterScale!.width - boxBeforeScale!.width) +
    Math.abs(boxAfterScale!.height - boxBeforeScale!.height)
  ).toBeGreaterThanOrEqual(5);

  expect(pageErrors).toEqual([]);
});

test('SE トラックのクリップ選択・ドラッグ・追加・保存ができる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // SE トラックとフィクスチャの SE クリップが出る。
  await expect(page.locator('.tl-track-se')).toBeVisible();
  const pin = page.locator('.tl-se-clip').first();
  await expect(pin).toBeVisible();

  // クリップを選択 → インスペクタに SE 設定（再生フレーム入力）が出る。
  await pin.click();
  await expect(page.locator('#ins-se-frame')).toBeVisible();

  // クリップをドラッグ → ツールチップが出て未保存になる。
  const box = await pin.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 4 });
    await expect(page.locator('.tl-tooltip')).toBeVisible();
    await page.mouse.up();
  }
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // ＋SE で SE クリップが 1 つ増える。
  const before = await page.locator('.tl-se-clip').count();
  await clickAddMenuItem(page, '.tl-se-add');
  await expect(page.locator('.tl-se-clip')).toHaveCount(before + 1);

  // 保存 → 「保存済み」へ戻り、保存エラーが出ない。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('画像トラックのブロック選択・ドラッグ・追加・保存ができる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 画像トラックとフィクスチャの画像ブロックが出る。
  await expect(page.locator('.tl-track-image')).toBeVisible();
  const block = page.locator('.tl-image-block').first();
  await expect(block).toBeVisible();

  // ブロックを選択 → インスペクタに画像設定（開始フレーム入力）が出る。
  await block.click();
  await expect(page.locator('#ins-image-start')).toBeVisible();
  await expect(page.locator('#ins-image-end')).toBeVisible();

  // ブロック本体をドラッグ → ツールチップが出て未保存になる。
  const box = await block.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    // ブロック中央（端つまみではない本体）をつかむ。
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 4 });
    await expect(page.locator('.tl-tooltip')).toBeVisible();
    await page.mouse.up();
  }
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // ＋画像で画像ブロックが 1 つ増える。
  const before = await page.locator('.tl-image-block').count();
  await clickAddMenuItem(page, '.tl-image-add');
  await expect(page.locator('.tl-image-block')).toHaveCount(before + 1);

  // 保存 → 「保存済み」へ戻り、保存エラーが出ない。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('外部で telopData.ts を書き換えると外部更新バナーが出て、再読込で消える', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // この時点ではバナーは出ていない。
  await expect(page.locator('.ext-banner')).toHaveCount(0);

  // フィクスチャの telopData.ts を「外部から」書き換える。chokidar は watch しているため
  // SSE 経由でクライアントへ change イベントが流れる（debounce 500ms + 通信分の遅延）。
  const telopPath = resolve(FIXTURE_DIR, 'src', 'テロップテンプレート', 'telopData.ts');
  const original = readFileSync(telopPath, 'utf8');
  writeFileSync(telopPath, original + '\n// 外部編集スモーク\n', 'utf8');

  // chokidar の debounce + クライアント反映分のマージンで 5 秒待つ。
  await expect(page.locator('.ext-banner')).toBeVisible({ timeout: 5_000 });

  // 再読込ボタンを押すとバナーが消え、プレビューが再マウントされる。
  await page.locator('.ext-banner-btn').click();
  await expect(page.locator('.ext-banner')).toHaveCount(0);
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 既存 afterEach（git checkout / clean）がフィクスチャを pristine へ戻す。
  expect(pageErrors).toEqual([]);
});

/*
 * このテストは 2.5 秒のあいだ「外部更新バナーが出ないこと」を見る。共有フィクスチャ
 * sample-project を開いていると、**別 worker の afterEach**（heavy-job-confirm /
 * motion / per-segment-* / split-newline / 本ファイルの `git checkout -- && git clean -fdx`）
 * がその窓に入った瞬間、watchProject が sample-project/src/cutData.ts の変更を検知して
 * バナーを出す（実測: サーバログに `watchProject notified: .../sample-project/src/cutData.ts`）。
 * 検査したいのは「自分の保存が自分にバナーを出さないか」なので、対象を専用コピーへずらす。
 */
test('自分の保存は外部更新バナーを誘発しない', async ({ page, request }) => {
  const { id, dir } = createTempProject('self-save-tmp');
  try {
    await page.goto('/');
    const item = page.locator('.home-card', { hasText: id });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.click();
    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

    // GET でプロジェクト現状を取得し、{ project, fingerprint } を PUT ボディとして組み立てる。
    // GET レスポンスの LoadedProject には save.fingerprint が含まれるため、
    // これをそのまま SaveRequest として再送できる（内容変更なし = 指紋照合も通る）。
    const getResp = await request.get(`/api/project?id=${id}`);
    expect(getResp.ok()).toBe(true);
    const loaded = await getResp.json();
    const putBody = { project: loaded.project, fingerprint: loaded.save.fingerprint };
    const putResp = await request.put(`/api/project?id=${id}`, { data: putBody });
    expect(putResp.ok()).toBe(true);

    // chokidar debounce (500ms) + 自己保存ウィンドウ (1500ms) + マージンで 2.5 秒待つ。
    // この間に外部更新バナーが出てはいけない。
    await page.waitForTimeout(2_500);
    await expect(page.locator('.ext-banner')).toHaveCount(0);
  } finally {
    await page.close();
    removeTempProject(dir);
  }
});

// misaligned-project フィクスチャのクリーンアップ。
// 再 transcribe の POST が transcript.backup-* を生成するため、afterEach で除去する。
const MISALIGNED_FIXTURE_DIR = resolve(import.meta.dirname, '../src/server/__fixtures__/misaligned-project');

test.afterEach(() => {
  try {
    execSync(`git checkout -- "${MISALIGNED_FIXTURE_DIR}"`, { stdio: 'ignore' });
    // -x も付けて gitignore 済みの sidecar（cut-baseline.json 等）まで消す。
    // これを消さないと load 時に生成された baseline が残り、別テストを汚染する。
    execSync(`git clean -fdx "${MISALIGNED_FIXTURE_DIR}"`, { stdio: 'ignore' });
  } catch {
    // git 管理外環境では無視
  }
});

test('焼き込み済みプロジェクトで「再 transcribe」を実行し反映できる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'misaligned-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();

  // 不整合バナーが出る
  const banner = page.locator('.tx-misalign');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('単語チップ');

  // 再 transcribe ボタンを押す
  await page.getByRole('button', { name: /transcript を作り直す/ }).click();

  // 進捗 → 完了 → 「再読込」ボタンが出る（mock 完了は ~8s。負荷時の余裕込みで 15s 待つ）
  await expect(page.getByRole('button', { name: /再読込/ })).toBeVisible({ timeout: 15_000 });

  // 完了文言を assert（reload 前にやる必要がある — reload で component が remount するため）
  await expect(banner).toContainText(/再 transcribe 完了/);

  // 再読込を押すとプロジェクトが再ロードされる
  await page.getByRole('button', { name: /再読込/ }).click();

  // 再読込後、mock 出力（duration_ms=116000）と video（200000ms）はまだ不整合のため、
  // バナーは idle 状態でもう一度出る。完了状態は保持されないがそれは想定挙動。
  // 真の aligned 状態は手動テスト（drill-01 で実 Whisper を回す）に委ねる。
  await expect(banner).toContainText('単語チップ');
});

test('再 transcribe 実行中にキャンセルすると元状態へ戻る', async ({ page, request }) => {
  // 前テストの残留ジョブをクリア（running 中の場合はキャンセル、completed は discard される）。
  // 空振り（404）は無視する。
  await request.delete('/api/transcribe?id=misaligned-project').catch(() => {});

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'misaligned-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();

  // 不整合バナーが出るのを待ってからボタンを押す（バナー出現前にクリックすると見つからない）。
  // バナーが「completed」残留状態の場合は「再読込」を押して idle に戻す。
  const banner = page.locator('.tx-misalign');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  const reloadFromCompleted = page.getByRole('button', { name: /再読込/ });
  if (await reloadFromCompleted.isVisible()) {
    await reloadFromCompleted.click();
    // 再読込後に不整合バナーが idle 状態（「単語チップ」テキスト）で再出現するのを待つ。
    await expect(banner).toContainText('単語チップ', { timeout: 15_000 });
  }

  await page.getByRole('button', { name: /transcript を作り直す/ }).click();

  // 進捗中（数秒のディレイがある）にキャンセル
  const cancelBtn = page.getByRole('button', { name: /キャンセル/ });
  await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
  await cancelBtn.click();

  // キャンセル後はバナーが「キャンセルしました」表示になる
  // （TranscribeBanner は cancelled 状態のままで auto-reset しない実装のため）
  await expect(page.locator('.tx-misalign')).toContainText('キャンセルしました', { timeout: 5_000 });
});

test('タイムライン直接操作: 範囲選択カット・ルーラースクラブ・ヘッドで分割', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // --- 範囲選択カット: 動画トラック背景をドラッグ → 選択帯 → 「カット」ボタン ---
  const cutTrack = page.locator('.tl-track-cut');
  const box = await cutTrack.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    // box.x + 144 は sticky な「動画」ラベル（pointer-events:none・88px）を十分に越えた位置。
    // ガターを 64→88px に拡げたぶん各クリック X も +24 して同じ原本フレームへ当てる。
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 144, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 204, y, { steps: 5 });
    await expect(page.locator('.tl-cut-selection')).toBeVisible();
    await page.mouse.up();
    const cutBtn = page.locator('.tl-cut-confirm');
    await expect(cutBtn).toBeEnabled();
    await cutBtn.click();
    await expect(page.locator('.tl-cut').first()).toBeVisible();
  }

  // --- スクラブ: ルーラーをドラッグ → 再生ヘッドが動く ---
  const ruler = page.locator('.tl-ruler');
  const headBefore = await page.locator('.tl-playhead').boundingBox();
  const rbox = await ruler.boundingBox();
  expect(rbox).not.toBeNull();
  expect(headBefore).not.toBeNull();
  if (rbox && headBefore) {
    await page.mouse.move(rbox.x + 40, rbox.y + rbox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rbox.x + 160, rbox.y + rbox.height / 2, { steps: 5 });
    await page.mouse.up();
    const headAfter = await page.locator('.tl-playhead').boundingBox();
    expect(headAfter!.x).toBeGreaterThan(headBefore.x);
  }

  // --- ヘッドで分割: 再生ヘッドをテロップ1（原本[30,150)・pxPerFrame=1 で x≈90）内へ
  //     頭出ししてから分割 → セグメント行が増える ---
  const rowsBefore = await page.locator('.tx-row').count();
  const rbox2 = await ruler.boundingBox();
  expect(rbox2).not.toBeNull();
  if (rbox2) {
    // ガター(88px)分を引いて content-x=178 → frame 90（テロップ1 [30,150) 内）。
    await page.mouse.click(rbox2.x + 178, rbox2.y + rbox2.height / 2);
  }
  const splitBtn = page.locator('.tl-split');
  await expect(splitBtn).toBeEnabled(); // ヘッド下にテロップ1があるので有効になる
  await splitBtn.click();
  await expect(page.locator('.tx-row')).toHaveCount(rowsBefore + 1);

  expect(pageErrors).toEqual([]);
});

test('タイムライン直接操作: 縦ホイールは横スクロールしない・Shift＋ホイールで横スクロール', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const zoomIn = page.locator('.tl-zoom button[title^="ズームイン"]');
  for (let i = 0; i < 4; i++) await zoomIn.click();

  const body = page.locator('.tl-body');
  const before = await body.evaluate((el) => el.scrollLeft);
  await body.hover();

  // 素の縦ホイールは横スクロールを奪わない（縦スクロール＝素材トラック閲覧に委ねる）。
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(150);
  expect(await body.evaluate((el) => el.scrollLeft)).toBe(before);

  // Shift＋縦ホイールは横スクロールへ変換する。
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 400);
  await page.keyboard.up('Shift');
  await expect.poll(async () => body.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);

  expect(pageErrors).toEqual([]);
});

test('範囲選択カット: フローティング✂ボタンでカット・Escで解除・Deleteでカット', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const cutTrack = page.locator('.tl-track-cut');
  const box = await cutTrack.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const y = box.y + box.height / 2;

  // ガター(88px)分を各クリック X から引く（content-x − 88 が原本フレームに対応）。
  // --- 範囲選択 → 離す → フローティング✂ボタンが出る（content-x 184-244 → frame 96-156）---
  await page.mouse.move(box.x + 184, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 244, y, { steps: 5 });
  await page.mouse.up();
  const fab = page.locator('.tl-cut-fab-btn');
  await expect(fab).toBeVisible();

  // --- ✂ボタンをクリック → カット成立 → フローティングは消える ---
  await fab.click();
  await expect(page.locator('.tl-cut').first()).toBeVisible();
  await expect(page.locator('.tl-cut-fab')).toHaveCount(0);

  // --- 再度選択 → Esc → フローティングが消える（カットは増えない）---
  // 上のカット帯（吸着で content-x ~308 まで伸びる）と重ならない素材上を選ぶため content-x 360-420。
  const cutsBefore = await page.locator('.tl-cut').count();
  await page.mouse.move(box.x + 360, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.tl-cut-fab-btn')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tl-cut-fab')).toHaveCount(0);
  expect(await page.locator('.tl-cut').count()).toBe(cutsBefore);

  // --- 再度選択 → Delete → カット成立（前回未カバーの経路）---
  await page.mouse.move(box.x + 360, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.tl-cut-fab-btn')).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(page.locator('.tl-cut-fab')).toHaveCount(0);
  expect(await page.locator('.tl-cut').count()).toBeGreaterThan(cutsBefore);

  expect(pageErrors).toEqual([]);
});

test('テロップパック: 導入→スタイル選択→全体適用→保存→再読込で保持', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 最初のテロップ行を選択 → 設定タブに未導入なら導入 CTA が出る。
  await page.locator('.tx-row').first().click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  const installBtn = page.locator('.ins-telop-pack-install');
  await expect(installBtn).toBeVisible();
  await installBtn.click();

  // 導入後、再読込されて 35 一覧が出る（プレビュー再マウントを待つ）。
  // 導入はアプリ内リロードのため設定タブのまま＝一覧が隠れる。文字起こしタブへ戻ってから選択。
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await page.locator('.rightdock-tab[data-tab="transcript"]').click();
  await page.locator('.tx-row').first().click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  const cells = page.locator('.ins-style-cell');
  await expect(cells).toHaveCount(35);

  // スウォッチは IntersectionObserver で遅延マウントするため、まずビューへ入れる。
  await cells.first().scrollIntoViewIfNeeded();
  // スウォッチが実際に描画されている（CellBoundary フォールバックでなく Thumbnail がマウント）。
  await expect(page.locator('.ins-style-cell .swatch-fit').first()).toBeVisible();

  // 2番目のスタイルをクリック → アクティブになる（＝ template 反映）。
  await cells.nth(1).click();
  await expect(cells.nth(1)).toHaveClass(/active/);

  // 全体に適用 → 保存。
  await page.locator('.ins-style-apply-all').click();
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  // 再読込で導入状態とスタイルが保持される（CTA でなく一覧が出る）。
  await page.reload();
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await page.locator('.tx-row').first().click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await expect(page.locator('.ins-style-cell')).toHaveCount(35);
  // 保存した template（全体適用で id=2）が再読込後も該当セルに反映されている。
  await expect(page.locator('.ins-style-cell').nth(1)).toHaveClass(/active/);

  expect(pageErrors).toEqual([]);
});

test('波形カンバスが表示され、単語チップのホバーでハイライト帯が出る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    // スタブ main.mp4 由来の Remotion 再生エラーは UI の問題ではないので除外。
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 動画トラック背面に波形カンバスがマウントされる（スタブ動画でも要素は存在する）。
  await expect(page.locator('.tl-track-cut .tl-waveform')).toBeAttached();

  // 最初のテロップ行を選択 → 単語チップが出れば hover でハイライト帯が出る。
  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  // sample-project は word timing を持つフィクスチャで、先頭テロップは単語と重なる。
  // よって先頭行は必ずチップを持つ（無条件で検証し、フィクスチャ退行を loud に検知する）。
  const chip = page.locator('.tx-row.selected .tx-chip').first();
  await expect(chip).toBeVisible();
  await chip.hover();
  await expect(page.locator('.tl-hl-marker')).toBeVisible();
  // ポインタを画面外へ動かすとハイライト帯が消える。
  await page.mouse.move(0, 0);
  await expect(page.locator('.tl-hl-marker')).toHaveCount(0);

  // JS の未捕捉例外が無い（波形デコード失敗が pageerror にならないこと）。
  expect(pageErrors).toEqual([]);
});

test('タイムライン高さ: ハンドルでリサイズ・永続・ダブルクリックでリセット', async ({ page }) => {
  // localStorage の明示クリアは不要: Playwright はテストごとに新規 BrowserContext を作り
  // localStorage は空から始まる（独立性が保証される）。reload は同一コンテキスト内なので
  // 永続値は残り、永続検証が成立する。
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const resizer = page.locator('.tl-resizer');
  await expect(resizer).toBeVisible();
  const initial = (await page.locator('.tl').boundingBox())!.height;

  // --- 上へドラッグ → 高くなる ---
  const rb = (await resizer.boundingBox())!;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2, rb.y - 80, { steps: 8 });
  await page.mouse.up();
  const taller = (await page.locator('.tl').boundingBox())!.height;
  expect(taller).toBeGreaterThan(initial + 40); // 80px 上ドラッグ→最低 40px は増える（十分なマージン）

  // --- リロードで永続 ---
  // ホーム（未選択）はカンバン専用モードでタイムライン非表示のため、
  // プロジェクトを開き直してから高さを測る（永続値 --timeline-h の検証は同じ）。
  await page.reload();
  const item2 = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item2).toBeVisible({ timeout: 15_000 });
  await item2.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  const afterReload = (await page.locator('.tl').boundingBox())!.height;
  expect(afterReload).toBeGreaterThan(initial + 40);

  // --- ダブルクリックでリセット → 既定（≈初期）へ ---
  await page.locator('.tl-resizer').dblclick();
  const reset = (await page.locator('.tl').boundingBox())!.height;
  expect(Math.abs(reset - initial)).toBeLessThan(4); // 既定 240 へ戻る（±4px は border/丸め誤差の許容）

  // --- 下げすぎても最小 192 でクランプ（既定 240 より低くはできるが 192 未満にならない） ---
  const rb2 = (await page.locator('.tl-resizer').boundingBox())!;
  await page.mouse.move(rb2.x + rb2.width / 2, rb2.y + rb2.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb2.x + rb2.width / 2, rb2.y + 400, { steps: 8 });
  await page.mouse.up();
  const clamped = (await page.locator('.tl').boundingBox())!.height;
  expect(clamped).toBeGreaterThanOrEqual(192 - 4);
  expect(clamped).toBeLessThan(initial); // MIN(192) < 既定(240) なので下げられること自体も確認

  expect(pageErrors).toEqual([]);
});

test('重なる画像が複数レーン（異なる縦位置）で表示される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const blocks = page.locator('.tl-image-block');
  const before = await blocks.count();

  // 再生ヘッド位置に画像を 2 回追加 → 同区間 [p, p+120) が 2 つ＝必ず重なる。
  await clickAddMenuItem(page, '.tl-image-add');
  await clickAddMenuItem(page, '.tl-image-add');
  await expect(blocks).toHaveCount(before + 2);

  // 追加した末尾 2 ブロックは同区間で必ず重なる → 別レーン＝異なる縦位置になる。
  const count = await blocks.count();
  const yA = (await blocks.nth(count - 2).boundingBox())?.y ?? 0;
  const yB = (await blocks.nth(count - 1).boundingBox())?.y ?? 0;
  expect(Math.round(yA)).not.toBe(Math.round(yB));

  expect(pageErrors).toEqual([]);
});

test('サブ動画トラックの追加→保存→再読込でブロックが復元される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    // フィクスチャの main.mp4 / cam2.mp4 は 62 バイトのスタブのため Remotion が
    // MediaPlaybackError をスローする。UI の問題ではないのでフィルタアウトする。
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();

  // プレビューがマウントされる。
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // サブ動画トラックが出る（public/sub/cam2.mp4 があるので videoLibrary に入り、トラック描画される）。
  await expect(page.locator('.tl-track-vi')).toBeVisible();

  // ＋サブ動画ボタンをクリック → ブロックが 1 つ出る
  // （videoLibrary.length > 0 なので disabled にならない）。
  await clickAddMenuItem(page, '.tl-vi-add');
  await expect(page.locator('.tl-vi-block')).toHaveCount(1);

  // ブロックを選択 → インスペクタに開始・終了フレーム入力が出る。
  await page.locator('.tl-vi-block').first().click();
  await expect(page.locator('#ins-vi-start')).toBeVisible();
  await expect(page.locator('#ins-vi-end')).toBeVisible();

  // 未保存インジケータが出る。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 保存 → 「保存済み」へ戻り、保存エラーが出ない。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // --- 再読込で復元 ---
  // フォルダブラウザへ戻り、再度 sample-project を開く。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 保存した insertVideoData.ts が再読込され、ブロックが 1 件復元される。
  await expect(page.locator('.tl-vi-block')).toHaveCount(1);

  // JS の未捕捉例外が無い。
  expect(pageErrors).toEqual([]);
});

test('同位置の SE が複数レーン（異なる縦位置）で表示される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const pins = page.locator('.tl-se-clip');
  const before = await pins.count();

  // 再生ヘッド位置に SE を 2 回追加 → 同フレーム＝クリップが必ず重なる。
  await clickAddMenuItem(page, '.tl-se-add');
  await clickAddMenuItem(page, '.tl-se-add');
  await expect(pins).toHaveCount(before + 2);

  // 追加した末尾 2 クリップは同フレームで必ず重なる → 別レーン＝異なる縦位置になる。
  const count = await pins.count();
  const yA = (await pins.nth(count - 2).boundingBox())?.y ?? 0;
  const yB = (await pins.nth(count - 1).boundingBox())?.y ?? 0;
  expect(Math.round(yA)).not.toBe(Math.round(yB));

  expect(pageErrors).toEqual([]);
});

test('BGM トラックの追加→保存→再読込でブロックが復元される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const m = String(err);
    // フィクスチャの main.mp4 / bgm.mp3 は 62 バイトのスタブのため Remotion が
    // MediaPlaybackError をスローする。UI の問題ではないのでフィルタアウトする。
    if (m.includes('MediaPlaybackError')) return;
    pageErrors.push(m);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();

  // プレビューがマウントされる。
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // BGM トラックが出る（public/BGM/bgm.mp3 があるので bgmLibrary に入り、トラック描画される）。
  await expect(page.locator('.tl-track-bgm')).toBeVisible();

  // ＋BGM ボタンをクリック → ブロックが 1 つ出る
  // （bgmLibrary.length > 0 なので disabled にならない）。
  await clickAddMenuItem(page, '.tl-bgm-add');
  await expect(page.locator('.tl-bgm-block')).toHaveCount(1);

  // ブロックを選択 → インスペクタに開始フレーム入力が出る。
  await page.locator('.tl-bgm-block').first().click();
  await expect(page.locator('#ins-bgm-start')).toBeVisible();

  // 未保存インジケータが出る。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 保存ボタンが有効になる。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();

  // 保存 → 「保存済み」へ戻り、保存エラーが出ない。
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // --- 再読込で復元 ---
  // フォルダブラウザへ戻り、再度 sample-project を開く。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 保存した bgmData.ts が再読込され、ブロックが 1 件復元される。
  await expect(page.locator('.tl-bgm-block')).toHaveCount(1);

  // JS の未捕捉例外が無い。
  expect(pageErrors).toEqual([]);
});

test('重なる字幕は同じ段のまま（段を増やさない）', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // フィクスチャは字幕3本（印なし: id:1/id:2/id:3）。初期は全て同段（lane 0 固定）。
  const blocks = page.locator('.tl-telop');
  await expect(blocks).toHaveCount(3);
  const y0 = (await blocks.nth(0).boundingBox())!.y;
  const y1 = (await blocks.nth(1).boundingBox())!.y;
  const y2 = (await blocks.nth(2).boundingBox())!.y;
  expect(Math.round(y0)).toBe(Math.round(y1));
  expect(Math.round(y0)).toBe(Math.round(y2));

  // 2本目の字幕の開始を 0 にして 1 本目に重ねる。字幕同士は重なっても同段固定。
  await page.locator('.tx-row').nth(1).click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  const startInput = page.locator('#ins-start');
  await expect(startInput).toBeVisible();
  await startInput.fill('0');
  await startInput.press('Enter');

  // 反映を待ってから、依然として同じ縦位置（段を増やしていない）ことを確認。
  await page.waitForTimeout(400);
  const a = (await blocks.nth(0).boundingBox())!.y;
  const b = (await blocks.nth(1).boundingBox())!.y;
  expect(Math.round(a)).toBe(Math.round(b));

  expect(pageErrors).toEqual([]);
});

test('同じ位置に BGM を2回追加しても重ならず隣接配置される（単一トラック・spec §9.1）', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const blocks = page.locator('.tl-bgm-block');
  const before = await blocks.count();

  // 再生ヘッド位置に BGM を 2 回追加。BGM は重ね禁止（単一トラック）なので、
  // 2 本目は 1 本目の後ろへ隣接配置される（＝重ならない）。
  await clickAddMenuItem(page, '.tl-bgm-add');
  await clickAddMenuItem(page, '.tl-bgm-add');
  await expect(blocks).toHaveCount(before + 2);

  // 追加した末尾 2 ブロックは重ならず横に並ぶ → 同一レーン（同じ縦位置）・異なる横位置。
  const count = await blocks.count();
  const boxA = await blocks.nth(count - 2).boundingBox();
  const boxB = await blocks.nth(count - 1).boundingBox();
  expect(boxA).not.toBeNull();
  expect(boxB).not.toBeNull();
  // 同一レーン（縦位置が一致）
  expect(Math.round(boxA!.y)).toBe(Math.round(boxB!.y));
  // 横に並ぶ（重ならない：後発ブロックは先発ブロックの右端以降から始まる）
  expect(boxB!.x).toBeGreaterThanOrEqual(boxA!.x + boxA!.width - 1);

  expect(pageErrors).toEqual([]);
});

test('BGM 未導入で追加すると『書き出しに反映されない』警告バナーが出る（残課題 #10）', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // sample-project は BGM 未導入。BGM が 0 本のうちは警告バナーは出ない。
  const banner = page.locator('.bgm-install-banner-btn');
  await expect(banner).toHaveCount(0);

  // BGM を追加すると、未導入のままでは書き出しに出ないことを常時知らせるバナーが出る。
  await clickAddMenuItem(page, '.tl-bgm-add');
  await expect(page.locator('.tl-bgm-block')).toHaveCount(1);
  await expect(banner).toBeVisible();
});

test('サブ動画 未導入で追加すると『書き出しに反映されない』警告バナーが出る（残課題 #10 系）', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // sample-project はサブ動画 未導入。サブ動画が 0 本のうちは警告バナーは出ない。
  const banner = page.locator('.video-insert-install-banner-btn');
  await expect(banner).toHaveCount(0);

  // サブ動画を追加すると、未導入のままでは書き出しに出ないことを常時知らせるバナーが出る。
  await clickAddMenuItem(page, '.tl-vi-add');
  await expect(page.locator('.tl-vi-block')).toHaveCount(1);
  await expect(banner).toBeVisible();
});

test('切替で字幕↔装飾を変更でき、保存→再読込で保持される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 1本目の字幕を選択 → 設定タブに装飾スイッチが出る（初期 off）。
  await page.locator('.tx-row').nth(0).click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  const toggle = page.locator('#ins-telop-manual');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('.tl-telop.manual')).toHaveCount(0);

  // 装飾に切替 → 装飾テロップが1つになる。
  await toggle.check();
  await expect(page.locator('.tl-telop.manual')).toHaveCount(1);

  // 保存 → 「保存済み」。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  // 再読込で装飾が保持される。
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.tl-telop.manual')).toHaveCount(1);

  expect(pageErrors).toEqual([]);
});

test('トラック見出しの幅が全トラックで揃っている', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 複数トラックの見出しが描画される（動画・テロップは常に存在）。
  const labels = page.locator('.tl-track-label');
  const count = await labels.count();
  expect(count).toBeGreaterThan(1);

  // すべての見出し幅が同一（固定幅 = --track-label-w）であること。
  const widths: number[] = [];
  for (let i = 0; i < count; i++) {
    widths.push(Math.round((await labels.nth(i).boundingBox())!.width));
  }
  expect(new Set(widths).size).toBe(1);

  // 最長級ラベル（テロップ＝全角4文字）が固定幅に収まり省略記号にならないこと。
  const longLabel = page.locator('.tl-track-label', { hasText: 'テロップ' });
  const overflow = await longLabel.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  expect(pageErrors).toEqual([]);
});

test('タイムラインの中身が見出し幅(88px)ぶん右から始まる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // フレーム0の目盛り（0:00）が、ルーラー左端から見出し幅(88px)ぶん右に出る。
  // Task4: --track-label-w と TRACK_LABEL_GUTTER_PX を 88px へ揃えた（旧 64px）。
  const ruler = page.locator('.tl-ruler');
  const firstTick = page.locator('.tl-tick.major').first();
  const rb = (await ruler.boundingBox())!;
  const tb = (await firstTick.boundingBox())!;
  const offset = Math.round(tb.x - rb.x);
  expect(offset).toBeGreaterThanOrEqual(84);
  expect(offset).toBeLessThanOrEqual(92);

  expect(pageErrors).toEqual([]);
});

test('ルーラー左に見出し幅の余白セルがある', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const gutter = page.locator('.tl-ruler-gutter');
  await expect(gutter).toBeVisible();
  const w = Math.round((await gutter.boundingBox())!.width);
  // Task 4: --track-label-w を 88px に拡張したため期待値を更新
  expect(w).toBe(88);
});

test('テロップブロックの幅は継続フレーム分だけ（ガターが混入しない）', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // フィクスチャの 3 字幕: telop1=[30,150)・telop2=[200,320)・telop3=[6000,6100)（時間的に離れている）。
  // Task 2: 字幕テロップ（manual=undefined）は tl-track-jimaku に表示される。
  // 幅テストは最初の 2 件 (id:1/id:2) を使うのでカウントを 3 に更新。
  const blocks = page.locator('.tl-track-jimaku .tl-telop');
  await expect(blocks).toHaveCount(3);
  const b1 = (await blocks.nth(0).boundingBox())!;
  const b2 = (await blocks.nth(1).boundingBox())!;

  // 左端の差 ÷ 開始フレームの差 から pxPerFrame を逆算（差ではガターが相殺＝ズーム非依存）。
  const ppf = (b2.x - b1.x) / (200 - 30);
  // telop1 の正しい幅は継続 120 フレーム分。幅に frameToX を使うとガター(88)が乗って 88px ずれる。
  const expectedWidth = (150 - 30) * ppf;
  expect(Math.abs(b1.width - expectedWidth)).toBeLessThanOrEqual(2);

  // 結果として時間的に離れた 2 字幕は重ならない（telop1 の右端 ≤ telop2 の左端）。
  expect(b1.x + b1.width).toBeLessThanOrEqual(b2.x + 1);
});

test('テーマ切替ボタンで data-theme が切り替わる', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const before = await html.getAttribute('data-theme');
  // ホームのツールバーは編集操作を持たないスリム表示で、テーマ切替は直接ボタン
  //（aria-label「◯◯モードに切り替え」）になっている（UIリフレッシュ 2026-07-10）。
  await page.getByRole('button', { name: /モードに切り替え/ }).click();
  const after = await html.getAttribute('data-theme');
  expect(after).not.toBe(before);
  expect(['dark', 'light']).toContain(after);
});

test('テロップ本体ドラッグでブロックが時間移動する', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const block = page.locator('.tl-telop').first();
  await expect(block).toBeVisible();
  const before = (await block.boundingBox())!;
  // 本体中央を掴んで右へ +60px ドラッグ（端つまみ±5px を避け中央を掴む）
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = (await block.boundingBox())!;
  expect(after.x).toBeGreaterThan(before.x + 20);
  // 幅（=尺）は保たれる
  expect(Math.abs(after.width - before.width)).toBeLessThan(4);
});

test('＋テロップで再生位置に装飾テロップが1件増える', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const before = await page.locator('.tl-telop').count();
  await clickAddMenuItem(page, '.tl-telop-add');
  await expect(page.locator('.tl-telop')).toHaveCount(before + 1);
  // 追加分は装飾（manual）でオレンジ枠
  await expect(page.locator('.tl-telop.manual')).toHaveCount(1);
});

// ===== item-02: Task 2-6 =====

test('Task2: じまくトラック・テロップトラックの2行が表示される', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // じまくトラック（variant=subtitle）が存在する
  await expect(page.locator('.tl-track-jimaku')).toBeVisible();
  // テロップトラック（variant=manual）が存在する
  await expect(page.locator('.tl-track-telop')).toBeVisible();
  // 2行合わせて2つのトラック見出しに「じまく」「テロップ」のラベルが入る
  await expect(page.locator('.tl-track-jimaku .tl-track-name')).toHaveText('じまく');
  await expect(page.locator('.tl-track-telop .tl-track-name')).toHaveText('テロップ');
});

test('一本化: ＋タイトルとタイトル行は撤去され、文字入れは＋テロップに統合', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // ＋タイトルボタン・タイトル行・タイトルブロックは存在しない（テロップへ一本化）。
  await expect(page.locator('.tl-title-add')).toHaveCount(0);
  await expect(page.locator('.tl-track-title')).toHaveCount(0);
  await expect(page.locator('.tl-title')).toHaveCount(0);
  // 文字入れは＋テロップに一本化されている（＋追加メニュー内）。
  await page.locator('.tl-add-menu-btn').click();
  await expect(page.locator('.tl-head .tl-telop-add')).toBeVisible();
});

test('Task5: TrackHeader — 各トラックにアイコンと名前が表示される', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 主要トラックの .tl-track-name が存在して非空（クラス名でトラックを特定）
  // CutTrack は tl-track-cut クラス
  await expect(page.locator('.tl-track-cut  .tl-track-name')).toHaveText('動画');
  await expect(page.locator('.tl-track-jimaku .tl-track-name')).toHaveText('じまく');
  await expect(page.locator('.tl-track-telop  .tl-track-name')).toHaveText('テロップ');
  // TrackIcon が各トラックに描画されている（SVG として .tl-track-icon が存在）
  await expect(page.locator('.tl-track-icon').first()).toBeVisible();
});

test('Task4: トラック配色トークンが :root にあり、見出し幅が 88px', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 種別カラートークンは :root 定義（テーマ連動のため）。documentElement で解決できること。
  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      telop: s.getPropertyValue('--track-telop').trim(),
      vi: s.getPropertyValue('--track-vi').trim(),
      se: s.getPropertyValue('--track-se').trim(),
    };
  });
  expect(tokens.telop).not.toBe('');
  expect(tokens.vi).not.toBe('');
  expect(tokens.se).not.toBe('');
  // 見出し幅は .tl スコープの --track-label-w = 88px（ガター定数と一致）。
  const labelW = await page
    .locator('.tl')
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--track-label-w').trim());
  expect(labelW).toBe('88px');
});

test('Task6: クリップが角丸8pxで、動画トラックが高い', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // クリップ角丸は var(--radius)=8px に統一。
  const telop = page.locator('.tl-telop').first();
  await expect(telop).toBeVisible();
  const radius = await telop.evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  expect(radius).toBe('8px');

  // 動画トラックは可変行高で高くなる（58px）。
  const cutH = await page
    .locator('.tl-track-cut')
    .evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(cutH).toBeGreaterThanOrEqual(52);
});

test('磨き込み: じまくクリップがトラック色のフラットなベタ塗り（薄塗りを脱却）', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const jimaku = page.locator('.tl-track-jimaku .tl-telop').first();
  await expect(jimaku).toBeVisible();
  const style = await jimaku.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, bgImage: s.backgroundImage };
  });
  // 塗りはトラックじまく色のフラットなベタ塗り（旧・薄い半透明ではない）。テーマ依存を避け、
  // トークンを実際に rgb 解決して比較する。
  const jimakuColor = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--track-jimaku)';
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  });
  expect(style.bg).toBe(jimakuColor);
  // “浮き”の原因だったグラデーションは使わない（フラット＝backgroundImage は none）。
  expect(style.bgImage).toBe('none');
});

// AI タブ由来の検証（埋め込みターミナル表示・右ドック幅）は claude-panel.spec.ts へ移設済み
// （pty は server 側グローバルシングルトンのため、AI タブを開く spec を default project
// （複数 worker 並列）に置くと、直列専用の ai-tab-pty project 側テストと writer を奪い合い
// claude-terminal.spec.ts の C-1 回帰テストがフレークする。playwright.config.ts 参照）。
test('右ドック: BGM選択で設定タブへ自動切替・文字起こしへ戻れる・右列のみ', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 旧・中央スロット/中央設定は無い。右ドックがある。
  await expect(page.locator('.center-stack')).toHaveCount(0);
  await expect(page.locator('.rightdock')).toBeVisible();
  // 初期は文字起こしタブがアクティブ。
  await expect(page.locator('.rightdock-tab[data-tab="transcript"]')).toHaveClass(/active/);
  await expect(page.locator('.rightdock-body .tx')).toBeVisible();

  // BGM 追加→選択 → 設定タブが自動アクティブ・音量が出る・文字起こしは隠れる。
  await clickAddMenuItem(page, '.tl-bgm-add');
  await page.locator('.tl-bgm-block').click();
  await expect(page.locator('.rightdock-tab[data-tab="settings"]')).toHaveClass(/active/);
  await expect(page.locator('.rightdock-body .ins')).toBeVisible();
  await expect(page.locator('.rightdock-body .ins')).toContainText('音量');
  await expect(page.locator('.ins-title')).toHaveText('BGM 設定');
  await expect(page.locator('.rightdock-body .tx')).toHaveCount(0);

  // 「← 文字起こしへ」で文字起こしタブへ戻る。
  await expect(page.locator('.ins-back')).toContainText('文字起こし');
  await page.locator('.ins-back').click();
  await expect(page.locator('.rightdock-tab[data-tab="transcript"]')).toHaveClass(/active/);
  await expect(page.locator('.rightdock-body .tx')).toBeVisible();

  // 縦動画(sample-project=縦)では右ドックを広めに（>=400px）。幅は data-orientation 依存で
  // アクティブなタブの種類には依存しない（styles.css の --rightdock-w）ため、AI タブを
  // 開かずに文字起こしタブのまま測ってよい。
  const w = await page.locator('.rightdock').evaluate((el) => el.getBoundingClientRect().width);
  expect(w).toBeGreaterThanOrEqual(400);
});

test('レイアウト: 既定 standard で .stage グリッド・タイムライン全幅', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'standard');
  await expect(page.locator('.stage')).toBeVisible();
  // 標準ではタイムラインが全幅（右端がドック右端と概ね一致）。
  const tlRight = await page.locator('.tl').evaluate((el) => el.getBoundingClientRect().right);
  const dockRight = await page.locator('.rightdock').evaluate((el) => el.getBoundingClientRect().right);
  expect(Math.abs(tlRight - dockRight)).toBeLessThan(8);
});

test('レイアウト: 切替で標準/全高ドック/字幕に変わり永続する', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await expect(page.locator('html')).toHaveAttribute('data-layout', 'standard');

  // 全高ドックへ → ドックが下まで全高（タイムライン下端付近まで届く）。
  await page.locator('.tb-settings-btn').click();
  await page.locator('.layout-seg[data-preset="tall-dock"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'tall-dock');
  const dockBottom = await page.locator('.rightdock').evaluate((el) => el.getBoundingClientRect().bottom);
  const tlBottom = await page.locator('.tl').evaluate((el) => el.getBoundingClientRect().bottom);
  expect(Math.abs(dockBottom - tlBottom)).toBeLessThan(8);
  // 全高ドックではタイムラインはプレビュー幅まで（ドック左端より左で終わる）。
  const tlRight = await page.locator('.tl').evaluate((el) => el.getBoundingClientRect().right);
  const dockLeft = await page.locator('.rightdock').evaluate((el) => el.getBoundingClientRect().left);
  expect(tlRight).toBeLessThanOrEqual(dockLeft + 2);

  // 永続: リロードしても tall-dock。
  await page.reload();
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'tall-dock');

  // 標準へ戻す（同一 origin の localStorage を汚さないよう後始末）。
  await page.locator('.tb-settings-btn').click();
  await page.locator('.layout-seg[data-preset="standard"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'standard');
});

test('レイアウト字幕: 字幕選択で文字起こしの隣に設定側パネルが出る・BGMでは出ない', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.tb-settings-btn').click();
  await page.locator('.layout-seg[data-preset="subtitle"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-layout', 'subtitle');
  // 設定メニューを閉じる（開いたままだと文字起こし一覧の先頭行に被ってクリックできない）。
  await page.keyboard.press('Escape');

  // 字幕選択 → subpanel on。文字起こし(右ドック)と設定側パネルが横並びで同時に見える。
  await page.locator('.tx-row').nth(0).click();
  await expect(page.locator('html')).toHaveAttribute('data-subpanel', 'on');
  const subpanel = page.locator('.subpanel');
  await expect(subpanel).toBeVisible();
  await expect(subpanel.locator('#ins-telop-manual')).toBeVisible();
  // 文字起こし(テキストベース編集)も同時に見えている。
  await expect(page.locator('.rightdock-body .tx')).toBeVisible();
  // 設定側パネルは文字起こし(ドック)の右隣にある。
  const dockBox = (await page.locator('.rightdock').boundingBox())!;
  const panelBox = (await subpanel.boundingBox())!;
  expect(panelBox.x).toBeGreaterThan(dockBox.x);

  // BGM 選択 → subpanel 非表示・右ドック設定タブ。
  await clickAddMenuItem(page, '.tl-bgm-add');
  await page.locator('.tl-bgm-block').click();
  await expect(page.locator('html')).toHaveAttribute('data-subpanel', 'off');
  await expect(page.locator('.rightdock-tab[data-tab="settings"]')).toHaveClass(/active/);

  // 後始末: 標準へ。
  await page.locator('.tb-settings-btn').click();
  await page.locator('.layout-seg[data-preset="standard"]').click();
});

test('整え: カット未確定バンドがスリム（高さ控えめ）', async ({ page }) => {
  // fixture に cutData.ts が存在する場合は削除してから開く（afterEach の git checkout -- で復元）。
  const cutDataPath = resolve(FIXTURE_DIR, 'src', 'cutData.ts');
  try { unlinkSync(cutDataPath); } catch { /* 不在なら無視 */ }

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  const banner = page.locator('.conv-banner');
  await expect(banner).toBeVisible();
  const h = await banner.evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeLessThanOrEqual(44);
});

test('右ドック: じまく選択は文字起こしタブ維持・設定タブで選択行設定を全幅表示', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // じまく選択 → 文字起こしタブのまま（テキスト編集に専念。一覧の下に窮屈な設定は出さない）。
  await page.locator('.tx-row').nth(0).click();
  await expect(page.locator('.rightdock-tab[data-tab="transcript"]')).toHaveClass(/active/);
  await expect(page.locator('.rightdock-body .tx')).toBeVisible();
  await expect(page.locator('.dock-subtitle-settings')).toHaveCount(0);

  // 設定タブをクリック → そのじまくの設定（飾り変換スイッチ）が全幅で出る。
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await expect(page.locator('.rightdock-body .ins #ins-telop-manual')).toBeVisible();
});

test('Task2B: BGM クリップ内に波形 canvas が描画される', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await clickAddMenuItem(page, '.tl-bgm-add');
  const block = page.locator('.tl-bgm-block').first();
  await expect(block).toBeVisible();
  // クリップ内に波形 canvas（samples が無くても canvas 要素は描画される）。
  await expect(block.locator('canvas.tl-clip-waveform')).toBeVisible();
});

test('Task2B: 効果音が幅のある波形クリップとして表示される', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await clickAddMenuItem(page, '.tl-se-add');
  const clip = page.locator('.tl-se-clip').first();
  await expect(clip).toBeVisible();
  // 点ではなく幅を持つクリップ（フォールバックでも 6px 超の帯）。
  const box = (await clip.boundingBox())!;
  expect(box.width).toBeGreaterThan(6);
  // クリップ内に波形 canvas 要素がある。
  await expect(clip.locator('canvas.tl-clip-waveform')).toBeVisible();
});

test('Task2B: 動画トラックにフィルムストリップ層があり波形と共存する', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 動画トラックは健在で、背面波形 canvas とフィルムストリップ層が共存する。
  await expect(page.locator('.tl-track-cut')).toBeVisible();
  await expect(page.locator('.tl-track-cut .tl-filmstrip')).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('素材タブの効果音はクリックで選択され、挿入ボタンでトラックに入る', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 左カラムの素材タブへ
  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="se"]').click();

  // 効果音トラックの現在のクリップ数（SeTrack のクリップは .tl-se-clip）
  const seClips = page.locator('.tl-track-se .tl-se-clip');
  const before = await seClips.count();

  const row = page.locator('.ml-list .ml-row').first();
  await expect(row).toBeVisible();

  // 行クリック＝選択（挿入されない）
  await row.click();
  await expect(row).toHaveClass(/selected/);
  expect(await seClips.count()).toBe(before);

  // 「挿入」ボタンで1件増える
  await row.locator('.ml-insert').click();
  await expect(seClips).toHaveCount(before + 1);
});

test('素材をタイムラインへドラッグすると任意位置に入る', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="se"]').click();

  const seClips = page.locator('.tl-track-se .tl-se-clip');
  const before = await seClips.count();

  const row = page.locator('.ml-row').first();
  // 可視のスクロール領域(.tl-body)へ落とす（.tl-scroll はコンテンツ全高で中心が領域外になりうる）。
  const body = page.locator('.tl-body');
  const rb = await row.boundingBox();
  const bb = await body.boundingBox();
  if (!rb || !bb) throw new Error('bounding box が取れません');

  // しきい値(5px)を超えて動かしてから timeline の可視領域中央でドロップ
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + 40, rb.y + 10, { steps: 3 });
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect(seClips).toHaveCount(before + 1);
});

test('効果音を挿入してタイムラインで選ぶと設定に試聴ボタンが出る', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="se"]').click();
  // 挿入ボタンで1件挿入してタイムラインのクリップを選択する。
  const row = page.locator('.ml-list .ml-row').first();
  await row.locator('.ml-insert').click();
  await page.locator('.tl-track-se .tl-se-clip').first().click();

  // 右ドックの設定（Inspector）に試聴ボタンが出る（左の素材ライブラリの試聴とは別物）。
  await expect(page.locator('.rightdock').getByRole('button', { name: '試聴' })).toBeVisible();
});

test('サブ動画クリップに長さ変更の端つまみが見える', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="video"]').click();
  // セルクリック＝選択のみ。挿入ボタンでサブ動画を挿入。
  const cell = page.locator('.ml-grid .ml-cell').first();
  await cell.click();
  await expect(cell).toHaveClass(/selected/);
  await cell.locator('.ml-cell-insert').click();

  await expect(page.locator('.tl-vi-handle-end').first()).toBeVisible();
});

test('ドラッグ挿入の直後でもクリック選択が握り潰されない', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="se"]').click();

  const seClips = page.locator('.tl-track-se .tl-se-clip');
  const before = await seClips.count();

  // 1) タイムラインへドラッグして挿入（ドロップ先が別要素＝行 click は発火しない）
  const row = page.locator('.ml-row').first();
  const body = page.locator('.tl-body');
  const rb = await row.boundingBox();
  const bb = await body.boundingBox();
  if (!rb || !bb) throw new Error('bounding box が取れません');
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + 40, rb.y + 10, { steps: 3 });
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(seClips).toHaveCount(before + 1);

  // 2) すぐ続けてクリック → 握り潰されず選択状態になる（suppressClickRef 残留バグの回帰防止）
  await page.locator('.ml-row').first().click();
  await expect(page.locator('.ml-row').first()).toHaveClass(/selected/);
  // 挿入ボタンで追加すると +1 される
  await page.locator('.ml-row').first().locator('.ml-insert').click();
  await expect(seClips).toHaveCount(before + 2);
});

test('素材ライブラリから画像を挿入するとプレビューに画像が出る', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="image"]').click();
  // セルクリック＝選択のみ。挿入ボタンで sample.png を挿入（ヘッド=0 に出る）。
  const cell = page.locator('.ml-grid .ml-cell').first();
  await cell.click();
  await cell.locator('.ml-cell-insert').click();

  // プレビュー内に画像（/api/asset の images/sample.png）が描画される
  await expect(page.locator('.pv-stage img[src*="sample.png"]').first()).toBeVisible({ timeout: 10_000 });
});

test('画像を選んでプレビューでドラッグすると配置が変わる', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="image"]').click();
  // セルクリック＝選択のみ。挿入ボタンで挿入（挿入後に自動選択される）。
  const cell = page.locator('.ml-grid .ml-cell').first();
  await cell.click();
  await cell.locator('.ml-cell-insert').click();

  // 画像が選択され、操作枠（移動グラブ面）が出る
  const grab = page.locator('.pv-telop-grab');
  await expect(grab).toBeVisible();
  const box = page.locator('.pv-telop-box');
  const before = await box.boundingBox();
  if (!before) throw new Error('box 取得失敗');

  // 移動グラブ面を掴んで動かす
  await grab.hover();
  await page.mouse.down();
  await page.mouse.move(before.x + 80, before.y + 40, { steps: 8 });
  await page.mouse.up();

  const after = await box.boundingBox();
  if (!after) throw new Error('box 取得失敗');
  expect(Math.abs(after.x - before.x) + Math.abs(after.y - before.y)).toBeGreaterThan(10);
});

test('画像の不透明度・回転をスライダーで設定すると保存後の insertImageData.ts に反映される', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 素材ライブラリから画像を挿入（再生ヘッド=0 に出て自動選択される）。
  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="image"]').click();
  // セルクリック＝選択のみ。挿入ボタンで挿入。
  const imgCell = page.locator('.ml-grid .ml-cell').first();
  await imgCell.click();
  await imgCell.locator('.ml-cell-insert').click();

  // 設定タブのスライダーを操作（選択でドックが設定タブへ切り替わるが、念のため明示）。
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await page.locator('#ins-image-opacity').fill('0.5');
  await page.locator('#ins-image-rotation').fill('20');

  // 保存 → 書き戻された insertImageData.ts に opacity / rotation 行が現れる。
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  const dataPath = resolve(FIXTURE_DIR, 'src', 'InsertImage', 'insertImageData.ts');
  const written = readFileSync(dataPath, 'utf8');
  expect(written).toContain('opacity: 0.5,');
  expect(written).toContain('rotation: 20,');
});

test('画像の回転を設定するとプレビューの配置 transform に rotate が入る', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="image"]').click();
  // セルクリック＝選択のみ。挿入ボタンで挿入（再生ヘッド0・自動選択）。
  const rotCell = page.locator('.ml-grid .ml-cell').first();
  await rotCell.click();
  await rotCell.locator('.ml-cell-insert').click();

  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await page.locator('#ins-image-rotation').fill('20');

  // フィクスチャ InsertImage の配置レイヤーが rotate(20deg) を含む transform で描かれる。
  await expect(page.locator('.pv-stage [style*="rotate(20deg)"]').first()).toBeVisible({ timeout: 10_000 });
});

test('素材ライブラリのサブ動画タブで実フレームサムネ（video要素）が出る', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="video"]').click();

  // 「動画」文字プレースホルダではなく <video> サムネが描画される。
  await expect(page.locator('.ml-cell .ml-thumb-video-el').first()).toBeVisible({ timeout: 10_000 });
});

test('画像はフレーム相対フェードで窓中盤に不透明表示される（透明化バグ回帰）', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // フィクスチャの画像クリップ（1〜3秒）の中心x（=2秒）でルーラーをクリックして窓中盤へシーク。
  // 区間先頭=0 の相対フレームを正しく扱えていれば、窓中盤はフェード完了で opacity≈1。
  // 二重減算バグ（localFrame=frame-startFrame）だと窓中盤でも opacity=0 になる。
  const geo = await page.evaluate(() => {
    const b = document.querySelector('.tl-image-block')?.getBoundingClientRect();
    const sc = document.querySelector('.tl-scroll')?.getBoundingClientRect();
    return { cx: b ? b.x + b.width / 2 : null, y: sc ? sc.y + 5 : null };
  });
  if (geo.cx === null || geo.y === null) throw new Error('画像ブロック/ルーラーが見つかりません');
  await page.mouse.click(geo.cx, geo.y);
  await page.waitForTimeout(400);

  const maxOpacity = await page.evaluate(() => {
    const stage = document.querySelector('.pv-stage');
    if (!stage) return 0;
    let max = 0;
    for (const img of stage.querySelectorAll('img')) {
      let el: Element | null = img;
      let eff = 1;
      while (el && el !== stage) {
        const o = parseFloat(getComputedStyle(el).opacity || '1');
        if (!Number.isNaN(o)) eff *= o;
        el = el.parentElement;
      }
      if (eff > max) max = eff;
    }
    return max;
  });
  expect(maxOpacity).toBeGreaterThan(0.8);
});

test('SE を右端つまみで伸ばすと保存後の seData.ts に endFrame が書かれる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const clip = page.locator('.tl-se-clip').first();
  await expect(clip).toBeVisible();

  // ＋SE でクリップを 1 件追加（addSe が autoLength:true で追加し endFrame を持つ）。
  await clickAddMenuItem(page, '.tl-se-add');
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible({ timeout: 5_000 });

  // 右端つまみをドラッグして区間を伸ばす。
  const newClip = page.locator('.tl-se-clip').last();
  await expect(newClip).toBeVisible();
  const endHandle = newClip.locator('.tl-se-handle-end');
  const hBox = await endHandle.boundingBox();
  if (!hBox) throw new Error('no end handle box');
  const hx = hBox.x + hBox.width / 2;
  const hy = hBox.y + hBox.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 120, hy, { steps: 8 });
  await page.mouse.up();

  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  const written = readFileSync(resolve(FIXTURE_DIR, 'src', 'SoundEffects', 'seData.ts'), 'utf8');
  expect(written).toMatch(/endFrame:\s*\d+/);
});

test('SE 両端つまみが表示され、フェードつまみもクリップ内に存在する', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const clip = page.locator('.tl-se-clip').first();
  await expect(clip).toBeVisible();

  // 端つまみが DOM に存在する（SE 区間クリップの証拠）。
  await expect(clip.locator('.tl-se-handle-start')).toHaveCount(1);
  await expect(clip.locator('.tl-se-handle-end')).toHaveCount(1);

  // フェードつまみのヒット矩形が DOM に存在する。
  await expect(clip.locator('.tl-se-fade-in-hit')).toHaveCount(1);
  await expect(clip.locator('.tl-se-fade-out-hit')).toHaveCount(1);
});

test('追加した SE は音源ラウドネスで正規化され保存後の seData.ts に volume が書かれる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await clickAddMenuItem(page, '.tl-se-add');
  // 自動正規化はデコード後に走る。少し待ってから保存。
  await expect(page.locator('.tl-se-clip')).toHaveCount(2); // フィクスチャ1 + 追加1
  // デコード→自動正規化→tooltip 更新を observable に待つ（固定 sleep を避ける）。
  await expect(page.locator('.tl-se-clip').nth(1)).toHaveAttribute('title', /音量/, { timeout: 10_000 });

  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  // 既存SE(volume:0.3・autoVolume無=非正規化) + 追加SE(正規化済) で volume が 2 件以上書かれる。
  const written = readFileSync(resolve(FIXTURE_DIR, 'src', 'SoundEffects', 'seData.ts'), 'utf8');
  expect((written.match(/volume:/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test('インスペクタのフェードイン入力が保存後の seData.ts に書かれる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // ＋SE でクリップを 1 件追加（addSe が fadeInFrames:0 を明示するため dirty になる基盤が整う）。
  await clickAddMenuItem(page, '.tl-se-add');
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible({ timeout: 5_000 });

  // 追加した新しいクリップ（末尾）を選択 → インスペクタのフェードイン入力が出る。
  await page.locator('.tl-se-clip').last().click();
  await expect(page.locator('#ins-se-fade-in')).toBeVisible();

  // フェードイン入力を 0.5 秒へ変更してコミット。
  await page.locator('#ins-se-fade-in').fill('0.5');
  await page.locator('#ins-se-fade-in').press('Enter');

  // 保存して seData.ts に fadeInFrames が書かれることを確認。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  const written = readFileSync(resolve(FIXTURE_DIR, 'src', 'SoundEffects', 'seData.ts'), 'utf8');
  expect(written).toMatch(/fadeInFrames:\s*\d+/);
});

test('SE 設定の音量が % 表示で、プリセット「大」で音量が上がる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.tl-se-clip').first().click();
  // % 表示が出る。
  await expect(page.locator('.ins-section', { hasText: '音量' }).first()).toContainText('%');
  // 「大」プリセットで未保存になる。
  await page.locator('.ins-volume-preset', { hasText: '大' }).click();
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();
});

test('素材ライブラリの効果音行に波形が出て、クリックで試聴（再生中表示）になる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 素材タブを開く。
  const matTab = page.locator('.lc-tab[data-tab="materials"]');
  await expect(matTab).toBeVisible();
  await matTab.click();

  // 効果音タブへ切り替え。
  await page.locator('.ml-tab[data-kind="se"]').click();
  const row = page.locator('.ml-list .ml-row').first();
  await expect(row).toBeVisible();

  // 行内に波形（Waveform の canvas）が描かれる（デコード完了を待つ）。
  await expect(row.locator('.ml-row-wave')).toBeVisible({ timeout: 10_000 });

  // クリックで再生中表示。
  await row.click();
  await expect(row).toHaveClass(/playing/);
});

test('ツールバーにダッキングのトグルと強さがあり、操作で未保存になる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.tb-settings-btn').click();
  const toggle = page.locator('.tb-duck-toggle');
  await expect(toggle).toBeVisible();
  await expect(page.locator('.tb-duck-lv')).toHaveCount(3);
  // 強さを「強」に変更 → 未保存（dirty）になる
  await page.locator('.tb-duck-lv', { hasText: '強' }).click();
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();
});

test('図形シナリオ: 矢印ツール→ドラッグ描画→色・太さ変更→保存→再読込で SVG 復元', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    // フィクスチャの main.mp4 / cam2.mp4 は 62 バイトのスタブのため Remotion が
    // MediaPlaybackError をスローする。UI の問題ではないのでフィルタアウトする。
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  // --- プロジェクトを開く ---
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // --- 矢印ツールを押下 ---
  // プレビュー左肩の矢印ボタン（.pv-shape-btn[title="矢印を描画（クリックで解除）"]）を押す。
  const arrowBtn = page.locator('.pv-shape-btn[title="矢印を描画（クリックで解除）"]');
  await expect(arrowBtn).toBeVisible();
  await arrowBtn.click();
  // 押下後は active クラスが付く（aria-pressed=true）。
  await expect(arrowBtn).toHaveAttribute('aria-pressed', 'true');

  // --- プレビュー上でドラッグして矢印を描く ---
  // 描画キャンバスは .pv-stage 全面（pv-overlay pv-drawing）だが、座標の忠実性を検証するため
  // 映像コンテンツ（.__remotion-player の矩形＝レターボックス黒帯を除いた実描画域）の内側を引く。
  // content の 30%,40% → 70%,60% をドラッグ（必ず映像内・距離 >5px）。
  const contentBox = await page.locator('.pv-stage .__remotion-player').boundingBox();
  if (!contentBox) throw new Error('プレビュー内容の boundingBox が取得できません');
  const startX = contentBox.x + contentBox.width * 0.3;
  const startY = contentBox.y + contentBox.height * 0.4;
  const endX = contentBox.x + contentBox.width * 0.7;
  const endY = contentBox.y + contentBox.height * 0.6;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 5 });
  await page.mouse.move(endX, endY, { steps: 5 });
  await page.mouse.up();

  // ドラッグ確定で .tl-shape ブロックが 1 つ出る。
  await expect(page.locator('.tl-shape')).toHaveCount(1, { timeout: 5_000 });

  // 矢印ツールが自動解除されず active のまま残る実装の場合はそのまま。
  // 図形ブロックを選択 → インスペクタに色・太さコントロールが出るはず。
  // 描画直後は addShape が selection を設定するので自動選択済み。
  // 設定タブへ遷移させるため図形ブロックをクリック（既に選択中でも）。
  await page.locator('.tl-shape').first().click();

  // 右ドックの設定タブを明示的に開く（selection 変化で自動切替される想定だが念のため）。
  const settingsTab = page.locator('.rightdock-tab[data-tab="settings"]');
  if (await settingsTab.count() > 0) {
    await settingsTab.click();
  }

  // インスペクタに色ボタングループが出る。
  await expect(page.locator('.ins-shape-colors')).toBeVisible({ timeout: 5_000 });

  // --- 色を青（#0A84FF）に変更 ---
  const blueBtn = page.locator('button.ins-shape-color-btn[title="#0A84FF"]');
  await expect(blueBtn).toBeVisible();
  await blueBtn.click();

  // --- 太さを「太」（thick）に変更 ---
  // THICKNESS_LABELS: thin→細 / medium→中 / thick→太
  const thickBtn = page.locator('.ins-section button', { hasText: '太' }).first();
  await expect(thickBtn).toBeVisible();
  await thickBtn.click();

  // 未保存マーク（dirty）が出る。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible({ timeout: 5_000 });

  // --- 保存 ---
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // shapeData.ts に kind:"arrow"/color:"#0A84FF" が書かれている。
  const shapeDataPath = resolve(FIXTURE_DIR, 'src', 'InsertShape', 'shapeData.ts');
  const written = readFileSync(shapeDataPath, 'utf8');
  expect(written).toMatch(/kind:\s*"arrow"/);
  expect(written).toMatch(/color:\s*"#0A84FF"/);

  // 座標の忠実性（回帰ガード）: content の 30%,40%→70%,60% を引いたので、保存座標もその近傍になる。
  // pointerdown と onMove/onUp で座標空間が食い違うと終点が画面端へクランプ（x2≈1）して、ここで落ちる。
  const num = (re: RegExp): number => {
    const v = written.match(re)?.[1];
    if (v === undefined) throw new Error(`shapeData.ts から座標を読めません: ${re}`);
    return Number(v);
  };
  const x1 = num(/x1:\s*([\d.]+)/);
  const y1 = num(/y1:\s*([\d.]+)/);
  const x2 = num(/x2:\s*([\d.]+)/);
  const y2 = num(/y2:\s*([\d.]+)/);
  expect(x1).toBeGreaterThan(0.15);
  expect(x1).toBeLessThan(0.45);
  expect(x2).toBeGreaterThan(0.55);
  expect(x2).toBeLessThan(0.85);
  expect(y1).toBeGreaterThan(0.25);
  expect(y1).toBeLessThan(0.55);
  expect(y2).toBeGreaterThan(0.45);
  expect(y2).toBeLessThan(0.75);

  // --- 再読込で復元 ---
  // page.goto('/') → sample-project を再度開く。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 再読込後、.tl-shape ブロックが 1 件復元される。
  await expect(page.locator('.tl-shape')).toHaveCount(1, { timeout: 10_000 });

  // プレビュー DOM 内に <svg> の <line marker-end> が存在する（矢印の SVG 証拠）。
  // Remotion Player はフレームをそのまま DOM に描画する（canvas ではなく React DOM）。
  // 矢印は frame=0 から始まるため再生ヘッドが区間内にある前提で確認する。
  // ShapeLayer は shapes.length > 0 のとき描画し、Sequence が from=0 であれば frame=0 で活性。
  // ただし Remotion の Sequence は durationInFrames>0 のとき from <= frame < from+dur で活性。
  // 万一フレームが0でなければフレームを合わせるためルーラーをクリックして先頭へシークする。
  const rulerEl = page.locator('.tl-ruler');
  if (await rulerEl.count() > 0) {
    const rulerBox = await rulerEl.boundingBox();
    if (rulerBox) {
      // ルーラー左端付近をクリック → フレーム 0 付近へシーク
      await page.mouse.click(rulerBox.x + 10, rulerBox.y + rulerBox.height / 2);
      await page.waitForTimeout(300);
    }
  }

  // <svg> 内の <line> で marker-end 属性を持つ要素が存在するかチェック。
  const hasArrowLine = await page.evaluate(() => {
    const playerEl = document.querySelector('.pv-stage .__remotion-player');
    if (!playerEl) return false;
    const lines = playerEl.querySelectorAll('svg line[marker-end]');
    return lines.length > 0;
  });
  expect(hasArrowLine).toBe(true);

  // JS の未捕捉例外が無い。
  expect(pageErrors).toEqual([]);
});

// ===== ノイズ除去 E2E スモークテスト =====

// ノイズ除去が生成する副産物（SME_DENOISE_MOCK=1 でも作られる）を afterEach で除去する。
// - <projectDir>/denoise.json       （マーカーファイル）
// - <projectDir>/public/main.denoise-backup.mp4  （バックアップ）
// git clean -fdx はすでに上位の afterEach で実行されているため、明示的な rmSync は
// 念のための二重保護として記載する（untracked ファイルなので git clean で削除される）。
test.afterEach(() => {
  for (const rel of [
    'denoise.json',
    'public/main.denoise-backup.mp4',
  ]) {
    const p = resolve(FIXTURE_DIR, rel);
    if (existsSync(p)) rmSync(p, { force: true });
  }
});

test('ノイズ除去: 強さ選択→実行→進捗バナー→完了→再読込→適用済み表示→元に戻す', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 文字起こしタブへ移動（ノイズ除去パネルは文字起こしパネル内に存在する）。
  await page.locator('.rightdock-tab[data-tab="transcript"]').click();

  // 「音声」折りたたみグループを開く。
  await page.locator('.tx-audio-group > summary').click();

  // 強さを「弱」に切り替える（初期は「中」）。
  const strengthSeg = page.locator('[role="group"][aria-label="ノイズ除去の強さ"]');
  await expect(strengthSeg).toBeVisible();
  await strengthSeg.getByRole('button', { name: '弱' }).click();
  await expect(strengthSeg.getByRole('button', { name: '弱' })).toHaveAttribute('aria-pressed', 'true');

  // 「ノイズ除去を実行」ボタンを押す。
  await page.getByRole('button', { name: 'ノイズ除去を実行' }).click();

  // 進捗バナーが出る（running 状態 = tx-misalign-running）。
  const banner = page.locator('.tx-misalign-running');
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText('ノイズ除去中');

  // 回帰ガード（C-1）: バックアップは動画と同じ public/ 配下に作られる。
  // handleDenoisePost は応答前に ensureBackup を同期実行するため、この時点で存在する。
  // 誤って projectDir 直下に作るとここで失敗する（実 ffmpeg では入力欠落で全滅するバグの早期検知）。
  await expect.poll(
    () => existsSync(resolve(FIXTURE_DIR, 'public', 'main.denoise-backup.mp4')),
    { timeout: 5_000 },
  ).toBe(true);

  // mock 完了（~3s）を待って「再読込」ボタンが出る。
  await expect(page.getByRole('button', { name: /再読込/ })).toBeVisible({ timeout: 10_000 });

  // 完了文言を確認してから再読込する（再読込で component が remount するため先にアサート）。
  await expect(page.locator('.tx-misalign')).toContainText('完了');

  // 再読込ボタンを押す。
  await page.getByRole('button', { name: /再読込/ }).click();

  // 再読込後にプレビューが再マウントされる。
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 適用済み表示（「適用済み」ヒントラベル）が出る。details は再読込で既定の閉じた状態に戻るため再度開く。
  await page.locator('.rightdock-tab[data-tab="transcript"]').click();
  await page.locator('.tx-audio-group > summary').click();
  const denoiseSection = page.locator('.ins-section', { hasText: 'ノイズ除去' });
  await expect(denoiseSection.locator('.ins-pack-hint', { hasText: '適用済み' })).toBeVisible({ timeout: 5_000 });

  // 「元に戻す」ボタン（ノイズ除去のリストア）が出て押せる。
  // Undo ボタン（title に「元に戻す（Ctrl/Cmd+Z）」を含む）と区別するため exact を使う。
  const restoreBtn = page.getByRole('button', { name: '元に戻す', exact: true });
  await expect(restoreBtn).toBeVisible();
  await restoreBtn.click();

  // 元に戻した後は適用済みラベルが消える。
  await expect(denoiseSection.locator('.ins-pack-hint', { hasText: '適用済み' })).toHaveCount(0, { timeout: 5_000 });
});

test('画像にズーム登場を設定→保存→insertImageData に enter が出力される', async ({ page }) => {
  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 素材ライブラリから画像を挿入（再生ヘッド=0 に出て自動選択される）。
  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="image"]').click();
  const imgCell = page.locator('.ml-grid .ml-cell').first();
  await imgCell.click();
  await imgCell.locator('.ml-cell-insert').click();

  // 設定タブのアニメセレクトを操作（選択でドックが設定タブへ切り替わるが念のため明示）。
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  // 挿入→選択→設定タブ表示の経路を自己文書化。出ていなければ selectOption の
  // 無言タイムアウトではなく「要素が見えない」で明確に落とす。
  await expect(page.locator('#ins-image-enter')).toBeVisible();
  await page.locator('#ins-image-enter').selectOption('zoom');

  // 保存 → 書き戻された insertImageData.ts に enter: { kind: "zoom" が現れる。
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  const dataPath = resolve(FIXTURE_DIR, 'src', 'InsertImage', 'insertImageData.ts');
  const written = readFileSync(dataPath, 'utf8');
  expect(written).toContain('enter: { kind: "zoom"');
});

// ===== シーン転換 E2E スモーク =====

test('つなぎ目のひし形はタイムラインを縦スクロールしても消えない（sticky 回帰）', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const head = page.locator('.tl-join-mark[data-join-at="head"]');
  await expect(head).toBeVisible();
  const before = await head.boundingBox();
  expect(before).not.toBeNull();

  // まず「縦スクロールできる状態」であることを確かめる（＝この検査が空振りしていない証拠）。
  // scrollHeight <= clientHeight ならスクロールは起きず、下の assert は何も検査しない。
  const body = page.locator('.tl-body');
  const scrollable = await body.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(scrollable, '.tl-body が縦スクロールしない＝この回帰検査は成立しない').toBeGreaterThan(20);

  await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForFunction(() => {
    const el = document.querySelector('.tl-body');
    return el !== null && el.scrollTop > 20;
  });

  // sticky ならスクロール後も同じ画面座標に貼り付いたまま見えている。
  // **座標の比較が本体**（アブレーション実測）: position:absolute へ戻すとマークは
  // スクロール域の外へ流れるが、Playwright の toBeVisible は矩形が空でない限り true を
  // 返すため素通りする。下の toBeCloseTo だけが旧実装を赤にする。
  await expect(head).toBeVisible();
  const after = await head.boundingBox();
  expect(after).not.toBeNull();
  expect(after!.y).toBeCloseTo(before!.y, 0);

  // 実ポインタでクリックできること（描画されているだけでなく当たり判定も生きている）。
  await head.click();
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await expect(page.locator('#ins-scene-kind')).toBeVisible({ timeout: 10_000 });
});

test('頭マーカーを選び暗転フェードを設定→保存→transitionData に at:"head" が出力される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // タイムラインに頭マーカー（at='head'）が出る。JoinMarkers は cutData の有無に依らず
  // 頭マーカーを常に描く（data-join-at="head"）。フィクスチャに cutData が無くても機能する。
  const headMarker = page.locator('.tl-join-mark[data-join-at="head"]');
  await expect(headMarker).toBeVisible();

  // 頭マーカーをクリック → joinSelection が 'head' になり、インスペクタに JoinSettings が出る。
  // マーカーは left:88px（ガター端）でルーラーの 0 フレーム目盛りと重なるが、
  // .tl-join-mark は z-index:8（ルーラー 7 より上）なので実ポインタでクリックできる。
  await headMarker.click();

  // 設定タブを明示的に開く（join 選択で自動切替するはずだが確実性のため）。
  await page.locator('.rightdock-tab[data-tab="settings"]').click();

  // #ins-scene-kind が出る（join 選択 → JoinSettings 表示 → 設定タブ切替後）。
  await expect(page.locator('#ins-scene-kind')).toBeVisible({ timeout: 10_000 });

  // 暗転フェードを選択。
  await page.locator('#ins-scene-kind').selectOption('fadeBlack');

  // 未保存インジケータが出る。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 保存ボタンが有効になる。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // 保存出力 src/Transition/transitionData.ts に kind:"fadeBlack" と at:"head" が含まれる。
  const transitionPath = resolve(FIXTURE_DIR, 'src', 'Transition', 'transitionData.ts');
  const written = readFileSync(transitionPath, 'utf8');
  expect(written).toContain('kind: "fadeBlack"');
  expect(written).toContain('at: "head"');

  expect(pageErrors).toEqual([]);
});

// ===== Task 13: 重なる系の同期回帰 E2E =====

test('number join を crossfade にすると保存 telopData の後続字幕が overlap 分前へ詰む（同期回帰）', async ({ page }) => {
  // fixture: cutData に隙間あり（[5000,6000) が削除区間）→ join atOriginal=5000 / playbackFrame=5000 が出現。
  // telopData id:3 は再生フレーム 6000（原本フレーム 7000 相当・join より後ろ）。
  // crossfade durationFrames=30（FPS=60 × 0.5）のとき overlap=30。
  // 保存後の id:3 startFrame = playbackToFinal(6000, [{boundary:5000, overlap:30}]) = 6000 - 30 = 5970。

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // number join マーカー（data-join-at が head/tail でない数値のもの）を実 .click() で選択。
  // fixture の cutData 隙間あり → atOriginal=5000 の join が 1 つ出る。
  const joinMark = page.locator('.tl-join-mark:not([data-join-at="head"]):not([data-join-at="tail"])').first();
  await expect(joinMark).toBeVisible({ timeout: 10_000 });
  await joinMark.click();

  // 設定タブを明示的に開く。
  await page.locator('.rightdock-tab[data-tab="settings"]').click();

  // インスペクタに JoinSettings が出る。
  await expect(page.locator('#ins-scene-kind')).toBeVisible({ timeout: 10_000 });

  // crossfade を選択。選択と同時に durationFrames = sceneDurationDefault(60) = 30 がセットされる。
  await page.locator('#ins-scene-kind').selectOption('crossfade');

  // duration が 30 フレームであることを確認（重なり量のアサートに使う）。
  const durValue = await page.locator('#ins-scene-duration').inputValue();
  expect(Number(durValue)).toBe(30);

  // 未保存インジケータが出る。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 保存。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // 保存出力 src/Transition/transitionData.ts に crossfade と at=5000 が含まれる。
  const transitionPath = resolve(FIXTURE_DIR, 'src', 'Transition', 'transitionData.ts');
  const transitionWritten = readFileSync(transitionPath, 'utf8');
  expect(transitionWritten).toContain('kind: "crossfade"');
  // at は再生フレーム 5000（projectSceneTransitions で atOriginal=5000 → playbackFrame=5000 へ射影）。
  expect(transitionWritten).toContain('at: 5000');

  // 同期回帰アサート（核心）:
  // 保存された telopData.ts を再パースして id:3 の startFrame を確認する。
  // crossfade overlap=30 → playbackToFinal(6000) = 6000 - 30 = 5970 が保存値として書かれるはず。
  const telopPath = resolve(FIXTURE_DIR, 'src', 'テロップテンプレート', 'telopData.ts');
  const telopWritten = readFileSync(telopPath, 'utf8');

  // telopData.ts の id:3 のエントリを抽出して startFrame を数値で検証する。
  // フォーマット: "  {\n    id: 3,\n    startFrame: NNNN," を期待。
  const id3Match = telopWritten.match(/id:\s*3[\s\S]*?startFrame:\s*(\d+)/);
  expect(id3Match).not.toBeNull();
  const id3StartFrame = Number(id3Match![1]);

  // crossfade なし時の期待値: 6000（再生フレーム直接）。
  // crossfade あり（overlap=30）時の期待値: 5970（=6000 - 30）。
  // この差が「重なりで後続字幕が前へ詰む」同期回帰の実挙動アサート。
  expect(id3StartFrame).toBe(5970);

  // id:1（join より前）は影響を受けない（startFrame: 30 のまま）。
  const id1Match = telopWritten.match(/id:\s*1[\s\S]*?startFrame:\s*(\d+)/);
  expect(id1Match).not.toBeNull();
  expect(Number(id1Match![1])).toBe(30);

  expect(pageErrors).toEqual([]);
});

test('音量正規化: 強さ選択→実行→進捗バナー→完了→再読込→適用済み表示→元に戻す', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 文字起こしタブへ（音量正規化パネルは文字起こしパネル内）。
  await page.locator('.rightdock-tab[data-tab="transcript"]').click();

  // 「音声」折りたたみグループを開く。
  await page.locator('.tx-audio-group > summary').click();

  // 「適用済み」ヒントは denoise セクションと重複するため normalize セクションへスコープする。
  const normSection = page.locator('.ins-section', { hasText: '音量を整える' });

  // 強さを「しっかり」に切り替える（初期は「標準」）。
  const strengthSeg = normSection.locator('[role="group"][aria-label="音量の目標"]');
  await expect(strengthSeg).toBeVisible();
  await strengthSeg.getByRole('button', { name: 'しっかり' }).click();
  await expect(strengthSeg.getByRole('button', { name: 'しっかり' })).toHaveAttribute('aria-pressed', 'true');

  // 実行ボタン（セクション内にスコープ）。
  await normSection.getByRole('button', { name: '音量を整える' }).click();

  // 進捗バナーが出る（running = tx-misalign-running）。
  const banner = page.locator('.tx-misalign-running');
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText('音量を');

  // 回帰ガード（C-1）: バックアップは動画と同じ public/ 配下に作られる。
  // handleNormalizePost は応答前に ensureBackup を同期実行するため、この時点で存在する。
  await expect.poll(
    () => existsSync(resolve(FIXTURE_DIR, 'public', 'main.normalize-backup.mp4')),
    { timeout: 5_000 },
  ).toBe(true);

  // mock 完了（~3s）を待って「再読込」ボタンが出る。
  await expect(page.getByRole('button', { name: /再読込/ })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tx-misalign')).toContainText('完了');

  // 再読込（component が remount するため先に完了文言をアサート済み）。
  await page.getByRole('button', { name: /再読込/ }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 適用済み表示（normalize セクションにスコープ）。details は再読込で既定の閉じた状態に戻るため再度開く。
  await page.locator('.rightdock-tab[data-tab="transcript"]').click();
  await page.locator('.tx-audio-group > summary').click();
  await expect(normSection.locator('.ins-pack-hint', { hasText: '適用済み' })).toBeVisible({ timeout: 5_000 });

  // 「元に戻す」（Undo ボタンと区別するため exact・セクション内）。
  const restoreBtn = normSection.getByRole('button', { name: '元に戻す', exact: true });
  await expect(restoreBtn).toBeVisible();
  await restoreBtn.click();

  // 元に戻すと適用済みラベルが消える。
  await expect(normSection.locator('.ins-pack-hint', { hasText: '適用済み' })).toHaveCount(0, { timeout: 5_000 });
});

test('サブ動画の速度変更→保存→再読込で playbackRate が保持される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // サブ動画を 1 本追加して選択。
  await expect(page.locator('.tl-track-vi')).toBeVisible();
  await clickAddMenuItem(page, '.tl-vi-add');
  await expect(page.locator('.tl-vi-block')).toHaveCount(1);
  await page.locator('.tl-vi-block').first().click();
  await expect(page.locator('#ins-vi-speed')).toBeVisible();

  // 0.5x プリセットを押す → バッジが 0.5x で出る。
  await page.locator('.ins-vi-speed-preset[data-rate="0.5"]').click();
  await expect(page.locator('.tl-vi-speed-badge')).toHaveText('0.50x');

  // 保存。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // 再読込で復元。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // バッジが 0.50x で復元される。
  await expect(page.locator('.tl-vi-speed-badge')).toHaveText('0.50x');

  expect(pageErrors).toEqual([]);
});

test('メイン動画速度: 選択→0.5x→保存→再読込で保持', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    // フィクスチャの main.mp4 は 62 バイトのスタブのため Remotion が MediaPlaybackError を
    // スローする。これは UI の問題ではないのでフィルタアウトする。
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // メイン動画トラック見出し（.tl-track-label に「動画」テキスト）をクリック → mainVideo 選択。
  await page.locator('.tl-track-label', { hasText: '動画' }).first().click();

  // インスペクタにメイン動画速度スライダーが出る。
  await expect(page.locator('#ins-main-speed')).toBeVisible();

  // 「書き出しへの導入」CTA ボタン（Plan 2・Task 7）が表示される（クリックしない=フィクスチャ非汚染）。
  await expect(page.locator('#ins-speed-install')).toBeVisible();

  // 0.5x プリセットを押す。
  await page.locator('.ins-vi-speed-preset[data-rate="0.5"]').click();

  // 速度バッジが出る（0.5 は非整数 → toFixed(2) → "0.50x"）。
  await expect(page.locator('.tl-main-speed-badge')).toHaveText('0.50x');

  // 未保存インジケータが出る。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 保存 → 「保存済み」へ戻り、保存エラーが出ない。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // フォルダブラウザへ戻り再度 sample-project を開く（再読込）。
  // afterEach の git clean -fdx が speedData.ts（untracked）を削除するため
  // テスト内で先にアサートを完了させる。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // メイン動画トラック見出しを再選択。
  await page.locator('.tl-track-label', { hasText: '動画' }).first().click();

  // 再読込後もバッジが "0.50x" のまま保持されている。
  await expect(page.locator('.tl-main-speed-badge')).toHaveText('0.50x');

  // JS の未捕捉例外が無い。
  expect(pageErrors).toEqual([]);
});

test('区間ごと速度: 区間クリック→0.5x→保存→再読込で保持', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    // フィクスチャの main.mp4 は 62 バイトのスタブのため Remotion が MediaPlaybackError を
    // スローする。これは UI の問題ではないのでフィルタアウトする。
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // タイムラインの残す区間帯が出る（cutData.ts に 2 区間があるため）
  const kept = page.locator('.tl-kept-segment').first();
  await expect(kept).toBeVisible();

  // 区間をクリックするとインスペクタに区間速度パネルが出る
  await kept.click();
  await expect(page.locator('[data-cutsegment]')).toBeVisible();

  // 0.5x プリセットをクリックすると速度値が変わる
  await page.locator('[data-cutsegment] .ins-vi-speed-preset[data-rate="0.5"]').click();
  await expect(page.locator('[data-cutsegment] .ins-vi-speed-value')).toContainText('0.5');

  // 保存ボタンが有効になる
  const saveBtn = page.locator('.tb-save.enabled');
  await expect(saveBtn).toBeVisible();

  // 保存を実行 → 保存完了まで待つ
  await saveBtn.click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // --- 再読込して速度が保持されているか確認（ラウンドトリップ） ---
  // フォルダブラウザへ戻り、再度 sample-project を開く。
  // afterEach の git clean -fdx が speedData.ts（untracked）を削除するため
  // テスト内で先にアサートを完了させる。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({
    timeout: 15_000,
  });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 同じ区間（最初の残す区間）をクリックして区間速度インスペクタを開く
  const keptAfterReload = page.locator('.tl-kept-segment').first();
  await expect(keptAfterReload).toBeVisible();
  await keptAfterReload.click();

  // 速度値が保存した 0.5 のまま残っていることを確認する（区間速度のラウンドトリップ確認）
  await expect(page.locator('[data-cutsegment] .ins-vi-speed-value')).toContainText('0.5', {
    timeout: 5_000,
  });

  // JS の未捕捉例外が無い。
  expect(pageErrors).toEqual([]);
});

test('古い同梱部品があると⚠バッジに通知が出て、更新すると消える', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    // フィクスチャの main.mp4 は 62 バイトのスタブのため Remotion が MediaPlaybackError を
    // スローする。これは UI の問題ではないのでフィルタアウトする。
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // sample-project の InsertShape は version 無し marker → 古い → ⚠ バッジに合算される。
  const badge = page.locator('.tb-warn-badge');
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await badge.click();
  const packRow = page.locator('.tb-pack-upgrade');
  await expect(packRow).toBeVisible();

  // 更新する → 部品更新の通知が消える。
  await page.locator('.pack-upgrade-btn').click();
  await expect(packRow).toBeHidden({ timeout: 15_000 });

  // JS の未捕捉例外が無い
  expect(pageErrors).toEqual([]);
});

test('メイン動画レイアウト: 大きさ設定→保存→再読込で保持', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // メイン動画トラック選択 → レイアウトの大きさを 1.4 に。
  await page.locator('.tl-track-label', { hasText: '動画' }).first().click();
  await expect(page.locator('[data-mainlayout]')).toBeVisible();
  await page.locator('#ins-main-scale').fill('1.4');
  await expect(page.locator('.ins-ml-scale-value')).toHaveValue('1.40');

  // 未保存 → 保存 → 保存済み。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // 開き直し（afterEach の git clean が mainLayoutData.ts を消す前にアサート）。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 再選択 → 大きさが 1.40 のまま保持。
  await page.locator('.tl-track-label', { hasText: '動画' }).first().click();
  await expect(page.locator('.ins-ml-scale-value')).toHaveValue('1.40');

  expect(pageErrors).toEqual([]);
});

test('メイン動画レイアウト: 導入で MainVideo が <MainLayout> でラップ＋mainLayoutData 生成', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // メイン動画トラック選択 → レイアウトの大きさを 1.4 に。
  await page.locator('.tl-track-label', { hasText: '動画' }).first().click();
  await expect(page.locator('[data-mainlayout]')).toBeVisible();
  await page.locator('#ins-main-scale').fill('1.4');
  await expect(page.locator('.ins-ml-scale-value')).toHaveValue('1.40');

  // 未保存 → 保存（導入は dirty 中は無効なので先に保存）。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  // 導入前は「カラー補正が書き出しに反映されない」注意書きが出ている（＝未導入の観測点）。
  await expect(page.locator('#ins-color-unsupported')).toHaveCount(1);

  // レイアウトを書き出しに導入 → 再読込（プレビュー再マウント）。
  const installBtn = page.locator('#ins-mainlayout-install');
  await expect(installBtn).toBeEnabled();
  await installBtn.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
  // 導入完了の観測点。プレビューの可視状態は導入前から真なので完了の合図にならない
  // （ここで待たずにファイルを読むと、書込前の内容を読んでしまう競走になる）。
  // 注意書きの消滅は「サーバが導入を終え、案件を読み直した」ことでしか起きない。
  await expect(page.locator('#ins-color-unsupported')).toHaveCount(0, { timeout: 20_000 });

  // afterEach の git clean が戻す前に、install 結果をファイルで確認。
  const mainVideo = readFileSync(join(FIXTURE_DIR, 'src', 'MainVideo.tsx'), 'utf8');
  expect(mainVideo).toContain('<MainLayout layout={MAIN_LAYOUT}');
  expect(mainVideo).toContain('segmentLayouts={SEGMENT_LAYOUTS}');
  expect(mainVideo).toContain("import { MainLayout } from './MainLayout';");
  expect(mainVideo).toContain("import { SEGMENT_LAYOUTS, LAYOUT_KEYFRAMES } from './mainLayoutData';");
  expect(mainVideo).toContain('layoutKeyframes={LAYOUT_KEYFRAMES}');
  expect(mainVideo).toContain("import { cutData } from './cutData';");
  expect(existsSync(join(FIXTURE_DIR, 'src', 'mainLayoutData.ts'))).toBe(true);
  expect(existsSync(join(FIXTURE_DIR, 'src', 'MainLayout', 'main-layout.json'))).toBe(true);
  expect(readFileSync(join(FIXTURE_DIR, 'src', 'mainLayoutData.ts'), 'utf8')).toContain('MAIN_LAYOUT');

  // 再バンドルでエラーが出ていない（payload が自己完結・import 解決が通っている証跡）。
  expect(pageErrors).toEqual([]);
});

test('メイン動画: 大域キーフレーム（プリセット糖衣）を設定→保存→再読込で復元', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // メイン動画トラック見出し（ラベル「動画」）を選択 → メイン動画パネル＋KFセクションが出る。
  const mainTrack = page
    .locator('.tl-track-label-clickable')
    .filter({ has: page.locator('.tl-track-name', { hasText: /^動画$/ }) })
    .first();
  await expect(mainTrack).toBeVisible();
  await mainTrack.click();
  await expect(page.locator('[data-mainkeyframes]')).toBeVisible();

  // 初期状態はキーフレーム 0 個 → 一覧は非表示。
  await expect(page.locator('[data-testid="ins-main-keyframes"]')).toHaveCount(0);

  // ◆で現在位置（frame 0）に 1 点打つ → ルーラーで再生ヘッドを動かして 2 点目を打つ。
  await page.locator('#ins-kf-punch').click();
  await expect(page.locator('[data-testid="ins-main-keyframes"] .ins-kf-point')).toHaveCount(1);
  const kfRuler = page.locator('.tl-ruler');
  const kfRbox = await kfRuler.boundingBox();
  expect(kfRbox).not.toBeNull();
  await page.mouse.click(kfRbox!.x + 260, kfRbox!.y + kfRbox!.height / 2);
  await page.locator('#ins-kf-punch').click();
  await expect(page.locator('[data-testid="ins-main-keyframes"] .ins-kf-point')).toHaveCount(2);

  // 2 点目の大きさを 1.80 へ編集 → 値が反映される。
  await page.locator('#ins-kf1-scale').fill('1.8');
  await page.locator('#ins-kf1-scale').press('Enter');
  await expect(page.locator('#ins-kf0-scale')).toHaveValue('1.00');
  await expect(page.locator('#ins-kf1-scale')).toHaveValue('1.80');

  // タイムライン上に diamond マーカーが最低 1 点出る（先頭KF＝原本フレーム0は常に可視）。
  expect(await page.locator('.kf-marker').count()).toBeGreaterThanOrEqual(1);

  // 未保存 → 保存 → 保存済み。
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // 保存済み mainLayoutData.ts に LAYOUT_KEYFRAMES（原本フレームアンカーの配列）として書き出されている。
  const mainLayoutData = readFileSync(join(FIXTURE_DIR, 'src', 'mainLayoutData.ts'), 'utf8');
  expect(mainLayoutData).toContain('LAYOUT_KEYFRAMES');
  expect(mainLayoutData).toContain('originalFrame');
  expect(mainLayoutData).toContain('scale: 1.8');

  // 開き直し（reload）→ メイン動画を再選択 → キーフレームの値が復元されている。
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: 'sample-project' })).toBeVisible({ timeout: 15_000 });
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page
    .locator('.tl-track-label-clickable')
    .filter({ has: page.locator('.tl-track-name', { hasText: /^動画$/ }) })
    .first()
    .click();
  await expect(page.locator('[data-mainkeyframes]')).toBeVisible();
  await expect(page.locator('[data-testid="ins-main-keyframes"] .ins-kf-point')).toHaveCount(2);
  await expect(page.locator('#ins-kf0-scale')).toHaveValue('1.00');
  await expect(page.locator('#ins-kf1-scale')).toHaveValue('1.80');

  expect(pageErrors).toEqual([]);
});

test('画像クリップを右端つまみの実マウスドラッグで伸ばせる（overflow ヒットテスト回帰）', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const before = await page.locator('.tl-image-block').count();
  await clickAddMenuItem(page, '.tl-image-add');
  await expect(page.locator('.tl-image-block')).toHaveCount(before + 1);

  // 右端つまみを実マウスでドラッグ（dispatchEvent ではなくヒットテスト経由であることが本テストの主旨。
  // 旧 CSS の .tl-image-block { overflow: hidden } はつまみをヒットテスト不能にしていた）。
  const clip = page.locator('.tl-image-block').last();
  await clip.scrollIntoViewIfNeeded();
  const w0 = (await clip.boundingBox())!.width;
  const hBox = await clip.locator('.tl-image-handle-end').boundingBox();
  if (!hBox) throw new Error('no end handle box');
  const hx = hBox.x + hBox.width / 2;
  const hy = hBox.y + hBox.height / 2;
  await page.mouse.move(hx, hy);
  await page.mouse.down();
  await page.mouse.move(hx + 60, hy, { steps: 6 });
  await page.mouse.up();

  await expect
    .poll(async () => (await clip.boundingBox())!.width, { timeout: 5_000 })
    .toBeGreaterThan(w0 + 30);
});

test('カットブロッククリック→統合ボタンが「カットを開ける」になり開けられる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // sample-project fixture は cutData.ts のギャップ（[5000,6000)）で既に1本カット区間を持つ。
  // このテストではさらに1本追加して、追加した方（最後尾）を開ける導線を検証する。
  const cutsBefore = await page.locator('.tl-cut').count();

  // --- 既存のカット作成手順（範囲選択カット）に倣い、カット区間を1つ作る ---
  const cutTrack = page.locator('.tl-track-cut');
  const box = await cutTrack.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 144, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 204, y, { steps: 5 });
    await expect(page.locator('.tl-cut-selection')).toBeVisible();
    await page.mouse.up();
    const cutBtn = page.locator('.tl-cut-confirm');
    await expect(cutBtn).toBeEnabled();
    await cutBtn.click();
    await expect(page.locator('.tl-cut')).toHaveCount(cutsBefore + 1);
  }

  // --- 追加したカットブロック本体をクリック → 開ける導線 ---
  await page.locator('.tl-cut').last().click();
  const btn = page.locator('.tl-cut-confirm');
  await expect(btn).toHaveText('カットを開ける');
  await btn.click();
  await expect(page.locator('.tl-cut')).toHaveCount(cutsBefore);
});

test('＋追加メニューは外側クリックと Esc で閉じる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.tl-add-menu-btn').click();
  await expect(page.locator('.tl-add-menu .dd-menu')).toBeVisible();
  await page.locator('.pv-stage').click();
  await expect(page.locator('.tl-add-menu .dd-menu')).toHaveCount(0);
  await page.locator('.tl-add-menu-btn').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tl-add-menu .dd-menu')).toHaveCount(0);
  await expect(page.locator('.tl-add-menu-btn')).toBeFocused();
});

test('素材ライブラリ: Finder からのファイルドロップで素材が追加される', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="se"]').click();

  // 1x1 PNG（最小の実画像）を DataTransfer に載せて .material-lib へドロップする。
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await page.locator('.material-lib').evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'ドロップ画像.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  }, pngBase64);

  // 拡張子 png → 画像タブへ自動で切り替わり、新素材のサムネセルが出る。
  await expect(page.locator('.ml-tab[data-kind="image"]')).toHaveClass(/active/, { timeout: 10_000 });
  await expect(page.locator('.ml-cell', { hasText: 'ドロップ画像.png' })).toBeVisible({ timeout: 10_000 });

  // もう一度同じ名前をドロップ → 上書きせず連番（-2）が付く。
  await page.locator('.material-lib').evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'ドロップ画像.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  }, pngBase64);
  await expect(page.locator('.ml-cell', { hasText: 'ドロップ画像-2.png' })).toBeVisible({ timeout: 10_000 });

  // 対応外の拡張子はスキップされ、トーストで知らせる。
  await page.locator('.material-lib').evaluate((el) => {
    const file = new File([new Uint8Array([1])], 'メモ.pdf', { type: 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  });
  await expect(page.locator('.sme-toast')).toContainText('メモ.pdf');
});

// I-2: playwright.config.ts の SME_AUTO_SAVE=0 で自動保存は既定 OFF（保存系 e2e のフレーク防止）。
// このテストだけ localStorage を明示的に ON にし、待ち時間短縮クエリ（autoSaveDelayMsForTest）を
// 使って「編集→放置→自動で保存済みに戻る」ことを検証する。
test('自動保存: 編集→放置すると保存ボタンを押さずに自動で「保存済み」へ戻る', async ({ page }) => {
  // App.tsx マウント前に localStorage へ明示 ON を書き込む
  // （hasExplicitAutoSavePref が true になり、サーバ既定 OFF での上書きを回避する）。
  await page.addInitScript(() => {
    localStorage.setItem('sme-auto-save-enabled', '1');
  });

  await page.goto('/?autoSaveDelayMsForTest=500');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  const editor = page.locator('.tx-row.selected .tx-text-edit');
  await expect(editor).toBeVisible();

  await editor.fill('自動保存テスト');
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();
  // フォーカスがテキスト編集要素にある間は自動保存が延期され続けるため、他要素へフォーカスを外す
  // （実際の利用でも「入力し終えて手を離す」操作に相当する）。
  await page.locator('.tl-head').click();

  // 保存ボタンをクリックせず放置。500ms の静止で自動保存が発火し「保存済み」に戻る。
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);
});

test('テロップ複数選択: Cmd＋クリックで2個選び位置を一括変更→保存、飾りテロップ2個をDeleteで一括削除→保存', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // --- 1) じまく 2 本を Cmd＋クリックで複数選択する -------------------------
  const jimaku = page.locator('.tl-track-jimaku .tl-telop');
  await jimaku.nth(0).click();
  await jimaku.nth(1).click({ modifiers: ['Meta'] });

  // 設定タブに一括パネルが出る（単一選択の #ins-pos-x ではなく #ins-multi-pos-x）。
  await page.locator('.rightdock-tab[data-tab="settings"]').click();
  await expect(page.locator('#ins-multi-pos-x')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.ins-body')).toContainText('テロップ 2 個を選択中');

  // --- 2) 位置を一括変更する（確定は Enter）--------------------------------
  await page.locator('#ins-multi-pos-x').fill('-0.5');
  await page.locator('#ins-multi-pos-x').press('Enter');
  await page.locator('#ins-multi-pos-y').fill('-0.4');
  await page.locator('#ins-multi-pos-y').press('Enter');

  // --- 3) 保存して telopData.ts に両方の position が入ることを数値アサート ---
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  const telopPath = resolve(FIXTURE_DIR, 'src', 'テロップテンプレート', 'telopData.ts');
  const afterPosition = readFileSync(telopPath, 'utf8');
  const posOf = (id: number): { x: number; y: number } | null => {
    const m = afterPosition.match(new RegExp(`id:\\s*${id},[\\s\\S]*?position:\\s*\\{ x: (-?[\\d.]+), y: (-?[\\d.]+) \\}`));
    return m === null ? null : { x: Number(m[1]), y: Number(m[2]) };
  };
  expect(posOf(1)).toEqual({ x: -0.5, y: -0.4 });
  expect(posOf(2)).toEqual({ x: -0.5, y: -0.4 });
  // 選択していない id:3 には波及しない。
  expect(posOf(3)).toBeNull();

  // --- 4) 飾りテロップを 2 本足して保存（削除の前後差を作る）---------------
  await clickAddMenuItem(page, '.tl-telop-add');
  await clickAddMenuItem(page, '.tl-telop-add');
  const manual = page.locator('.tl-track-telop .tl-telop');
  await expect(manual).toHaveCount(2);
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });
  expect(readFileSync(telopPath, 'utf8').match(/新しいテロップ/g)?.length).toBe(2);

  // --- 4b) 2 本を複数選択 → Delete で一括削除 ------------------------------
  await manual.nth(0).click();
  await manual.nth(1).click({ modifiers: ['Meta'] });
  await expect(page.locator('.ins-body')).toContainText('テロップ 2 個を選択中');

  await page.keyboard.press('Delete');
  await expect(page.locator('.tl-track-telop .tl-telop')).toHaveCount(0);

  // --- 5) 保存して telopData.ts から消えていることをアサート ---------------
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  const afterDelete = readFileSync(telopPath, 'utf8');
  expect(afterDelete).not.toContain('新しいテロップ');
  // 字幕 3 本はそのまま残る（削除対象は飾りテロップだけ）。
  expect(afterDelete.match(/id:\s*\d+,/g)?.length).toBe(3);

  expect(pageErrors).toEqual([]);
});

// ============================================================================
// 選択枠実測（measured-overlay・2026-08-19）
// jsdom では getBoundingClientRect が全ゼロ＝常にフォールバック経路なので、
// 「実測が効いている」ことを証明できるのはここ（実ブラウザ）だけ。
// ============================================================================

/** 実測用に差し替える本物の PNG（240×160・単色）。フィクスチャの sample.png は 16 バイトの
 *  スタブで画像として読めず、img の実寸が 0 になるため実測できない。afterEach の
 *  `git checkout` がスタブへ戻す。 */
const REAL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAABRElEQVR42u3SQQ0AAAjEsNOHOawhCRV8SJMqWJbqgTciAYYGQ4OhwdAYGgwNhgZDg6ExNBgaDA2GBkNjaDA0GBoMDYbG0GBoMDQYGgyNocHQYGgwNBgaQ4OhwdBgaDA0hgZDg6HB0BgaDA2GBkODoTE0GBoMDYYGQ2NoMDQYGgwNhsbQYGgwNBgaDI2hwdBgaDA0GBpDg6HB0GBoMDSGBkODocHQYGgMDYYGQ4OhMTQYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6ExtAoYGgwNhgZDY2gwNBgaDA2GxtBgaDA0GBoMjaHB0GBoMDQYGkODocHQYGgwNIYGQ4OhwdBgaAwNhgZDg6HB0BgaDA2GBkNjaDA0GBoMDYbG0GBoMDTcWHAtFJhrX5ijAAAAAElFTkSuQmCC';

/** 要素の client 矩形をプレーン値で取る（DOMRect は evaluate 越しに落ちるため）。 */
async function rectOf(page: Page, selector: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }, selector);
}

test('選択枠実測: テロップ枠が実描画要素の矩形と一致し source=measured になる', async ({ page }) => {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // 行クリックで「そのテロップの開始フレーム」へシークしつつ選択する（＝実描画が出る）。
  await page.locator('.tx-row').first().click();
  await expect(page.locator('.pv-telop-box')).toBeVisible();
  // 合成側の目印（実測ルートとテロップラッパー）が出ている。
  await expect(page.locator('[data-sme-root]')).toHaveCount(1);
  await expect(page.locator('[data-sme-kind="telop"]')).toHaveCount(1, { timeout: 10_000 });

  // 実測が効いたことをアサートする（フォールバックに失敗を隠させない・裁定 P1-2）。
  await expect
    .poll(async () => page.locator('.pv-telop-box').getAttribute('data-sme-box-source'), {
      timeout: 10_000,
    })
    .toBe('measured');

  const box = await rectOf(page, '.pv-telop-box');
  // **実際に文字が描かれている要素**（フィクスチャ Telop の <span>）。
  // ラッパー直下の div は全幅の透明レイアウト要素なので、そこと一致しても
  // 「見えているものを測れている」証拠にならない（合併規則 v2・レビュー P2-5）。
  const text = await rectOf(page, '[data-sme-kind="telop"] span');
  const root = await rectOf(page, '[data-sme-root]');
  if (box === null || text === null || root === null) throw new Error('矩形が取得できません');

  // 枠は実描画（文字）の矩形と一致する（0.5px 量子化ぶんの誤差だけ許容）。
  expect(Math.abs(box.x - text.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - text.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.w - text.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.h - text.h)).toBeLessThanOrEqual(1);

  // 全幅ではない（透明な行ラッパーを拾っていない）。
  expect(box.w).toBeLessThan(root.w * 0.9);
  // 従来の固定割合近似（幅 76% / 高さ 16%）とも明確に違う＝近似へ落ちていない。
  expect(Math.abs(box.w - root.w * 0.76)).toBeGreaterThan(5);
  expect(Math.abs(box.h - root.h * 0.16)).toBeGreaterThan(5);

  // --- ドラッグ「中」も測定が続き、枠が実描画へ追従する（レビュー P1-1）---
  // 移動量の基準は pointerdown 時の snapshot で凍結済みなので、表示の凍結は不要。
  // 枠が pointerdown 位置に置き去りになると、掴んだ先で操作できなくなる。
  const grab = await page.locator('.pv-telop-grab').boundingBox();
  if (!grab) throw new Error('.pv-telop-grab が取得できません');
  const gx = grab.x + grab.width / 2;
  const gy = grab.y + grab.height / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + 40, gy - 40, { steps: 6 });
  const during = await rectOf(page, '.pv-telop-box');
  await page.mouse.up();
  if (during === null) throw new Error('ドラッグ中の枠矩形が取得できません');
  expect(Math.abs(during.x - box.x) + Math.abs(during.y - box.y)).toBeGreaterThan(5);
  // ドラッグ中も実測のまま（フォールバックへ落ちていない）。
  expect(await page.locator('.pv-telop-box').getAttribute('data-sme-box-source')).toBe('measured');
});

test('選択枠実測: 挿入画像の枠が画像要素の実寸と一致する（全画面近似ではない）', async ({ page }) => {
  // 実寸を持つ画像へ差し替える（afterEach の git checkout でスタブへ戻る）。
  writeFileSync(
    resolve(FIXTURE_DIR, 'public', 'images', 'sample.png'),
    Buffer.from(REAL_PNG_B64, 'base64'),
  );

  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  await page.locator('.lc-tab[data-tab="materials"]').click();
  await page.locator('.ml-tab[data-kind="image"]').click();
  const cell = page.locator('.ml-grid .ml-cell').first();
  await cell.click();
  await cell.locator('.ml-cell-insert').click();

  await expect(page.locator('.pv-telop-box')).toBeVisible();
  await expect(page.locator('[data-sme-kind="image"]')).toHaveCount(1, { timeout: 10_000 });
  // 画像が実寸を持って読み込まれたことを先に確かめる（読めない画像なら実測はできないので、
  // 「measured にならない」ではなく「画像が読めていない」として落とす）。
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-sme-kind="image"] img');
          return el instanceof HTMLImageElement ? el.naturalWidth : 0;
        }),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  // 画像の load 後に再測が走る（img load 契機）。
  await expect
    .poll(async () => page.locator('.pv-telop-box').getAttribute('data-sme-box-source'), {
      timeout: 10_000,
    })
    .toBe('measured');

  const box = await rectOf(page, '.pv-telop-box');
  const img = await rectOf(page, '[data-sme-kind="image"] img');
  const root = await rectOf(page, '[data-sme-root]');
  if (box === null || img === null || root === null) throw new Error('矩形が取得できません');

  expect(Math.abs(box.x - img.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y - img.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.w - img.w)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.h - img.h)).toBeLessThanOrEqual(1);
  // 全画面×scale の近似ではない（240×160 の画像は縦動画の全画面と一致しない）。
  expect(box.h).toBeLessThan(root.h - 5);
});

test('選択枠実測: 図形をプレビューでクリック選択→移動→リサイズし保存に反映される', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  await page.locator('.home-card', { hasText: 'sample-project' }).click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  // --- 矢印を 1 本描く（既存の図形シナリオと同じ手順）---
  const arrowBtn = page.locator('.pv-shape-btn[title="矢印を描画（クリックで解除）"]');
  await arrowBtn.click();
  const contentBox = await page.locator('.pv-stage .__remotion-player').boundingBox();
  if (!contentBox) throw new Error('プレビュー内容の boundingBox が取得できません');
  const sx = contentBox.x + contentBox.width * 0.3;
  const sy = contentBox.y + contentBox.height * 0.4;
  const ex = contentBox.x + contentBox.width * 0.7;
  const ey = contentBox.y + contentBox.height * 0.6;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2, { steps: 5 });
  await page.mouse.move(ex, ey, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.tl-shape')).toHaveCount(1, { timeout: 5_000 });
  // 描画ツールを解除（選択・移動モードへ戻す）。
  await arrowBtn.click();
  await expect(arrowBtn).toHaveAttribute('aria-pressed', 'false');

  // --- いったん別の対象（じまくブロック）を選び、図形の選択を外す ---
  // 右ドックは図形選択で設定タブへ切り替わるため、文字起こしの行ではなくタイムラインで選ぶ。
  await page.locator('.tl-track-jimaku .tl-telop').first().click();
  await expect(page.locator('.pv-shape-box')).toHaveCount(0);

  // --- プレビュー上で図形をクリック選択（線分の帯に当てる）---
  await page.mouse.click((sx + ex) / 2, (sy + ey) / 2);
  await expect(page.locator('.pv-shape-box')).toHaveCount(1);
  await expect(page.locator('.pv-shape-handle')).toHaveCount(2); // arrow は端点 2 点

  // --- 本体ドラッグで移動（右へ 10%・上へ 5%）---
  const dx = contentBox.width * 0.1;
  const dy = -contentBox.height * 0.05;
  await page.mouse.move((sx + ex) / 2, (sy + ey) / 2);
  await page.mouse.down();
  await page.mouse.move((sx + ex) / 2 + dx, (sy + ey) / 2 + dy, { steps: 8 });
  await page.mouse.up();

  // --- ハンドル（終点）でリサイズ ---
  const handle = page.locator('[data-sme-shape-handle="x2y2"]');
  const hb = await handle.boundingBox();
  if (!hb) throw new Error('ハンドルの boundingBox が取得できません');
  const targetX = contentBox.x + contentBox.width * 0.9;
  const targetY = contentBox.y + contentBox.height * 0.8;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY, { steps: 8 });
  await page.mouse.up();

  // --- 保存して shapeData.ts の座標を数値アサート ---
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  const shapeDataPath = resolve(FIXTURE_DIR, 'src', 'InsertShape', 'shapeData.ts');
  const written = readFileSync(shapeDataPath, 'utf8');
  const num = (re: RegExp): number => {
    const v = written.match(re)?.[1];
    if (v === undefined) throw new Error(`shapeData.ts から座標を読めません: ${re}`);
    return Number(v);
  };
  // 始点は「描画 0.3 → 移動 +0.1」で 0.4 付近、y は「0.4 → -0.05」で 0.35 付近。
  expect(num(/x1:\s*([\d.]+)/)).toBeGreaterThan(0.33);
  expect(num(/x1:\s*([\d.]+)/)).toBeLessThan(0.47);
  // 上限は移動前の値 0.4 を**除外**する（移動が起きていないのに通る窓を作らない）。
  expect(num(/y1:\s*([\d.]+)/)).toBeGreaterThan(0.28);
  expect(num(/y1:\s*([\d.]+)/)).toBeLessThan(0.38);
  // 終点はハンドルで 0.9 / 0.8 付近へ動かした。
  expect(num(/x2:\s*([\d.]+)/)).toBeGreaterThan(0.83);
  expect(num(/y2:\s*([\d.]+)/)).toBeGreaterThan(0.73);

  expect(pageErrors).toEqual([]);
});

// ============================================================================
// 端ドラッグ自動スクロール（edge-autoscroll）＋ ＋追加メニューの「字幕」
// jsdom はレイアウトを持たない（scrollWidth/clientWidth/getBoundingClientRect が
// 全ゼロ）ため、実レイアウトの上で本当にスクロールするのはここでしか確かめられない。
// ============================================================================

test('端スクロール: ブロックを右端へドラッグしたまま止めると横スクロールし、ドラッグ値も前進する', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const body = page.locator('.tl-body');
  const scrollBefore = await body.evaluate((el) => el.scrollLeft);
  expect(scrollBefore).toBe(0);

  // じまく #2（原本 [200,320)）を掴む。右隣の字幕は原本 6000 なので右へ大きく動かせる。
  const block = page.locator('.tl-track-jimaku .tl-telop').nth(1);
  const blockBox = await block.boundingBox();
  const bodyBox = await body.boundingBox();
  expect(blockBox).not.toBeNull();
  expect(bodyBox).not.toBeNull();
  if (blockBox === null || bodyBox === null) return;

  const y = blockBox.y + blockBox.height / 2;
  await page.mouse.move(blockBox.x + blockBox.width / 2, y);
  await page.mouse.down();
  // 可視域の右端から 10px（EDGE_ZONE_PX=40 の内側）へ運び、そこで止める。
  await page.mouse.move(bodyBox.x + bodyBox.width - 10, y, { steps: 8 });

  // 止めた直後のドラッグ値（ブロックの content 座標 left）。以降はポインタを
  // 一切動かさないので、これが増えるならスクロールに値が追従している証拠になる。
  const leftAtEdge = await block.evaluate((el) => parseFloat(el.style.left));

  await expect.poll(async () => body.evaluate((el) => el.scrollLeft), { timeout: 10_000 })
    .toBeGreaterThan(200);
  // ここが本命の判定。Chromium はドラッグ中の端で**素の**オートスクロールも起こすため
  // scrollLeft だけでは機能の有無を分離できない（実測: 本機能を殺しても上の行は通った）。
  // 素のオートスクロールは move を再実行しないのでドラッグ値は凍る＝下の行だけが落ちる。
  await expect.poll(async () => block.evaluate((el) => parseFloat(el.style.left)), { timeout: 10_000 })
    .toBeGreaterThan(leftAtEdge + 100);

  // 端ゾーンから抜けてオートスクロールを止める。
  // ここを止めずに値を採ると、**採ってから mouse.up() が届くまでの間に rAF がもう一段
  // 進める**ため、pointerup 後の確定値と一致しない（実測: フルスイート 4 ラン中 1 ランで
  // 1585 を採った直後に 1600 まで進み、下の等値判定が落ちた）。判定したいのは
  // 「確定が走って位置が保たれるか」であって「動いている値を一発で捕まえられるか」ではない。
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, y);
  // 値が実際に止まったことを確かめてから採る（時間で待たない）。
  let lastLeft = Number.NaN;
  await expect
    .poll(
      async () => {
        const now = await block.evaluate((el) => parseFloat(el.style.left));
        const settledNow = now === lastLeft;
        lastLeft = now;
        return settledNow;
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  // 離す直前のドラッグ値。これが pointerup 後も保たれていれば「確定した」証拠になる。
  const leftBeforeUp = await block.evaluate((el) => parseFloat(el.style.left));
  expect(leftBeforeUp, '端ゾーンを抜けた後も値が動いている').toBe(lastLeft);
  await page.mouse.up();

  // 確定（onCommit）が走っていれば、コミット済み state から描き直した後も同じ位置。
  // クリック判定を生の画面 X で行っていると純クリック扱いでコミットが捨てられ、
  // ブロックは掴む前の位置（左）へ黙って戻る。
  await expect
    .poll(async () => block.evaluate((el) => parseFloat(el.style.left)), { timeout: 5_000 })
    .toBe(leftBeforeUp);

  // 離した後もスクロール位置は保たれ、rAF ループが暴走して増え続けない。
  const settled = await body.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(400);
  expect(await body.evaluate((el) => el.scrollLeft)).toBe(settled);

  expect(pageErrors).toEqual([]);
});

test('端スクロール: 待機中（掴まずに）カーソルを右端へ置くだけで横スクロールが続く', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const body = page.locator('.tl-body');
  const bodyBox = await body.boundingBox();
  expect(bodyBox).not.toBeNull();
  if (bodyBox === null) return;
  expect(await body.evaluate((el) => el.scrollLeft)).toBe(0);

  // 何も掴まずにカーソルを右端の発動域（可視幅の 4%）へ置き、**そこで止める**。
  const y = bodyBox.y + bodyBox.height / 2;
  await page.mouse.move(bodyBox.x + bodyBox.width - 6, y, { steps: 6 });

  // 止めたまま走り続ける（＝ホバー版が担当）。鮮度ガード 200ms で打ち切られていない
  // ことを、200ms より十分あとの到達量で確かめる。
  await expect.poll(async () => body.evaluate((el) => el.scrollLeft), { timeout: 10_000 })
    .toBeGreaterThan(300);

  // 中央へ戻せば止まる（可視域の外・発動域の外では速度 0）。
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, y, { steps: 4 });
  await page.waitForTimeout(300);
  const settled = await body.evaluate((el) => el.scrollLeft);
  await page.waitForTimeout(400);
  expect(await body.evaluate((el) => el.scrollLeft)).toBe(settled);

  expect(pageErrors).toEqual([]);
});

test('端スクロール: 右端すれすれのブロックは純クリックでは動かず、6px 超動かせば送れる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const body = page.locator('.tl-body');
  const bodyBox = await body.boundingBox();
  expect(bodyBox).not.toBeNull();
  if (bodyBox === null) return;

  // じまく #3（最後尾の字幕）を「右端から 20px の位置」＝端ゾーン（EDGE_ZONE_PX=40）の
  // 中へ持ってくる。content 座標は displayMap 依存なので決め打ちせず style.left を実測して使う。
  const block = page.locator('.tl-track-jimaku .tl-telop').nth(2);
  const leftBefore = await block.evaluate((el) => parseFloat(el.style.left));
  expect(leftBefore).toBeGreaterThan(bodyBox.width);
  // 掴む X は**可視域の右端からの固定オフセット**で決める（ブロックの boundingBox から
  // 決めない）。理由 = 実測した間欠赤の根本原因: 掴む前に scrollLeft が数十 px ドリフト
  // すると（下記 ①）ブロックが左へ寄り、box 基準の掴み点も一緒に左へ寄って端ゾーン
  // （右端 40px）の外へ出る。すると端スクロールは仕様どおり発動せず、poll が 10s
  // タイムアウトして「進まなかった」とだけ言う赤になる（run11: Expected > 6012 /
  // Received 5912 = 掴み点が右端から 100px の位置だった）。可視域の右端は動かないので、
  // ここを基準にすればドリフトに依らず必ず端ゾーンの中を掴める。
  const bodyRight = bodyBox.x + bodyBox.width;
  const grabX = bodyRight - 16;
  const scrollForEdge = leftBefore - bodyBox.width + 20;
  await body.evaluate((el, x) => { el.scrollLeft = x; }, scrollForEdge);

  const blockBox = await block.boundingBox();
  expect(blockBox).not.toBeNull();
  if (blockBox === null) return;
  const y = blockBox.y + blockBox.height / 2;

  /** 掴み点の真下に対象ブロックが実在することを確かめる（存在検査）。 */
  async function expectGrabPointOnBlock(): Promise<void> {
    const onBlock = await block.evaluate(
      (el, [px, py]) => {
        const top = document.elementFromPoint(px as number, py as number);
        return top !== null && (top === el || el.contains(top));
      },
      [grabX, y],
    );
    expect(onBlock, '掴み点の下に対象ブロックが居ない（掴めていない検査になる）').toBe(true);
  }

  // --- 1) 純クリック（実移動 2px）では動かない -------------------------------
  // 端ゾーンに居るブロックを選択のためにクリックしただけ。ここで端スクロールが
  // 走ると区間が動いて確定してしまう（2026-08-17 に潰した副作用の復活）。
  await expectGrabPointOnBlock();
  await page.mouse.move(grabX, y);
  await page.mouse.down();
  await page.mouse.move(grabX + 2, y);
  await page.waitForTimeout(500); // rAF を十分に回す時間
  await page.mouse.up();
  // scrollLeft は Chromium 自身のドラッグ時オートスクロールでも動きうるので見ない。
  // 「区間が動いていないか」＝ブロックの content 座標だけを見る。
  expect(await block.evaluate((el) => parseFloat(el.style.left))).toBe(leftBefore);

  // --- 2) しきい値（5px）を超えて動かせば端スクロールが始まり、確定まで通る -----
  // ①のドラッグ中に Chromium 自身のオートスクロールが scrollLeft を動かしている
  // ことがある（実測: 負荷の高いランで +84px）。②の前提「ブロックが右端 20px に居る」を
  // 引き継がず、**組み直してから**測る。まずポインタを中央へ戻してホバー版の端スクロールを
  // 止め（速度 0）、それから scrollLeft を置き直す。
  await page.mouse.move(bodyBox.x + bodyBox.width / 2, y);
  await body.evaluate((el, x) => { el.scrollLeft = x; }, scrollForEdge);
  expect(
    await body.evaluate((el) => el.scrollLeft),
    'scrollLeft の置き直しが効いていない',
  ).toBe(scrollForEdge);

  await expectGrabPointOnBlock();
  await page.mouse.move(grabX, y);
  await page.mouse.down();
  // 基準値は **pointerdown の後**に採る。掴む直前の move（ボタン 0）でホバー版の端スクロールが
  // 一瞬走るため、move の前に採ると「ホバー版が進めた分」で緑になりうる（＝ドラッグ版が
  // 死んでいても通る fail-open）。pointerdown はホバー版を capture phase で止めるので、
  // ここから先の増分はドラッグ版だけのもの。
  const scrollAtGrab = await body.evaluate((el) => el.scrollLeft);
  // 前提の存在検査: まだ右へスクロールする余地があること
  // （末尾まで来ていると端スクロールは仕様どおり動けず、検査が空振りする）。
  const room = await body.evaluate((el) => el.scrollWidth - el.clientWidth - el.scrollLeft);
  expect(room, '右へスクロールする余地が無い（端スクロールの検査にならない）').toBeGreaterThan(100);

  await page.mouse.move(grabX + 8, y);

  await expect.poll(async () => body.evaluate((el) => el.scrollLeft), { timeout: 10_000 })
    .toBeGreaterThan(scrollAtGrab + 100);

  const leftBeforeUp = await block.evaluate((el) => parseFloat(el.style.left));
  expect(leftBeforeUp).toBeGreaterThan(leftBefore + 50);
  await page.mouse.up();

  // 確定（onCommit）が走っていれば、コミット済み state から描き直しても同じ位置。
  await expect
    .poll(async () => block.evaluate((el) => parseFloat(el.style.left)), { timeout: 5_000 })
    .toBe(leftBeforeUp);

  expect(pageErrors).toEqual([]);
});

test('字幕追加: ＋追加メニューの「字幕」で空き区間へ足し、保存すると manual なしで telopData.ts へ入る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await page.goto('/');
  const item = page.locator('.home-card', { hasText: 'sample-project' });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

  const jimaku = page.locator('.tl-track-jimaku .tl-telop');
  await expect(jimaku).toHaveCount(3);

  // 再生ヘッドを原本フレーム 400 へ（字幕 #2 の終端 320 と #3 の開始 6000 の間＝空き区間）。
  // ガター 88px ぶんを足した content-x でルーラーをクリックする（既存 e2e と同じ換算）。
  const ruler = page.locator('.tl-ruler');
  const rbox = await ruler.boundingBox();
  expect(rbox).not.toBeNull();
  if (rbox === null) return;
  await page.mouse.click(rbox.x + 88 + 400, rbox.y + rbox.height / 2);

  await clickAddMenuItem(page, '.tl-subtitle-add');

  // 飾りテロップ行ではなく「じまく」行が 1 本増える。
  await expect(jimaku).toHaveCount(4);
  await expect(page.locator('.tl-track-telop .tl-telop')).toHaveCount(0);
  await expect(page.locator('.tl-track-jimaku .tl-telop', { hasText: '新しい字幕' })).toHaveCount(1);

  // 保存して telopData.ts を数値でアサートする。
  await expect(page.locator('.tb-save.enabled')).toBeVisible();
  await page.locator('.tb-save.enabled').click();
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({ timeout: 10_000 });

  const telopPath = resolve(FIXTURE_DIR, 'src', 'テロップテンプレート', 'telopData.ts');
  const written = readFileSync(telopPath, 'utf8');
  // 新字幕は id 4（既存 3 本の次）。fps=60・既定 3 秒 → 180 フレーム。
  const added = written.match(/\{\s*id:\s*4,[\s\S]*?\n {2}\}/)?.[0];
  expect(added).toBeDefined();
  expect(added).toContain('startFrame: 400,');
  expect(added).toContain('endFrame: 580,');
  expect(added).toContain('text: "新しい字幕"');
  // 字幕なので manual を書かない（書くと飾りテロップ扱いで別トラック・別色になる）。
  expect(added).not.toContain('manual');
  // 時間軸上の直前字幕（#2・template 2 / style normal）から見た目を継ぐ。
  expect(added).toContain('template: 2,');
  expect(added).toContain('style: "normal"');

  expect(pageErrors).toEqual([]);
});
