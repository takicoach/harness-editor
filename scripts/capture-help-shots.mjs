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
 * 前提: デモ素材 scripts/guide-assets/demo-golf.mp4（record-guide-gifs.mjs と共用）。
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

function startServer(root) {
  const child = spawn('npm', ['run', 'edit'], {
    cwd: REPO,
    env: {
      ...process.env,
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
    // I-4: 旧 UI の `.cl-setup`（別ターミナル手順の案内カード）は撤去済み。埋め込み
    // ターミナル（ClaudeTerminal）のフェーズは撮影機のマシンに claude が入っているか
    // どうかで need-install/starting/connected と分岐する。撮影機には claude が
    // 入っている前提で、接続完了（待機ボタン表示）の直後に撮る。**起動画面の描画は
    // 待たない**こと — 実 claude セッションの起動画面には撮影マシンのアカウント名・
    // プラン・利用モデルが表示されるため、長く待つと公開物に写り込む。
    await page.locator('.clt-waiting-btn').waitFor({ timeout: 60_000 });
    await sleep(300);
    return page.locator('.rightdock');
  },

  async aiTab(page) {
    await openDemoProject(page);
    await page.locator('.rightdock-tab[data-tab="ai"]').click();
    await sleep(500);
    return page.locator('.rightdock');
  },

  async materials(page) {
    await openDemoProject(page);
    await page.locator('.lc-tab[data-tab="materials"]').click();
    await sleep(500);
    return page.locator('.lc');
  },

  async timeline(page) {
    await openDemoProject(page);
    await sleep(500);
    return page.locator('.tl');
  },

  async addButton(page) {
    await openDemoProject(page);
    const btn = page.locator('.tl-add-menu-btn');
    await btn.click();
    await page.locator('.tl-telop-add').waitFor({ timeout: 5_000 });
    await sleep(400);
    // 「＋ 追加」ボタン本体と開いたメニューの両方が写るように合成矩形で撮る
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
    // 簡素化 AI タブ（埋め込みターミナルのみ）では在席欄 `.cl-agent-status` は存在しない。
    // 全体待機の入口である「待機を開始」ボタン（claude 接続後にのみ出る）を含めて
    // ターミナル下部を撮る。接続に時間がかかる環境があるため待ちは長め。
    await page.locator('.clt-waiting-btn').waitFor({ timeout: 60_000 });
    await sleep(400);
    return clipAround(page, [page.locator('.clt-waiting-btn')], 48);
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
  save: 'save',
  render: 'render',
  layout: 'layout',
};

async function main() {
  if (!existsSync(DEMO_CLIP)) {
    throw new Error(`デモ素材がありません: ${DEMO_CLIP}`);
  }
  const only = process.argv.slice(2);
  const targets = Object.keys(SHOTS).filter(
    (k) => only.length === 0 || only.includes(k) || only.includes(TOPIC_ID[k]),
  );

  const root = buildDemoRoot();
  const server = startServer(root);
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    await waitServer();
    for (const name of targets) {
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
  } finally {
    await browser.close();
    try { process.kill(-server.pid); } catch { /* 既に終了 */ }
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
