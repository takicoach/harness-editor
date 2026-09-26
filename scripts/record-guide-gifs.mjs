/**
 * はじめてガイド用の GIF を自動収録する。
 *
 *   npm run docs:gifs                # 全 GIF を再生成
 *   npm run docs:gifs -- hero cut    # 指定フローだけ再生成
 *
 * 仕組み: 一時フォルダにデモプロジェクト（ゴルフドリル解説）を組み立て、
 * ポート 2109 で dev サーバーを起動 → Playwright が実際の UI 操作を再生しながら
 * 動画録画 → ffmpeg で GIF 化して docs/images/guide/ へ出力する。
 * UI が変わったら本スクリプトを直して再実行すれば、ガイドの GIF が全て新 UI に揃う。
 *
 * 前提: デモ素材 scripts/guide-assets/demo-golf.mp4（縦動画・20 秒程度）。
 * リポに同梱済み（TAKICOACH 提供・フリー素材扱い）。
 */
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_CLIP = join(REPO, 'scripts', 'guide-assets', 'demo-golf.mp4');
const OUT_DIR = join(REPO, 'docs', 'images', 'guide');
const FIXTURE = join(REPO, 'src', 'server', '__fixtures__', 'sample-project');
const PORT = 2109;
const BASE = `http://localhost:${PORT}`;
const DEMO_PROJECT = 'ゴルフドリル解説';

/** マウスカーソルを合成する（Playwright の操作は実カーソルが出ないため）。 */
const CURSOR_SCRIPT = `
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;z-index:99999;width:18px;height:18px;border-radius:50%;' +
      'background:rgba(217,119,87,.85);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4);' +
      'pointer-events:none;left:-40px;top:-40px;transition:transform .08s';
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = (e.clientX - 9) + 'px'; c.style.top = (e.clientY - 9) + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(0.7)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = 'scale(1)'; }, true);
  });
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** デモ用プロジェクトルートを一時フォルダに組み立てる。 */
function buildDemoRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sme-guide-'));
  const proj = join(root, DEMO_PROJECT);
  cpSync(FIXTURE, proj, { recursive: true });
  // fixture の作業ファイル・状態を除去して「編集途中の実プロジェクト」らしくする
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
      SME_PROJECT_ROOT: root,
      SME_NO_OPEN: '1',
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
  await card.hover();
  await sleep(400);
  await card.click();
  await page.locator('.pv-stage .__remotion-player').waitFor({ timeout: 20_000 });
  await sleep(800);
}

/** ゆっくりマウス移動（GIF で目で追えるように）。 */
async function glide(page, x, y) {
  await page.mouse.move(x, y, { steps: 25 });
  await sleep(250);
}

// ---- 各フロー（1 フロー = 1 GIF） ----------------------------------------

const FLOWS = {
  /** 全体像: ホーム → プロジェクトを開く → 再生 → スクラブ。 */
  async hero(page) {
    await page.goto(BASE);
    await page.locator('.home-card', { hasText: DEMO_PROJECT }).waitFor({ timeout: 15_000 });
    await sleep(1200);
    await openDemoProject(page);
    // 再生
    const play = page.locator('.pv-stage .__remotion-player');
    await play.click();
    await sleep(3500);
    await play.click(); // 停止
    // ルーラーでスクラブ
    const rbox = await page.locator('.tl-ruler').boundingBox();
    if (rbox) {
      await glide(page, rbox.x + 120, rbox.y + rbox.height / 2);
      await page.mouse.down();
      await page.mouse.move(rbox.x + 420, rbox.y + rbox.height / 2, { steps: 40 });
      await page.mouse.up();
    }
    await sleep(1200);
  },

  /** 動画を作成する: ホームのボタン → 名前確認 → エディタが開く。 */
  async create(page) {
    await page.goto(BASE);
    const btn = page.locator('.home-create-btn').first();
    await btn.waitFor({ timeout: 15_000 });
    await sleep(800);
    await btn.hover();
    await sleep(600);
    // Finder ダイアログは録画に映らないため、ファイル選択は直接 input へ渡す
    await page.locator('[data-testid=home-create-file]').setInputFiles(DEMO_CLIP);
    await page.locator('.home-create-name').waitFor();
    await sleep(1500);
    await page.locator('.export-start').click();
    await page.locator('.pv-stage .__remotion-player').waitFor({ timeout: 30_000 });
    await sleep(1500);
  },

  /** カット: 動画トラックで範囲ドラッグ → カットボタン → カットブロック。 */
  async cut(page) {
    await openDemoProject(page);
    const box = await page.locator('.tl-track-cut').boundingBox();
    if (!box) throw new Error('.tl-track-cut が見つかりません');
    const y = box.y + box.height / 2;
    await glide(page, box.x + 160, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 320, y, { steps: 35 });
    await page.mouse.up();
    await sleep(700);
    const cutBtn = page.locator('.tl-cut-confirm');
    await cutBtn.hover();
    await sleep(500);
    await cutBtn.click();
    await page.locator('.tl-cut').first().waitFor();
    await sleep(1500);
  },

  /** テロップ: 行を選んで文字を直す → プレビューに反映。 */
  async telop(page) {
    await openDemoProject(page);
    const row = page.locator('.tx-row').first();
    await row.hover();
    await sleep(400);
    await row.click();
    const editor = page.locator('.tx-row.selected .tx-text-edit');
    await editor.waitFor();
    await sleep(600);
    await editor.click();
    await editor.press('Meta+a');
    await page.keyboard.type('ゆる素振りで体をほぐそう', { delay: 90 });
    await sleep(1800);
  },

  /** 素材: 素材タブ → 効果音を挿入 → タイムラインにクリップ。 */
  async materials(page) {
    await openDemoProject(page);
    await page.locator('.lc-tab[data-tab="materials"]').click();
    await sleep(600);
    await page.locator('.ml-tab[data-kind="se"]').click();
    await sleep(600);
    const row = page.locator('.ml-list .ml-row').first();
    await row.hover();
    await sleep(500);
    await row.locator('.ml-insert').click();
    await page.locator('.tl-track-se .tl-se-clip').first().waitFor();
    await sleep(1500);
  },

  /** 書き出し: ボタン → プリセット選択 → 進捗 → 完了。 */
  async exportFlow(page) {
    await openDemoProject(page);
    const btn = page.locator('.tb-render-btn');
    await btn.hover();
    await sleep(400);
    await btn.click();
    await page.locator('[data-testid="export-dialog"]').waitFor();
    await sleep(1200);
    await page.locator('[data-testid="export-start"]').click();
    // モック進捗（4 秒）が 100% まで進むのを見せる
    await sleep(6000);
  },

  /** AI 作業中表示: 別プロセスのスキルが status.json を書くと光る。 */
  async aiStatus(page, { root }) {
    await openDemoProject(page);
    await sleep(800);
    const statusDir = join(root, DEMO_PROJECT, '.sme');
    mkdirSync(statusDir, { recursive: true });
    writeFileSync(
      join(statusDir, 'status.json'),
      JSON.stringify({ activity: { label: 'カット中', startedAt: new Date().toISOString() } }),
    );
    await page.locator('.fb-item.fb-working').waitFor({ timeout: 15_000 });
    await sleep(3500);
    writeFileSync(join(statusDir, 'status.json'), '{}');
    await sleep(1800);
  },
};

/** フロー名 → 出力 GIF 名。 */
const GIF_NAME = {
  hero: 'hero.gif',
  create: 'create-project.gif',
  cut: 'cut.gif',
  telop: 'telop.gif',
  materials: 'materials.gif',
  exportFlow: 'export.gif',
  aiStatus: 'ai-status.gif',
};

function toGif(webmPath, gifPath) {
  execFileSync('ffmpeg', [
    '-y', '-i', webmPath,
    '-vf', 'fps=10,scale=880:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    gifPath,
  ], { stdio: 'ignore' });
}

async function main() {
  if (!existsSync(DEMO_CLIP)) {
    throw new Error(`デモ素材がありません: ${DEMO_CLIP}`);
  }
  const only = process.argv.slice(2);
  const targets = Object.keys(FLOWS).filter((k) => only.length === 0 || only.includes(k) || only.includes(GIF_NAME[k].replace('.gif', '')));

  const root = buildDemoRoot();
  const server = startServer(root);
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    await waitServer();
    for (const name of targets) {
      const videoDir = mkdtempSync(join(tmpdir(), 'sme-gif-'));
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
      });
      await context.addInitScript(CURSOR_SCRIPT);
      // 初回チュートリアルの自動開始を抑止する（GIF はガイド側で流れを見せるため）。
      await context.addInitScript(`localStorage.setItem('sme-tutorial-done', new Date().toISOString());`);
      const page = await context.newPage();
      console.log(`▶ 収録中: ${name}`);
      await FLOWS[name](page, { root });
      await context.close(); // close で webm が確定する
      const webm = readdirSync(videoDir).find((f) => f.endsWith('.webm'));
      if (!webm) throw new Error(`録画ファイルがありません: ${name}`);
      toGif(join(videoDir, webm), join(OUT_DIR, GIF_NAME[name]));
      rmSync(videoDir, { recursive: true, force: true });
      console.log(`  ✓ docs/images/guide/${GIF_NAME[name]}`);
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
