import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, expect } from '@playwright/test';
import { createTempProject, PRISTINE_SAMPLE_PROJECT, removeTempProject } from './helpers';

/**
 * フィクスチャプロジェクト（sample-project）の `.sme/status.json` パス。
 * dev サーバーは playwright.config.ts の SME_PROJECT_ROOT で
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


/**
 * `POST /api/project/status` の応答を待つ Promise を作る。
 * サーバーはこのリクエストの中で `.sme/status.json` を**同期的に**書くため、
 * 応答が返った時点で書き込みは完了している。バッジ操作の直後に一時プロジェクトを
 * 削除するテストは、これを待たずに `rmSync` すると
 * 「削除中にサーバーが `.sme/` を作り直す」→ `ENOTEMPTY` で削除が失敗し、
 * 残骸が後続ランへ漏れる（実測の根本原因）。
 */
function waitStatusWritten(page: import('@playwright/test').Page): Promise<unknown> {
  return page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/project/status' && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
}

/**
 * 別プロセス（スキル・AI エージェント）を模して `.sme/status.json` を書く。
 *
 * **一時ファイル→rename で置く**。直接 writeFileSync すると、サーバの watcher が
 * 書き終える前のファイルを読みうる（`readStatusFile` は解析に失敗すると activity なしへ
 * 黙って倒れ、mtime は既に動いているので**次のイベントが来ない**＝「作業中」が永久に出ない）。
 * 実測（本ブランチ・フルスイート再検証 3 巡目 6 ラン目）: `fb-working` が 15s 待っても付かず赤。
 * 製品側の書き込み（writeStatusStage）も同じ理由で rename 方式に直してある。
 */
function writeStatusFileAtomic(statusFile: string, data: unknown): void {
  mkdirSync(dirname(statusFile), { recursive: true });
  const tmp = `${statusFile}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, statusFile);
}

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
  // 共有フィクスチャ sample-project の .sme/status.json を直接ポーリングするテストのため、
  // 専用コピーへ隔離する（詳細は下記「サイドバー: activity」テストと同じ理由）。
  // default project 側の smoke.spec.ts は自身の全テストの afterEach で
  // `git clean -fdx sample-project` を実行する（.sme/ は gitignore 済み＝-x で対象）。
  // これは smoke.spec.ts の実行時間（フルスイート全体とほぼ同じ長さ）にわたって
  // 一つの worker から数百ms間隔で継続的に発火し続けるため、sample-project を直接
  // 触るこのテストの poll と衝突しうる（実測: フルスイート限定 flaky。単体では非再現）。
  const projectId = `status-badge-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const projectDir = join(import.meta.dirname, '..', 'src/server/__fixtures__', projectId);
  const statusFile = join(projectDir, '.sme', 'status.json');
  cpSync(PRISTINE_SAMPLE_PROJECT, projectDir, { recursive: true });
  rmSync(join(projectDir, '.sme'), { recursive: true, force: true });
  try {
    await page.goto('/');

    const card = page.locator('.home-card', { hasText: projectId });
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
      .poll(() => (existsSync(statusFile) ? (JSON.parse(readFileSync(statusFile, 'utf8')) as { stage?: string }).stage : undefined))
      .toBe('telop');

    // 自動判定に戻す
    await badge.click();
    const menu2 = card.locator('.home-badge-menu');
    await expect(menu2).toBeVisible();
    await menu2.getByRole('menuitem', { name: '自動判定に戻す' }).click();

    await expect
      .poll(() => (existsSync(statusFile) ? (JSON.parse(readFileSync(statusFile, 'utf8')) as { stage?: string | null }).stage : undefined))
      .toBe(null);
  } finally {
    removeTempProject(projectDir);
  }
});

test('ホーム: カンバン6列が並び、タイムライン・右ドックは非表示（プロジェクトを開くと復帰）', async ({ page }) => {
  // 共有 sample-project は smoke.spec.ts の afterEach（git checkout / git clean）が
  // 実行中ずっと書き換え続ける。このテストはバッジ（.sme/status.json）を書いたうえで
  // **エディタを開く**ので、その窓に重なると読み込みが壊れる（実測: 別 spec で
  // 「[telopData.ts] telopData 配列が見つかりません」を確認）。専用コピーへ隔離する。
  const { id: projectId, dir: projectDir } = createTempProject('kanban-open-tmp');
  try {
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
    const card = page.locator('.home-col .home-card', { hasText: projectId });
    await expect(card).toBeVisible();

    // バッジをテロップへ変更 → カードがテロップ列へ移動する
    await card.locator('.status-badge').click();
    await card.locator('.home-badge-menu').getByRole('menuitem', { name: 'テロップにする' }).click();
    await expect(
      page.locator('.home-col[data-status="telop"] .home-card', { hasText: projectId }),
    ).toBeVisible();

    // プロジェクトを開くとタイムラインが戻る
    await card.click();
    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.tl')).toBeVisible();
  } finally {
    await page.close();
    removeTempProject(projectDir);
  }
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
    cpSync(PRISTINE_SAMPLE_PROJECT, dir, { recursive: true });
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

    // 掴むのは「列の n 枚目」ではなく**自分が作ったカードのうち後続兄弟を持つもの**。
    // 他 spec も一時プロジェクトを作っては消すため（learning-diff-tmp 等）、
    // 列の枚数と並び順はテスト実行中に動く。位置で掴むと、クリックとメニュー検査の
    // 間に並びが変わって「メニューが出ない」と誤検知する（実測）。
    let target: import('@playwright/test').Locator | null = null;
    for (const id of ids) {
      const c = col.locator('.home-card', { hasText: id as string });
      // eslint-disable-next-line no-await-in-loop
      const hasNext = await c.evaluate(
        (el) => el.nextElementSibling?.classList.contains('home-card') ?? false,
      );
      if (hasNext) {
        target = c;
        break;
      }
    }
    expect(target, '後続兄弟を持つ一時カードが無い（後続に潜る検査にならない）').not.toBeNull();
    const second = target as import('@playwright/test').Locator;

    // 検査対象を画面上端へ寄せてからメニューを開く。メニューはカードの下端より下へ
    // 伸びるため、列の下の方のカードで開くとメニューが画面外に出て、下の「存在検査」
    // （inViewport）が成立しない。位置ではなく**見えている場所**を作ってから測る。
    await second.evaluate((el) => el.scrollIntoView({ block: 'start' }));

    // バッジメニューを開く（この時点でカードは hover 状態）。
    await second.locator('.status-badge').click();
    const menu = second.locator('.home-badge-menu');
    await expect(menu).toBeVisible();

    // メニューはカードの下端より下まで伸びる。**次のカードに重なる位置の項目**を検査する
    // （メニュー上端の項目はカード内に収まっており、覆われないので検査にならない）。
    const probe = menu.getByRole('menuitem', { name: '自動判定に戻す' });
    await expect(probe).toBeVisible();
    // **測る直前に、測る当人を画面内へ入れる**。カードを上端へ寄せた（上の scrollIntoView）だけでは
    // 足りない: 一時プロジェクトを作っては消す他 spec が並列に走っており、寄せてからメニューを開くまでの
    // 間に列の枚数が変わると配置がずれる。列が末尾まで来ていて寄せきれないこともある。
    // 実測（本ブランチ・フルスイート再検証 1 ラン目）: 「検査対象の項目が画面外（配置が変わった）」で赤。
    // elementFromPoint はビューポート座標でしか答えられないので、ここは前提であって緩和ではない。
    await probe.scrollIntoViewIfNeeded();
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
    // 「自動判定に戻す」はサーバーへ status を書きに行くので、応答を待ってから後片付けする
    // （待たずに削除すると削除中に `.sme/` が作り直され ENOTEMPTY で残骸が残る）。
    const written = waitStatusWritten(page);
    await probe.click({ timeout: 5_000 });
    await expect(menu).toHaveCount(0);
    await written;
  } finally {
    for (const dir of dirs) removeTempProject(dir);
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
  cpSync(PRISTINE_SAMPLE_PROJECT, projectDir, { recursive: true });
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
    writeStatusFileAtomic(statusFile, {
      activity: { label: 'カット中', startedAt: new Date().toISOString() },
    });
    await expect(item).toHaveClass(/fb-working/, { timeout: 15_000 });
    await expect(item.locator('.fb-activity')).toHaveText(/カット中/);
    await expect(item.locator('.fb-activity .status-spinner')).toBeVisible();

    // activity を消す → 強調が外れる
    writeStatusFileAtomic(statusFile, {});
    await expect(item).not.toHaveClass(/fb-working/, { timeout: 15_000 });
    await expect(item.locator('.fb-activity')).toHaveCount(0);
  } finally {
    removeTempProject(projectDir);
  }
});

/**
 * E-2 差し戻しの根本原因の回帰テスト。
 *
 * 上の「作業中がライブで出る」テストは、フルスイート時のみ 3〜7 回に 1 回、
 * `.fb-item` が `fb-working` にならないまま 15 秒タイムアウトしていた。
 * 原因は SSE ではなく**一覧の全置換と部分パッチの順序**:
 * `/api/projects` の応答は「要求が届いた時点」のスナップショットなのに、応答待ちの間に
 * SSE で届いたステータス差分を、遅れて着地したスナップショットが上書きして巻き戻す。
 * 巻き戻った後はディスクの状態が変わらないので新しい SSE イベントも来ず、戻らない。
 * 一覧再取得はプロジェクトを開いた直後（バス再接続 → onOpen → refreshProjects）に必ず走るため、
 * 混雑して応答が遅いランほど「パッチ → 遅い応答が着地」の順になりやすかった。
 *
 * ここでは応答を**テスト側で保留**して、その順序を偶然任せでなく確定的に作る。
 */
test('サイドバー: 一覧再取得の応答が遅れて着地しても「作業中」を巻き戻さない', async ({ page }) => {
  const projectId = `status-order-tmp-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const projectDir = join(import.meta.dirname, '..', 'src/server/__fixtures__', projectId);
  const statusFile = join(projectDir, '.sme', 'status.json');
  cpSync(PRISTINE_SAMPLE_PROJECT, projectDir, { recursive: true });
  rmSync(join(projectDir, '.sme'), { recursive: true, force: true });
  /** hold=true の間に来た /api/projects の応答を、release が呼ばれるまで着地させない。 */
  const gate: { hold: boolean; release: Array<() => void> } = { hold: false, release: [] };
  try {
    await page.route('**/api/projects', async (route) => {
      // 本体はこの時点（＝status.json を書く前）のディスク状態で取っておく。
      const response = await route.fetch();
      const body = await response.body();
      if (gate.hold) await new Promise<void>((resolve) => gate.release.push(resolve));
      // 保留を解くのはテスト本体か finally。テストが先に終わっていると、この要求は
      // もう存在せず fulfill が `Route is already handled!` で落ちる（後片付けの
      // ノイズが本体の赤を覆い隠す）。着地させられなければ黙って諦めてよい。
      await route.fulfill({ response, body }).catch(() => {});
    });

    await page.goto('/');
    const card = page.locator('.home-card', { hasText: projectId });
    await expect(card).toBeVisible({ timeout: 15_000 });
    // プロジェクトを開くと走る一覧再取得（バス再接続 → onOpen → refreshProjects）を保留する。
    // 開く操作より前に立てる（開いた直後に飛ぶので、後から立てると取り逃す）。
    gate.hold = true;
    await card.click();
    await expect(page.locator('.pv-stage .__remotion-player')).toBeVisible({ timeout: 20_000 });

    const item = page.locator('.fb-item', { hasText: projectId });
    await expect(item).toBeVisible();
    // 保留中の一覧再取得が実在することを確かめる（存在検査。0 件なら順序を作れていない）。
    await expect
      .poll(() => gate.release.length, { timeout: 15_000 })
      .toBeGreaterThan(0);

    // 応答を保留したまま activity を書く → SSE のパッチが先に届く。
    writeStatusFileAtomic(statusFile, {
      activity: { label: 'カット中', startedAt: new Date().toISOString() },
    });
    await expect(item).toHaveClass(/fb-working/, { timeout: 15_000 });

    // 古いスナップショットを遅れて着地させる。ここで巻き戻ってはいけない。
    // 「着地したこと」を待ってから見る（時間で待たない）。
    const landed = page.waitForResponse((r) => r.url().includes('/api/projects'));
    gate.hold = false;
    for (const release of gate.release.splice(0)) release();
    await landed;

    // 巻き戻りは着地と同時に起きるため、`toHaveClass` の再試行で見逃さないよう
    // 「外れたら失敗」を明示する: 一度でも外れれば下の poll が false を返す。
    await expect
      .poll(
        async () => {
          const classes: string[] = [];
          for (let i = 0; i < 5; i += 1) {
            classes.push((await item.getAttribute('class')) ?? '');
          }
          return classes.every((c) => c.includes('fb-working'));
        },
        { timeout: 5_000, intervals: [200, 200, 200, 200, 200] },
      )
      .toBe(true);
  } finally {
    gate.hold = false;
    for (const release of gate.release.splice(0)) release();
    await page.unroute('**/api/projects').catch(() => {});
    removeTempProject(projectDir);
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
