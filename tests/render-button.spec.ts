import { test, expect } from '@playwright/test';
import { DEFAULT_DUCKING } from '../src/app/edit/duckingSettings';
import { join } from 'node:path';
import { createTempProject, removeTempProject } from './helpers';
import { shotDir } from './shotDir';

// 書き出しボタンの e2e。webServer は SME_RENDER_MOCK=1（実プロセス非起動）で起動しており、
// mock は SME_RENDER_MOCK_DELAY_MS=4000 の間に 25%→50%→75%→100% を 1s 刻みで emit する。
// 失敗シナリオだけは server 全体で有効化される SME_RENDER_MOCK_FAIL を使わず、
// convert 失敗テストと同じ page.route 流儀で POST /api/render を 500 に差し替えて再現する
// （webServer が単一インスタンスのため、失敗モードを 1 テストだけに閉じ込められない）。


/**
 * このファイルは共有フィクスチャ `sample-project` を実書き出し・自動保存し、
 * 後片付けに `git checkout` / `git clean` を掛けていた。これは**並列に走る他 spec を壊す**:
 * - 書き出しジョブはサーバ側シングルトン（projectId キー）なので、同じ projectId で
 *   並列に走る本ファイルのテスト同士が互いの running/done を拾う
 *   （実測: `.tb-render-btn` が出ない・`保存済み` にならない）。
 * - `git checkout`/`git clean` は同じプロジェクトを開いている他タブから見ると
 *   **外部更新**そのもので、smoke.spec.ts の「自分の保存は外部更新バナーを誘発しない」を
 *   誤って赤くする（実測）。
 * - 書き出しの running → done エッジは、同じプロジェクトを開いている全タブで
 *   学習差分レビューの全画面モーダルを開き、AI タブのクリックを遮る（実測）。
 * テストごとに専用コピーを作って対象をずらせば、これらは原理的に起こらない。
 */
let projectId = '';
let projectDir = '';

test.beforeEach(() => {
  ({ id: projectId, dir: projectDir } = createTempProject('render-btn-tmp'));
});

// render ジョブマネージャは server 側シングルトンのため、テストが完了前に終わると
// 走りっぱなしのジョブが同 projectId で残る。各テスト後に DELETE で破棄してから
// 一時プロジェクトを消す（消し残しは後続ランのホーム一覧を汚染する）。
test.afterEach(async ({ page, request }) => {
  // まずページを閉じる。開いたままだとクライアント発の再取得・再送が削除中の
  // プロジェクトへ飛び、サーバーが out/ を作り直して ENOTEMPTY になる（実測）。
  await page.close();
  await request.delete(`/api/render?id=${projectId}`).catch(() => {});
  removeTempProject(projectDir);
});

/** プロジェクトを開いてプレビューがマウントされるまで待つ共通ヘルパ。 */
async function openSampleProject(page: import('@playwright/test').Page) {
  await page.goto('/');
  const item = page.locator('.home-card', { hasText: projectId });
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
}

/** 書き出しボタン → プリセットダイアログ → 開始、まで進める共通ヘルパ。 */
async function startExport(page: import('@playwright/test').Page) {
  await page.locator('.tb-render-btn').click();
  const dialog = page.locator('[data-testid="export-dialog"]');
  await expect(dialog).toBeVisible();
  await page.locator('[data-testid="export-start"]').click();
  await expect(dialog).toHaveCount(0);
}

test('書き出しボタンで進捗が進み、完了すると Finder 表示ボタンが出る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openSampleProject(page);

  // idle: 書き出しボタンが有効。
  await expect(page.locator('.tb-render-btn')).toBeVisible();
  await startExport(page);

  // running: 実行中グループが出る。
  const running = page.locator('.tb-render-running');
  await expect(running).toBeVisible();

  // 進捗％が表示される（mock は 1s 刻みで 25%→…。percent 確定でリング＋「N%」ラベルが出る）。
  // 横バー（.tb-render-bar）はコミット 74e9161（書き出し進捗を円形リング＋リング内％表示に変更）
  // で CircularProgress（svg.cp-ring[role="progressbar"]）へ置き換え済み。旧セレクタは
  // DOM に存在しなくなったため、このテストは製品側の変更に追従できず取り残されていた
  // （置き換え自体は意図した UI 変更で製品バグではない）。
  await expect(page.locator('svg.cp-ring[role="progressbar"]')).toBeVisible({ timeout: 8_000 });
  await expect(page.locator('.tb-render-running .tb-render-label')).toContainText(/\d+%/, {
    timeout: 8_000,
  });

  // 完了: 「✅ 完了」＋「Finderで表示」ボタンが出る（クリックはしない＝Finder は e2e 検証不能）。
  await expect(page.locator('.tb-render-done')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.tb-render-done .tb-render-label')).toContainText('完了');
  await expect(page.locator('.tb-render-reveal')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('書き出し実行中にキャンセルすると idle（書き出しボタン）へ戻る', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openSampleProject(page);

  await startExport(page);
  const running = page.locator('.tb-render-running');
  await expect(running).toBeVisible();

  // 実行中（完了は 4s 後）に × でキャンセル。
  await page.locator('.tb-render-running .tb-render-x').click();

  // idle へ戻る（書き出しボタンが再び出て、実行中グループは消える）。
  await expect(page.locator('.tb-render-btn')).toBeVisible({ timeout: 10_000 });
  await expect(running).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

/**
 * H-1（フルスイート e2e の間欠赤）の回帰テスト。
 *
 * 実行中表示（.tb-render-running）は POST /api/render の応答を待たずに出す（楽観的 running）。
 * そのためユーザーは**サーバにジョブが登録される前に**「×」を押せる。その DELETE は
 * 対象ジョブが無いため 404 で捨てられ、直後に登録されたジョブは誰にも止められないまま
 * 最後まで走る——押したキャンセルが黙って無効になる（＝データではなく操作の消失）。
 * フルスイートでは POST の往復が 44ms を超えた回にだけ表面化し、上の
 * 「書き出し実行中にキャンセルすると idle へ戻る」が回ごとに落ちていた。
 *
 * ここでは POST の到達だけを遅らせて、この順序を決定論的に作る。
 * 修正前は「✅ 完了」で終わり `.tb-render-btn` が戻らないことを実行して確認済み。
 */
test('ジョブ登録前（POST 応答前）に押したキャンセルも効く', async ({ page }) => {
  await openSampleProject(page);

  // POST だけをサーバ到達前に 1.5s 保留する（SSE の GET / DELETE は素通し）。
  let postSeenAt = 0;
  await page.route('**/api/render?*', async (route) => {
    if (route.request().method() === 'POST') {
      await new Promise((r) => setTimeout(r, 1500));
      postSeenAt = Date.now();
      await route.continue();
      return;
    }
    await route.continue();
  });

  // DELETE が実際に「ジョブ登録前」に着いたことを観測する（この前提が崩れたら
  // このテストは順序を検証していない＝空アサートになる）。
  let deleteSeenAt = 0;
  page.on('request', (req) => {
    if (req.method() === 'DELETE' && req.url().includes('/api/render') && deleteSeenAt === 0) {
      deleteSeenAt = Date.now();
    }
  });

  await page.locator('.tb-render-btn').click();
  const dialog = page.locator('[data-testid="export-dialog"]');
  await expect(dialog).toBeVisible();
  await page.locator('[data-testid="export-start"]').click();

  // POST の応答を待たずに実行中表示が出る（楽観的 running）。ここで「×」を押す。
  const running = page.locator('.tb-render-running');
  await expect(running).toBeVisible();
  await page.locator('.tb-render-running .tb-render-x').click();

  // idle へ戻る（押したキャンセルが効いている）。
  await expect(page.locator('.tb-render-btn')).toBeVisible({ timeout: 10_000 });
  await expect(running).toHaveCount(0);
  // 存在検査: DELETE は POST がサーバへ届くより前に出ていた（＝競合を本当に再現した）。
  expect(deleteSeenAt, 'DELETE が観測されていない').toBeGreaterThan(0);
  expect(deleteSeenAt, 'DELETE が POST 到達より後＝この回は競合を再現していない').toBeLessThan(postSeenAt);
});

test('未保存の変更があると書き出しは自動保存してから開始する', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  await openSampleProject(page);

  // テロップを編集して dirty 化する。
  const firstRow = page.locator('.tx-row').first();
  await firstRow.click();
  const editor = page.locator('.tx-row.selected .tx-text-edit');
  await expect(editor).toBeVisible();
  await editor.fill('書き出し自動保存テスト');
  await expect(page.locator('.tb-unsaved.dirty')).toBeVisible();

  // 書き出し（ダイアログ経由）→ まず保存が走って dirty が消える（保存成功後に render 開始）。
  await startExport(page);
  await expect(page.locator('.tb-unsaved').filter({ hasText: '保存済み' })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator('.tb-save-error')).toHaveCount(0);

  // 保存後に render が開始している（実行中グループが出る）。
  await expect(page.locator('.tb-render-running')).toBeVisible({ timeout: 10_000 });

  expect(pageErrors).toEqual([]);
});

test('書き出しが失敗するとエラー表示が出て閉じられる', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => {
    const msg = String(err);
    if (msg.includes('MediaPlaybackError')) return;
    pageErrors.push(msg);
  });

  // POST /api/render を 500 に差し替える（SSE の GET / DELETE は素通し）。
  await page.route('**/api/render?*', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'render-failed' }),
      });
      return;
    }
    await route.continue();
  });

  await openSampleProject(page);

  await startExport(page);

  // エラー表示（「書き出し失敗」）が出る。
  const errorBox = page.locator('.tb-render-error');
  await expect(errorBox).toBeVisible({ timeout: 10_000 });
  await expect(errorBox.locator('.tb-render-label')).toContainText('書き出し失敗');

  // × で閉じると idle（書き出しボタン）へ戻る。
  await errorBox.locator('.tb-render-x').click();
  await expect(page.locator('.tb-render-btn')).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test('軽量プリセットを選ぶと POST body に 720p/light が載り、選択が記憶される', async ({ page }) => {
  await openSampleProject(page);

  await page.locator('.tb-render-btn').click();
  const dialog = page.locator('[data-testid="export-dialog"]');
  await expect(dialog).toBeVisible();

  // 3番目のプリセット＝軽量・確認用（720p）を選択。
  await dialog.locator('.export-preset', { hasText: '軽量' }).click();

  const reqPromise = page.waitForRequest(
    (req) => req.url().includes('/api/render') && req.method() === 'POST',
  );
  await page.locator('[data-testid="export-start"]').click();
  const req = await reqPromise;
  // App.tsx の handleRenderStart はセッションが有る限り「現在の ducking 設定」を必ず同梱する
  // （fastCutPlan が ducking の有無で Remotion 退避を判断するため。コミット 91b99696 で
  // ducking の同梱が全一致化された）。ダイアログのプリセット選択（resolution/quality）とは
  // 独立した項目で、フレッシュな各テストの browser context では localStorage が空のため
  // DEFAULT_DUCKING（sample-project の project-config.json も ducking 未指定）になる。
  // 旧アサーションはこの同梱を知らず resolution/quality だけを期待していた（製品バグではない）。
  expect(req.postDataJSON()).toEqual({ resolution: '720p', quality: 'light', ducking: DEFAULT_DUCKING });

  await expect(page.locator('.tb-render-running')).toBeVisible();

  // localStorage に記憶され、次回ダイアログの初期選択になる。
  const stored = await page.evaluate(() => localStorage.getItem('sme:render-preset'));
  expect(JSON.parse(stored!)).toEqual({ resolution: '720p', quality: 'light' });
});

/**
 * H-3（G-4 が持ち込んだ退行の回帰テスト）。
 *
 * 経緯: 書き出し中の通知は元々ツールバーの書き出し帯から
 * `position:absolute; top:calc(100% + 6px); right:0` で浮いていた。真下は右ドックのタブ帯
 * （文字起こし/設定/AI）で、G-4 は「下の文字と重なって読めない」を面の不透明化で塞ぎ、
 * 「タブが押せない」を `pointer-events:none` で塞いだ。結果、
 *   (a) 書き出し中はタブが**完全に見えない**（押せても見えない＝操作できない）
 *   (b) title ツールチップが永久に出ない
 *   (c) 通知が 2 つ立つと同じ絶対位置に重なり、不透明な今は片方が完全に隠れる
 * が残った。根本原因は「置き方」＝他の UI の上へ浮かせたこと。通知はツールバー直下の
 * バナー枠（.conv-banner-slot）へ流し込み、浮かせない。
 */
for (const theme of ['light', 'dark'] as const) {
test(`H-3: 書き出し中の通知が右ドックのタブを覆わない（見えて押せて、ツールチップも出る・${theme}）`, async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('sme-theme', t as string), theme);
  await openSampleProject(page);
  await startExport(page);
  await expect(page.locator('.tb-render-running')).toBeVisible({ timeout: 15_000 });

  // 存在検査: 通知とタブ帯の**両方**が実在する（どちらかが無ければこの検査は無意味）。
  const note = page.locator('[data-testid="export-notices"] [data-notice="fastcut"]');
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.rightdock-tabs')).toBeVisible();
  expect(await page.locator('.rightdock-tab').count()).toBeGreaterThanOrEqual(3);
  const noteBox = await note.boundingBox();
  expect(noteBox!.width).toBeGreaterThan(100);
  expect(noteBox!.height).toBeGreaterThan(10);

  // 1. 通知はタブ帯と 1px も重ならない（覆っていない）。
  const overlap = await page.evaluate(() => {
    const n = document.querySelector('[data-notice="fastcut"]')!.getBoundingClientRect();
    const t = document.querySelector('.rightdock-tabs')!.getBoundingClientRect();
    const w = Math.min(n.right, t.right) - Math.max(n.left, t.left);
    const h = Math.min(n.bottom, t.bottom) - Math.max(n.top, t.top);
    return w > 0 && h > 0 ? w * h : 0;
  });
  expect(overlap, '通知が右ドックのタブ帯を覆っている').toBe(0);

  // 2. 各タブの中心が本当にタブ自身に当たる（＝上に何も乗っていない）。
  const hits = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.rightdock-tab')).map((el) => {
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { tab: el.getAttribute('data-tab'), own: el.contains(hit) };
    }),
  );
  for (const h of hits) expect(h.own, `タブ ${h.tab} の上に別の面が乗っている`).toBe(true);

  // 3. 通知は当たり判定を持ち（pointer-events を切っていない）、ツールチップを持つ。
  const style = await note.evaluate((el) => ({
    pointer: getComputedStyle(el).pointerEvents,
    title: el.getAttribute('title') ?? '',
    bg: getComputedStyle(el).backgroundColor,
  }));
  expect(style.pointer, 'pointer-events:none だと title ツールチップが出ない').not.toBe('none');
  expect(style.title.length).toBeGreaterThan(0);
  expect(style.bg, '通知の背景が透明で下の文字が透ける').not.toMatch(/rgba\([^)]*,\s*0?(\.\d+)?\)$/);

  // 4. 実際にタブを押せて切り替わる。
  await page.locator('.rightdock-tab[data-tab="settings"]').click({ timeout: 5_000 });
  await expect(page.locator('.rightdock-tab[data-tab="settings"]')).toHaveClass(/active/);
  await page.locator('.rightdock-tab[data-tab="ai"]').click({ timeout: 5_000 });
  await expect(page.locator('.rightdock-tab[data-tab="ai"]')).toHaveClass(/active/);
});

test(`H-3: 通知が 2 つ同時に出ても互いを隠さない（縦に積み、間隔を空ける・${theme}）`, async ({ page }) => {
  await page.addInitScript((t) => localStorage.setItem('sme-theme', t as string), theme);
  await openSampleProject(page);
  // mock 書き出しでは「高速→互換経路へやり直し」の warning が立たない（実 ffmpeg が要る）ため、
  // POST に mock 限定スイッチを足して同じ状態を作る（renderApi.ts の mockWarning）。
  await page.route('**/api/render?*', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    return route.continue({ url: `${req.url()}&mockWarning=1` });
  });
  await startExport(page);

  const notices = page.locator('[data-testid="export-notices"] [role="note"]');
  await expect(notices).toHaveCount(2, { timeout: 15_000 });
  const boxes = await notices.evaluateAll((els) =>
    els.map((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
    }),
  );
  // 存在検査: どちらも面積を持つ（0 サイズの要素は重ならないので検査が空振りする）。
  for (const b of boxes) {
    expect(b.w).toBeGreaterThan(100);
    expect(b.h).toBeGreaterThan(10);
  }
  // 互いに重ならず、縦に間隔が空いている。
  const [a, b2] = boxes as [typeof boxes[0], typeof boxes[0]];
  const vGap = Math.max(a.top, b2.top) - Math.min(a.bottom, b2.bottom);
  expect(vGap, '2 つの通知が重なっている／隙間なく密着している').toBeGreaterThanOrEqual(4);
  // どちらのテキストも読める（片方が空でない）。
  const texts = await notices.allInnerTexts();
  expect(texts[0]!.length).toBeGreaterThan(5);
  expect(texts[1]!).toContain('互換(Remotion)経路');
  // タブ帯は依然として覆われない。
  const overlap = await page.evaluate(() => {
    const t = document.querySelector('.rightdock-tabs')!.getBoundingClientRect();
    return Array.from(document.querySelectorAll('[data-testid="export-notices"] [role="note"]')).reduce((acc, el) => {
      const n = el.getBoundingClientRect();
      const w = Math.min(n.right, t.right) - Math.max(n.left, t.left);
      const h = Math.min(n.bottom, t.bottom) - Math.max(n.top, t.top);
      return acc + (w > 0 && h > 0 ? w * h : 0);
    }, 0);
  });
  expect(overlap, '通知が右ドックのタブ帯を覆っている').toBe(0);

  // 実物を画像として残す（DOM の PASS は破綻の不在を意味しない）。
  await page.screenshot({ path: join(shotDir('H-3'), `export-notices-2-${theme}.png`), animations: 'disabled' });
});

}
