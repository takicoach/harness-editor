/**
 * 現行 UI のヘルプ画像を実画面から収録する。
 * npm run docs:help-shots [-- home save ...]
 * 一時デモ案件・空きポート・専用キャッシュで起動し、全対象が成功してから PNG を更新する。
 * AI の導入状態だけは未導入の検証用応答に固定し、製品UIで描画する。端末起動は遮断する。
 */
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO, 'src/app/help/img');
const DEMO_PROJECT = 'サンプル作品A';
const DEMO_COPY = 'サンプル作品B';
const FFMPEG_BIN = process.env.HARNESS_FFMPEG ?? process.env.SUPERMOVIE_FFMPEG ?? 'ffmpeg';
let base, demoClip;

function makeDemoClip(work) {
  const output = join(work, 'sample-video.mp4');
  // 実写素材を撮影に使うと、顔や実案件の情報が公開画像へ写る。
  execFileSync(FFMPEG_BIN, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=60:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', output,
  ]);
  return output;
}

function buildDemoRoot(work) {
  const root = join(work, 'projects'), project = join(root, DEMO_PROJECT);
  cpSync(join(REPO, 'src/server/__fixtures__/sample-project'), project, { recursive: true });
  rmSync(join(project, '.sme'), { recursive: true, force: true });
  rmSync(join(project, '.harness'), { recursive: true, force: true });
  rmSync(join(project, 'cut-baseline.json'), { force: true });
  cpSync(demoClip, join(project, 'public/main.mp4'));
  // sample-project の sample.png は画像デコードをしないテスト用のテキスト。
  // レビューで再生できるよう、デモ動画から実際のPNGを取り出してから移行する。
  execFileSync(FFMPEG_BIN, [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', demoClip,
    '-frames:v', '1', '-vf', 'scale=360:-1', join(project, 'public/images/sample.png'),
  ]);
  const config = join(project, 'src/videoConfig.ts');
  writeFileSync(config, readFileSync(config, 'utf8').replace('DURATION_FRAMES = 12000', 'DURATION_FRAMES = 1200'));
  writeFileSync(join(project, 'project-config.json'), JSON.stringify({ format: 'short', resolution: { width: 1080, height: 1920 }, fps: 60, durationFrames: 1200, sourceVideo: 'main.mp4' }));
  writeFileSync(join(project, 'src/cutData.ts'), 'export const cutData = [{id:1,originalStart:0,originalEnd:1200,playbackStart:0,playbackEnd:1200}];');
  writeFileSync(join(project, 'src/テロップテンプレート/telopData.ts'), `export const telopData = [
    {id:1,startFrame:0,endFrame:300,text:'ゆる素振りで体をほぐす',template:1,style:'emphasis',animation:'none'},
    {id:2,startFrame:330,endFrame:660,text:'力を抜いて振ってみましょう',template:2,animation:'none'},
    {id:3,startFrame:690,endFrame:1140,text:'リズムよく繰り返します',template:1,animation:'none'}
  ];`);
  cpSync(project, join(root, DEMO_COPY), { recursive: true });
  return root;
}

async function home(page) {
  await page.goto(base);
  await page.locator('.home-card', { hasText: DEMO_PROJECT }).waitFor();
}

async function openProject(page) {
  await home(page);
  await page.locator('.home-card', { hasText: DEMO_PROJECT }).click();
  await expect(page.getByRole('button', { name: '編集を始める', exact: true }).or(page.locator('.native-timeline-panel'))).toBeVisible({ timeout: 30000 });
  const migrate = page.getByRole('button', { name: '編集を始める', exact: true });
  if (await migrate.isVisible()) await migrate.click();
  await page.locator('.native-timeline-panel').waitFor({ timeout: 60000 });
  await page.getByRole('group', { name: 'モード', exact: true }).getByRole('button', { name: '編集', exact: true }).click();
  await expect(page.locator('.native-save-state')).not.toContainText('処理中', { timeout: 30000 });
  // 挿入画像のある1.5秒でも描画を確認する。3秒だけでは壊れた画像を見逃す。
  await page.getByRole('slider', { name: 'シークバー' }).fill('90');
  const insertedImage = page.frameLocator('iframe[data-native-preview]').locator('img').first();
  await insertedImage.waitFor({ timeout: 30000 });
  await insertedImage.evaluate(img => img.decode());
  await expect(page.locator('.native-preview-status[role="alert"]')).toHaveCount(0);
  // このデモ MP4 の先頭 PTS は 0.016 秒。映像のある3秒地点を実UIで選んで収録する。
  await page.getByRole('slider', { name: 'シークバー' }).fill('180');
  await page.locator('iframe[data-native-preview]').waitFor();
  await page.frameLocator('iframe[data-native-preview]').locator('[data-sme-kind=telop]').first().waitFor({ timeout: 30000 });
  // 文字の折り返しと下段トラックの欠けを避け、実UIのパネル境界で表示領域を広げる。
  for (let i = 0; i < 6; i++) await page.getByRole('separator', { name: '設定パネルのサイズ' }).press('ArrowLeft');
  for (let i = 0; i < 7; i++) await page.getByRole('separator', { name: 'タイムラインパネルのサイズ' }).press('ArrowUp');
}

async function clipAround(page, locators, pad = 16) {
  const boxes = [];
  for (const locator of locators) {
    await expect(locator).toBeVisible();
    const box = await locator.boundingBox();
    if (!box) throw new Error('収録範囲を取得できません');
    boxes.push(box);
  }
  const vp = page.viewportSize();
  const x = Math.max(0, Math.min(...boxes.map(b => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map(b => b.y)) - pad);
  return { clip: { x, y, width: Math.min(vp.width, Math.max(...boxes.map(b => b.x + b.width)) + pad) - x,
    height: Math.min(vp.height, Math.max(...boxes.map(b => b.y + b.height)) + pad) - y } };
}

const SHOTS = {
  async home(page) {
    await page.setViewportSize({ width: 1200, height: 760 }); await home(page);
    return clipAround(page, [page.locator('.home-head'), ...await page.locator('.home-card').all()]);
  },
  async board(page) {
    await page.setViewportSize({ width: 1600, height: 760 });
    await home(page); await page.locator('.home-view-btn', { hasText: '進行ボード' }).click();
    return page.locator('.home');
  },
  async create(page) {
    await home(page); await page.locator('[data-testid=home-create-file]').setInputFiles(demoClip);
    await page.locator('.home-create-name').fill('サンプル作品C');
    return page.locator('.home-create-dialog');
  },
  async mcp(page) {
    await openProject(page); await page.locator('.native-ai-band').click();
    await page.getByRole('button', { name: 'インストール', exact: true }).waitFor();
    return clipAround(page, [page.locator('.native-ai-band'), page.locator('.clt-tools'), page.locator('.clt .hint')]);
  },
  async 'ai-tab'(page) {
    await openProject(page);
    return clipAround(page, [page.locator('.native-ai-band'), page.locator('.native-column-head').last()]);
  },
  async 'ai-modes'(page) {
    await openProject(page); await page.getByRole('button', { name: 'AIの作業', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toContainText('読み込み中', { timeout: 20000 });
    return page.getByRole('dialog');
  },
  async materials(page) {
    await openProject(page); await page.getByRole('tab', { name: '素材', exact: true }).click();
    await page.locator('.native-asset-row').first().hover();
    return clipAround(page, [page.locator('.native-library .native-column-head'), page.locator('.native-material-content > .native-library-hint').last()]);
  },
  async timeline(page) { await openProject(page); return page.locator('.native-timeline-panel'); },
  async 'add-button'(page) {
    await openProject(page); await page.getByRole('button', { name: '図形', exact: true }).click();
    return clipAround(page, [...await page.locator('.native-add-bar > button').all(), page.getByRole('menu', { name: '図形の種類' })], 24);
  },
  async telop(page) {
    await openProject(page); await page.getByRole('tab', { name: '字幕一覧', exact: true }).click();
    for (let i = 0; i < 7; i++) await page.getByRole('separator', { name: 'タイムラインパネルのサイズ' }).press('ArrowDown');
    return page.locator('.native-right-dock');
  },
  async trash(page) {
    await page.setViewportSize({ width: 1200, height: 760 }); await home(page);
    const card = page.locator('.home-card', { hasText: DEMO_COPY });
    await card.hover(); await card.getByRole('button', { name: 'ゴミ箱へ移動', exact: true }).click();
    await page.getByRole('dialog', { name: '削除確認' }).getByRole('button', { name: 'ゴミ箱へ移動', exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'ゴミ箱', exact: true }).click();
    await page.getByRole('button', { name: '復元', exact: true }).waitFor();
    return clipAround(page, [page.locator('.home-head'), page.locator('.trash-view .home-card')]);
  },
  async save(page) {
    await openProject(page);
    return clipAround(page, [page.locator('.native-header-actions')]);
  },
  async render(page) {
    await openProject(page); await page.getByRole('button', { name: '書き出し', exact: true }).click();
    return page.getByRole('region', { name: '動画の書き出し' });
  },
  async layout(page) {
    await openProject(page); await page.getByRole('button', { name: '設定', exact: true }).click();
    return page.getByRole('dialog', { name: '設定', exact: true });
  },
};

async function main() {
  const only = process.argv.slice(2);
  if (only.some(id => !Object.hasOwn(SHOTS, id))) throw new Error(`不明な項目: ${only.filter(id => !Object.hasOwn(SHOTS, id)).join(', ')}`);
  const targets = only.length ? only : Object.keys(SHOTS);
  const work = mkdtempSync(join(tmpdir(), 'harness-help-'));
  console.log(`収録作業フォルダ: ${work}`);
  let server, browser;
  try {
    demoClip = makeDemoClip(work);
    process.env.HARNESS_PROJECT_ROOT = buildDemoRoot(work);
    process.env.HARNESS_LEARNING_HOME = join(work, 'learning');
    process.env.HARNESS_PREFERENCE_TEST_FIXTURE = '1';
    process.env.SME_NO_OPEN = '1'; process.env.SME_TUTORIAL = '0';
    const { createServer } = await import('vite');
    server = await createServer({ root: REPO, cacheDir: join(work, 'vite-cache'), server: { host: '127.0.0.1', port: 0, open: false } });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch();
    for (const id of targets) {
      console.log(`▶ 収録中: ${id}`);
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
      // 現行検出器はPATH以外も探すため、PATHを隠す旧手順では実CLIが起動してしまう。
      await context.route('**/api/ai/tools*', route => route.fulfill({ json: {
        tools: ['claude', 'codex'].map(id => ({ id, label: id === 'claude' ? 'Claude' : 'Codex',
          installed: false, versionOk: false, installable: id === 'claude', path: null, source: null, status: 'missing' })),
        current: null, notes: [],
      } }));
      await context.route('**/api/pty/**', route => route.abort());
      await context.addInitScript(() => {
        localStorage.setItem('sme-theme', 'dark');
        localStorage.setItem('sme-tutorial-done', new Date().toISOString());
      });
      const page = await context.newPage(); page.setDefaultTimeout(30000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/pty/')) errors.push('収録中に端末起動が要求されました'); });
      try {
        const target = await SHOTS[id](page);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        // 実画面の保存先表示は残しつつ、一時作業フォルダの実パスを架空の例に置く。
        await page.locator('.home-card-path, .trash-card-path').evaluateAll(nodes => {
          for (const node of nodes) {
            const label = node.classList.contains('trash-card-path') ? '元の保存先' : '保存先';
            node.textContent = `${label}: サンプル用フォルダ`;
            node.setAttribute('title', 'サンプル用フォルダ');
          }
        });
        if ((await page.locator('body').innerText()).includes(work)) throw new Error('撮影画面に一時作業フォルダの実パスが残っています');
        const options = { path: join(work, `${id}.png`), animations: 'disabled' };
        if ('clip' in target) await page.screenshot({ ...options, clip: target.clip });
        else await target.screenshot(options);
        if (errors.length) throw new Error(errors.join('\n'));
      } catch (error) {
        await page.screenshot({ path: join(work, `${id}-failure.png`), fullPage: true });
        writeFileSync(join(work, `${id}-failure.txt`), await page.locator('body').innerText());
        throw error;
      } finally { await context.close(); }
      console.log(`  ✓ ${id}.png`);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    for (const id of targets) cpSync(join(work, `${id}.png`), join(OUT_DIR, `${id}.png`));
    console.log(`${targets.length} 項目の画像を更新しました。`);
  } finally {
    await browser?.close(); await server?.close();
    // 失敗時の画像・ログも次の調査に使えるよう一時フォルダに残す。
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
