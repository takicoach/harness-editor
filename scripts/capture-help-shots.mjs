/**
 * チュートリアル図鑑（HelpModal）用のスクリーンショットを自動収録する。
 *
 *   npm run docs:help-shots              # 全 topic を再収録
 *   npm run docs:help-shots -- home save # 指定 topic だけ再収録
 *
 * 仕組みは scripts/record-guide-gifs.mjs と同方式: 一時フォルダにデモプロジェクトを組み立て
 * → ポート 2109 で dev サーバー起動 → Playwright で実 UI を操作 → 対象要素を PNG スクリーンショット
 * → src/app/help/img/<topicId>.png へ出力（コミットする）。ダークテーマ・幅 1280。
 * UI が変わったら本スクリプトを直して再実行すれば、図鑑の画像が全て新 UI に揃う。
 *
 * **再収録の基準は「説明文を変えたか」ではなく「その項目が指す UI が変わったか」**
 * （2026-08-26 レビュー I-2）。文言だけ直して画像を据え置くと、本文から消したはずのものを
 * 絵が言い続ける——実際 ai-tab.png は 2026-07-23 のまま、撤去済みの在席欄と
 * `claude mcp add ...` / `http://localhost:2109/mcp` を 1 か月表示し続けていた。
 * 迷ったら引数なしの全再収録が安全（変化が無い項目はバイト同一になり diff に出ない）。
 *
 * 前提: デモ素材 scripts/guide-assets/demo-golf.mp4（record-guide-gifs.mjs と共用）。
 */
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_CLIP = join(REPO, 'scripts', 'guide-assets', 'demo-golf.mp4');
const OUT_DIR = join(REPO, 'src', 'app', 'help', 'img');
const FIXTURE = join(REPO, 'src', 'server', '__fixtures__', 'sample-project');
const PORT = Number(process.env.SME_PORT ?? 2109); // 実エディタ稼働中でも別ポートで収録できるように（isolated e2e と同じ流儀）
const BASE = `http://localhost:${PORT}`;
const DEMO_PROJECT = 'ゴルフドリル解説';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** デモ用プロジェクトルートを一時フォルダに組み立てる（record-guide-gifs.mjs と同じ作法）。 */
function buildDemoRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sme-help-'));
  const proj = join(root, DEMO_PROJECT);
  cpSync(FIXTURE, proj, { recursive: true });
  rmSync(join(proj, '.sme'), { recursive: true, force: true });
  rmSync(join(proj, 'cut-baseline.json'), { force: true });
  cpSync(DEMO_CLIP, join(proj, 'public', 'main.mp4'));
  return root;
}

/**
 * AI ツール（claude / codex）が **1 つも見つからない** PATH を組んで返す。
 *
 * なぜ必要か: 収録機に claude や codex が入っていると AI タブは本物のセッションを起動し、
 * その起動バナーには **プラン名・セッション使用率・一時フォルダの絶対パス**が出る。
 * 要素撮影するとオーナーのアカウント状態が配布物へ焼き込まれる
 * （実測: ai-tab.png に「Claude Max」「74%」「/…/T/sme-help-3vGLJ4」が写った）。
 *
 * なぜ「claude を含むディレクトリを除く」だけでは足りないか: codex は `/opt/homebrew/bin` に
 * あり、**node/npm と同じディレクトリ**なので、そのディレクトリごと落とすとサーバーが起動しない
 * （実測: claude だけ隠すと codex へフォールバックして本物の端末が出た）。
 *
 * そこで node/npm/npx の symlink だけを持つ一時ディレクトリを作り、PATH をそれだけにする。
 * サーバーの検出（`which claude` / `which codex`）は必ず失敗し、AI タブは導入カードを出す。
 * 戻り値の cleanup() で一時ディレクトリを消すこと。
 */
function makeAiFreePath() {
  const dir = mkdtempSync(join(tmpdir(), 'sme-shim-'));
  for (const bin of ['node', 'npm', 'npx']) {
    const real = spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
    if (real) symlinkSync(real, join(dir, bin));
  }
  // /usr/bin と /bin は必要（npm は `#!/usr/bin/env node` で env を、vite は sh を使う。
  // shim だけの PATH では実測でサーバーが起動しなかった）。AI ツールが居る場合だけ落とす。
  const base = ['/usr/bin', '/bin'].filter(
    (d) => !existsSync(join(d, 'claude')) && !existsSync(join(d, 'codex')),
  );
  const path = [dir, ...base].join(process.platform === 'win32' ? ';' : ':');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function startServer(root, { aiFreePath = null } = {}) {
  const child = spawn('npm', ['run', 'edit'], {
    cwd: REPO,
    env: {
      ...process.env,
      ...(aiFreePath === null ? {} : { PATH: aiFreePath }),
      HARNESS_PROJECT_ROOT: root,
      SME_NO_OPEN: '1',
      SME_TUTORIAL: '0',
      SME_RENDER_MOCK: '1',
      SME_RENDER_MOCK_DELAY_MS: '4000',
      SME_TRANSCRIBE_MOCK: '1',
    },
    stdio: 'ignore',
    detached: true,
  });
  return child;
}

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/ping`);
      if (res.ok) return;
    } catch { /* まだ起動中 */ }
    await sleep(500);
  }
  throw new Error('dev サーバーが起動しませんでした');
}

async function openDemoProject(page) {
  await page.goto(BASE);
  const card = page.locator('.home-card', { hasText: DEMO_PROJECT });
  await card.waitFor({ timeout: 15_000 });
  await card.click();
  await page.locator('.pv-stage .__remotion-player').waitFor({ timeout: 20_000 });
  await sleep(800);
}

// ---- 各 topic の収録手順（1 topic = 1 PNG）------------------------------
// 戻り値: スクリーンショット対象の Locator、または {clip} （ページ座標の矩形指定）。
// 要素単体だと文脈が欠ける・背景が黒く落ちるケース（ボタン＋開いたメニュー等）は
// boundingBox の合成矩形＋余白で clip 撮影する。

/** 複数 Locator の boundingBox を合成し、pad px の余白を付けた clip 矩形を返す。 */
async function clipAround(page, locators, pad = 16) {
  const boxes = [];
  for (const loc of locators) {
    const b = await loc.boundingBox();
    if (b) boxes.push(b);
  }
  if (boxes.length === 0) throw new Error('clipAround: boundingBox が取得できません');
  const vp = page.viewportSize();
  const x1 = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y1 = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const x2 = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const y2 = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { clip: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } };
}

const SHOTS = {
  async home(page) {
    await page.goto(BASE);
    await page.locator('.home-card', { hasText: DEMO_PROJECT }).waitFor({ timeout: 15_000 });
    await sleep(500);
    return page.locator('.home');
  },

  async board(page) {
    await page.goto(BASE);
    await page.locator('.home-card', { hasText: DEMO_PROJECT }).waitFor({ timeout: 15_000 });
    await page.locator('.home-view-btn', { hasText: '進行ボード' }).click();
    await sleep(600);
    return page.locator('.home');
  },

  async create(page) {
    await page.goto(BASE);
    await page.locator('.home-create-btn').first().waitFor({ timeout: 15_000 });
    await page.locator('[data-testid=home-create-file]').setInputFiles(DEMO_CLIP);
    await page.locator('.home-create-name').waitFor();
    await sleep(500);
    return page.locator('.home-create-dialog');
  },

  async mcp(page) {
    await openDemoProject(page);
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    // この項目（「AI と接続する」）だけ **AI ツールを PATH から外したサーバー**（AI_FREE_SHOTS）
    // で撮る。理由は 2 つ。
    // ① 本物のセッションを起動させると、起動バナーのプラン名・使用率・一時パスが配布物へ
    //    焼き込まれる（makeAiFreePath の注記）。
    // ② 未導入＝導入カードの画面こそ、本文「まだ AI が入っていないパソコンでは
    //    『AI と接続する（Claude Code を導入）』ボタンが出る」と一致する絵。
    // M-1: ドック全体を撮ると 7 割が空のターミナルになるので、タブ列と導入カードを寄りで撮る。
    const setup = page.locator('.clt-setup');
    await setup.waitFor({ timeout: 20_000 });
    await sleep(400);
    return clipAround(page, [page.locator('.rightdock-tabs'), setup], 18);
  },

  async aiTab(page) {
    await openDemoProject(page);
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    // I-2: この画像は 2026-07-23 収録のまま残っており、撤去済みの在席欄
    // （「この動画に専属の待機役を付ける」）・MCP 登録手順・`http://localhost:2109/mcp` の
    // URL・`claude mcp add ...` コマンド・指示入力欄を今も表示していた。
    // ＝本文から MCP を消しても、絵が「MCP 接続が残っている」と言い続けていた。
    //
    // 通常サーバー（AI あり）で撮るが、**ターミナル本体（.clt-term）は入れない** —
    // 起動バナーにプラン名・セッション使用率・一時フォルダの絶対パスが出るため。
    // この項目の主題は「AI タブがどこにあり、どの AI を使うか」なので、タブ列と
    // Claude/Codex 切替を寄りで撮る（切替が出ない環境ではタブ列のみ）。
    await page.locator('.clt').waitFor({ timeout: 10_000 });
    await sleep(600);
    const anchors = [page.locator('.rightdock-tabs')];
    const tools = page.locator('.clt-tools');
    if (await tools.count() > 0) anchors.push(tools);
    return clipAround(page, anchors, 18);
  },

  async materials(page) {
    await openDemoProject(page);
    await page.locator('.lc-tab[data-tab="materials"]').click();
    await sleep(500);
    return page.locator('.lc');
  },

  async trash(page) {
    await openDemoProject(page);
    await page.locator('.lc-tab[data-tab="materials"]').click();
    // ゴミ箱アイコンは行ホバー（.ml-row:hover .ml-row-delete）でしか出ないので、ホバーしたまま撮る。
    const row = page.locator('.material-lib .ml-row').first();
    await row.waitFor({ timeout: 10_000 });
    await row.hover();
    await sleep(500);
    // 左カラム全体だと余白ばかりになるので、タブ列（右端の「ゴミ箱」ボタン）と
    // ホバー中の行（🗑）を合成矩形で撮る。
    return clipAround(page, [page.locator('.lc-tabs'), page.locator('.material-lib .ml-tabs'), row], 16);
  },

  async timeline(page) {
    await openDemoProject(page);
    // 2026-08-26: 素のタイムラインを撮ると、つなぎ目マーク（.tl-join-mark）は
    // 13px・bg-4 の地味なひし形でルーラーに重なるため、図鑑の画像では事実上見えない
    // （「◇ が出ない」という実機フィードバックの直接の原因）。頭マーカーを選択して
    // .selected（16px・accent 塗り・ハロー）にしてから撮り、本文の説明と絵を一致させる。
    const head = page.locator('.tl-join-mark[data-join-at="head"]');
    await head.waitFor({ timeout: 10_000 });
    await head.click();
    await sleep(400);
    return page.locator('.tl');
  },

  async addButton(page) {
    await openDemoProject(page);
    const btn = page.locator('.tl-add-menu-btn');
    await btn.click();
    await page.locator('.tl-telop-add').waitFor({ timeout: 5_000 });
    await sleep(400);
    // 「＋ 追加」ボタン本体と開いたメニュー（効果音・画像・サブ動画・BGM・字幕・テロップの
    // 6 項目）の両方が写るように合成矩形で撮る
    // （メニュー単体だとどのボタンから開くのか伝わらない・2026-07-24 たきさんFB）。
    return clipAround(page, [btn, page.locator('.tl-add-menu [role="menu"]')], 24);
  },

  async telop(page) {
    await openDemoProject(page);
    const row = page.locator('.tx-row').first();
    await row.click();
    await page.locator('.tx-row.selected .tx-text-edit').waitFor();
    await sleep(400);
    return page.locator('.rightdock');
  },

  async save(page) {
    await openDemoProject(page);
    // ツールバー全体の要素撮影は中身が写らない（2026-07-24 たきさんFB・真っ暗）。
    // 「保存」ボタンとその周辺（undo/redo〜書き出し）を合成矩形で撮る。
    await page.locator('.tb-save').waitFor({ timeout: 10_000 });
    return clipAround(page, [page.locator('.tb-save'), page.locator('.tb-render')], 28);
  },

  async aiModes(page) {
    await openDemoProject(page);
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    // 2026-08-26: 旧手順は在席欄（`.cl-agent-status`）と専属勧誘（`.cl-dedicated-recruit`）を
    // 待っていたが、AI タブ簡素化（2026-07-27）でどちらも撤去済み＝10 秒待って失敗していた。
    // いまの待機導線は埋め込みターミナル下の「待機を開始（編集指示を受け付ける）」だけ。
    // ボタンは phase==='connected' の時しか出ない（撮影機に claude が無ければ導入カード）ので、
    // 出れば周辺を寄りで、出なければ AI タブ全体を撮る（どちらでも収録は止めない）。
    // 収録は**ボタンの周辺だけ**を寄りで撮る。ターミナル全体（.clt-term）を入れると、
    // 撮影機の claude 起動バナー（プラン名・セッション残量・一時フォルダのパス）が
    // 配布物へそのまま焼き込まれる（実測: ai-modes.png に「Claude Max」「92% of your
    // session limit」が写った）。AI タブ全体の見た目は mcp.png が担当している。
    await page.locator('.clt').waitFor({ timeout: 10_000 });
    const waitBtn = page.locator('.clt-waiting-btn');
    try {
      await waitBtn.waitFor({ timeout: 20_000 });
      await sleep(400);
      return clipAround(page, [waitBtn], 44);
    } catch {
      // 未導入・接続失敗など、待機ボタンが出ないフェーズ。フェーズを問わず必ず在る
      // ルート要素（.clt）を撮って収録を止めない。
      await sleep(400);
      return page.locator('.clt');
    }
  },

  async render(page) {
    await openDemoProject(page);
    await page.locator('.tb-render-btn').click();
    await page.locator('[data-testid="export-dialog"]').waitFor();
    await sleep(400);
    return page.locator('[data-testid="export-dialog"]');
  },

  async layout(page) {
    await openDemoProject(page);
    await page.locator('.tb-settings-btn').click();
    await sleep(400);
    return page.locator('.tb-settings-menu');
  },
};

/** camelCase の flow キー → topicId（kebab-case）。 */
const TOPIC_ID = {
  home: 'home',
  board: 'board',
  create: 'create',
  mcp: 'mcp',
  aiTab: 'ai-tab',
  aiModes: 'ai-modes',
  materials: 'materials',
  timeline: 'timeline',
  addButton: 'add-button',
  telop: 'telop',
  trash: 'trash',
  save: 'save',
  render: 'render',
  layout: 'layout',
};

/**
 * AI ツールを PATH から隠したサーバーで撮る項目。
 * mcp は「未導入で導入ボタンが出ている画面」が主題なので AI が居ては撮れない。
 * 逆に ai-tab のツール切替・ai-modes の「待機を開始」は AI が居ないと出ないので通常サーバー。
 */
const AI_FREE_SHOTS = new Set(['mcp']);

/** 1 パスぶんの収録。server は呼び出し側が起動済み。 */
async function capturePass(browser, names) {
  for (const name of names) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(`localStorage.setItem('sme-theme', 'dark');`);
    await context.addInitScript(`localStorage.setItem('sme-tutorial-done', new Date().toISOString());`);
    const page = await context.newPage();
    console.log(`▶ 収録中: ${TOPIC_ID[name]}`);
    const target = await SHOTS[name](page);
    const outPath = join(OUT_DIR, `${TOPIC_ID[name]}.png`);
    if (target && typeof target === 'object' && 'clip' in target) {
      await page.screenshot({ path: outPath, clip: target.clip });
    } else {
      await target.screenshot({ path: outPath });
    }
    await context.close();
    console.log(`  ✓ src/app/help/img/${TOPIC_ID[name]}.png`);
  }
}

async function main() {
  if (!existsSync(DEMO_CLIP)) {
    throw new Error(`デモ素材がありません: ${DEMO_CLIP}`);
  }
  const only = process.argv.slice(2);
  const targets = Object.keys(SHOTS).filter(
    (k) => only.length === 0 || only.includes(k) || only.includes(TOPIC_ID[k]),
  );
  const normal = targets.filter((k) => !AI_FREE_SHOTS.has(k));
  const aiFree = targets.filter((k) => AI_FREE_SHOTS.has(k));

  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    // 2 パス構成: PATH の AI ツール有無でサーバーを分ける（同一サーバーでは切り替えられない）。
    for (const [names, aiFreePass] of [[normal, false], [aiFree, true]]) {
      if (names.length === 0) continue;
      const shim = aiFreePass ? makeAiFreePath() : null;
      const root = buildDemoRoot();
      const server = startServer(root, { aiFreePath: shim === null ? null : shim.path });
      try {
        await waitServer();
        await capturePass(browser, names);
      } finally {
        try { process.kill(-server.pid); } catch { /* 既に終了 */ }
        rmSync(root, { recursive: true, force: true });
        shim?.cleanup();
        // 次のサーバーが同じポートを掴めるように少し待つ。
        await sleep(1500);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
