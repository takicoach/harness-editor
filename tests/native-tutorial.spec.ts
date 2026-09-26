import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempProject, removeTempProject } from './helpers';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';

/**
 * 新画面の「？」と初回チュートリアル。
 * jsdom ではレイアウトが取れないため、「見える・押せる・照らす枠と重なる」はここで実ブラウザで確かめる。
 * e2e は SME_TUTORIAL=0（自動では出ない）なので、「？」→「もう一度最初から見る」で始める。
 * 例外は確認モードからの開始で、確認モードでは「？」が表示されないため /api/config を差し替えて初回の自動開始で始める。
 */
const DEMO_CLIP = join(import.meta.dirname, '../scripts/guide-assets/demo-golf.mp4');
let project: { id: string; dir: string };

test.use({ viewport: { width: 1280, height: 800 } });

test.beforeEach(() => {
  project = createTempProject('native-tutorial-tmp');
  cpSync(DEMO_CLIP, join(project.dir, 'public/main.mp4'));
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1',
    '-i', join(project.dir, 'public/main.mp4'), '-frames:v', '1', '-vf', 'scale=360:-1', join(project.dir, 'public/images/sample.png')]);
  rmSync(join(project.dir, 'cut-baseline.json'), { force: true });
  writeFileSync(join(project.dir, 'project-config.json'), JSON.stringify({ format: 'short', resolution: { width: 1080, height: 1920 }, fps: 60, durationFrames: 1200, sourceVideo: 'main.mp4' }));
  const config = join(project.dir, 'src/videoConfig.ts');
  writeFileSync(config, readFileSync(config, 'utf8').replace('DURATION_FRAMES = 12000', 'DURATION_FRAMES = 1200'));
  writeFileSync(join(project.dir, 'src/cutData.ts'), 'export const cutData = [{id:1,originalStart:0,originalEnd:1200,playbackStart:0,playbackEnd:1200}];');
  writeFileSync(join(project.dir, 'src/テロップテンプレート/telopData.ts'), "export const telopData = [{id:1,startFrame:0,endFrame:300,text:'チュートリアルの表示確認',template:1,animation:'none'}];");
});
test.afterEach(async ({ page }) => {
  await page.close();
  removeTempProject(project.dir);
});

async function openNativeEditor(page: Page, query: Record<string, string> = {}): Promise<void> {
  await page.goto(`/?${new URLSearchParams({ project: project.id, ...query })}`);
  const migrate = page.getByRole('button', { name: '編集を始める', exact: true });
  await expect(migrate.or(page.locator('.native-timeline-panel'))).toBeVisible({ timeout: 30000 });
  if (await migrate.isVisible()) await migrate.click();
  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30000 });
}

async function startFromHelp(page: Page): Promise<void> {
  await page.getByRole('button', { name: '使い方（ヘルプ）' }).click();
  await page.locator('.help-replay-btn').click();
  await expect(page.locator('.tut[data-step="welcome"]')).toBeVisible();
}

/** 照らす枠が対象を包み、対象が見えて押せる（中心が他の要素に遮られていない）ことを確かめる。 */
async function expectSpotlight(page: Page, stepId: string, selector: string): Promise<void> {
  const root = page.locator(`.tut[data-step="${stepId}"]:not([data-waiting])`);
  await expect(root).toBeVisible({ timeout: 15000 });
  await expect(root).toHaveAttribute('data-target', selector);
  await expect(page.locator('.tut-hole')).toBeVisible();
  await page.waitForTimeout(900); // 照準の移動を待つ（進行 tick 最大350ms＋移動アニメーション350ms＋余裕150ms。対象が複数（save の switch+button 等）の直後に間に合わないことがある）
  const geometry = await page.evaluate((sel) => {
    const hole = document.querySelector('.tut-hole')!.getBoundingClientRect();
    const items = Array.from(document.querySelectorAll(sel)).map((el) => {
      const r = el.getBoundingClientRect();
      // 画面より大きい対象（長い作品一覧）は、見えている部分の中心で当たり判定する。
      const vl = Math.max(r.left, 0), vt = Math.max(r.top, 0), vr = Math.min(r.right, innerWidth), vb = Math.min(r.bottom, innerHeight);
      const inView = vr > vl && vb > vt;
      const hit = inView ? document.elementFromPoint((vl + vr) / 2, (vt + vb) / 2) : null;
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
        inView, unobstructed: hit !== null && el.contains(hit) };
    }).filter((r) => r.width > 0 && r.height > 0);
    return { hole: { left: hole.left, top: hole.top, right: hole.right, bottom: hole.bottom }, items };
  }, selector);
  expect(geometry.items.length, `${stepId}: 見える対象が無い`).toBeGreaterThan(0);
  for (const item of geometry.items) {
    expect(item.inView, `${stepId}: 対象が画面外`).toBe(true);
    expect(item.unobstructed, `${stepId}: 対象の中心が他の要素に遮られている`).toBe(true);
    expect(geometry.hole.left).toBeLessThanOrEqual(item.left + 1);
    expect(geometry.hole.top).toBeLessThanOrEqual(item.top + 1);
    expect(geometry.hole.right).toBeGreaterThanOrEqual(item.right - 1);
    expect(geometry.hole.bottom).toBeGreaterThanOrEqual(item.bottom - 1);
  }
}

const next = (page: Page) => page.locator('.tut .tut-next').click();

test('設定が無効（SME_TUTORIAL=0）なら、ホームでも編集画面でも自動では出ない', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-tutorial="home"]')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1000);
  await expect(page.locator('.tut, .tut-band')).toHaveCount(0);
  await openNativeEditor(page);
  await page.waitForTimeout(1000);
  await expect(page.locator('.tut, .tut-band')).toHaveCount(0);
});

test('ホーム: 「？」から始め、ホームの手順は対象と重なり、作成ダイアログ中は案内帯だけが操作部分を覆わずに出る', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-tutorial="home-grid"]')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: '使い方（ヘルプ）' })).toHaveAttribute('data-tutorial', 'help');
  await startFromHelp(page);
  await next(page);
  await expectSpotlight(page, 'home-intro', '[data-tutorial="home-grid"]');
  await next(page);
  await expectSpotlight(page, 'board', '[data-tutorial="home-view-switch"]');
  await next(page);
  await expectSpotlight(page, 'create', '[data-tutorial="home-create"]');
  await expect(page.locator('.tut .tut-next')).toHaveCount(0);

  await page.getByTestId('home-create-file').setInputFiles(DEMO_CLIP);
  const dialog = page.locator('.home-create-dialog');
  await expect(dialog).toBeVisible();
  const band = page.locator('.tut-band[data-step="create"]');
  await expect(band).toBeVisible();
  await expect(page.locator('.tut-bubble')).toHaveCount(0);
  const [bandBox, dialogBox] = [await band.boundingBox(), await dialog.boundingBox()];
  expect(bandBox && dialogBox).toBeTruthy();
  expect(bandBox!.y + bandBox!.height).toBeLessThanOrEqual(dialogBox!.y);
  const create = dialog.getByRole('button', { name: '作成' });
  await expect(create).toBeEnabled();
  expect(await create.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && el.contains(hit);
  })).toBe(true);
  await dialog.getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('.tut[data-step="create"]')).toBeVisible();

  await page.locator('.tut .tut-skip').click(); // 作成を飛ばす → ホームのまま完了へ
  await expect(page.locator('.tut[data-step="finish"]')).toBeVisible();
  await next(page);
  await expect(page.locator('.tut')).toHaveCount(0);
});

test('編集: 確認モード・左右パネルを畳んだ状態から始めても整えてから照らし、体験→取り除く→保存→書き出し→？まで進む', async ({ page }) => {
  await openNativeEditor(page);
  // 「確認」モードでは左右パネル（畳むボタンごと）とヘッダー右側（「？」「設定」を含む）が display:none になる
  // （native-restoration.css）。そのため畳むのは「編集」モードで先に行い、確認モードからの開始は
  // 実際にその状態で起こりうる初回の自動開始で作る（画面の状態は sessionStorage に残り、再読み込み後も続く）。
  await page.getByRole('button', { name: '右パネルを畳む' }).click();
  await page.getByRole('button', { name: '左パネルを畳む' }).click();
  await page.getByRole('button', { name: '確認', exact: true }).click();
  const workspace = page.locator('main.native-workspace');
  await expect(workspace).toHaveClass(/native-mode-review/);
  let configHits = 0;
  await page.route('**/api/config', async (route) => {
    configHits += 1;
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), tutorialEnabled: true } });
  });
  await page.reload();
  // 前提の存在検査: 確認モード・左右パネルを畳んだまま開き直っている（整える処理が空振りしていないことの前提）。
  await expect(workspace).toHaveClass(/native-mode-review/, { timeout: 30000 });
  await expect(workspace).toHaveClass(/native-hide-left/);
  await expect(workspace).toHaveClass(/native-hide-right/);
  await expect(page.locator('.tut[data-step="welcome"]')).toBeVisible({ timeout: 15000 });
  expect(configHits, '/api/config の差し替えが効いていない').toBeGreaterThan(0);
  await expect(workspace).toHaveClass(/native-mode-review/);
  await next(page);
  await expectSpotlight(page, 'modes', '[data-tutorial="modes"]');
  await expect(page.getByRole('button', { name: '編集', exact: true })).toHaveAttribute('aria-current', 'page');
  for (const [id, selector] of [
    ['materials', '[data-tutorial="materials"]'],
    ['ai-panel', '[data-tutorial="ai-panel"]'],
    ['ai-work', '[data-tutorial="ai-work"]'],
    ['timeline', '[data-tutorial="timeline"]'],
    ['add-button', '[data-tutorial="add-telop"]'],
  ] as const) {
    await next(page);
    await expectSpotlight(page, id, selector);
  }
  await next(page);
  await expectSpotlight(page, 'telop-try', '[data-tutorial="add-telop"]');
  await expect(page.locator('.tut .tut-next')).toHaveCount(0);
  await expect(page.locator('[data-tutorial="add-telop"]')).toBeEnabled();

  const counts = page.locator('.native-timeline-footer > span:last-child');
  const before = await counts.textContent();
  await page.locator('[data-tutorial="add-telop"]').click();
  await expect(page.locator('.tut[data-step="telop-done"]')).toBeVisible();
  await expect(page.locator('.tut-confetti')).toBeVisible();
  await expect(counts).not.toHaveText(before ?? '');
  await page.getByRole('button', { name: '取り除く' }).click();
  await expectSpotlight(page, 'save', '[data-tutorial="save"]');
  await expect(counts).toHaveText(before ?? '');

  await expect(page.locator('button[data-tutorial="save"]')).toBeEnabled();
  await page.locator('button[data-tutorial="save"]').click();
  await expectSpotlight(page, 'render', '[data-tutorial="export"]'); // 未保存→保存済みで自動前進
  await next(page);
  await expectSpotlight(page, 'help', '[data-tutorial="help"]');
  await next(page);
  await expect(page.locator('.tut[data-step="finish"]')).toBeVisible();
  await next(page);
  await expect(page.locator('.tut')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('harness-native-tutorial-done'))).not.toBeNull();
});

/**
 * 自動保存 ON（本番の既定）で体験のテロップを足し、自動保存で保存済みに戻ってから telop-done に居る状態を作る。
 * e2e の既定は自動保存 OFF（SME_AUTO_SAVE=0）なので /api/config を差し替える。新画面は /api/config の
 * autoSaveDelayMs を読まず、待ち時間はクエリ autoSaveDelayMsForTest で決まる（parseAutoSaveDelayOverride）。
 */
async function toTelopDoneWithAutoSave(page: Page): Promise<string | null> {
  let configHits = 0;
  await page.route('**/api/config', async (route) => {
    configHits += 1;
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), autoSaveDefaultEnabled: true, autoSaveDelayMs: 1000 } });
  });
  await openNativeEditor(page, { autoSaveDelayMsForTest: '1000' });
  expect(configHits, '/api/config の差し替えが効いていない').toBeGreaterThan(0);
  await expect(page.locator('.native-auto-save input[type="checkbox"]')).toBeChecked(); // 前提: 自動保存 ON
  await startFromHelp(page);
  for (const [id, selector] of [
    ['modes', '[data-tutorial="modes"]'],
    ['materials', '[data-tutorial="materials"]'],
    ['ai-panel', '[data-tutorial="ai-panel"]'],
    ['ai-work', '[data-tutorial="ai-work"]'],
    ['timeline', '[data-tutorial="timeline"]'],
    ['add-button', '[data-tutorial="add-telop"]'],
    ['telop-try', '[data-tutorial="add-telop"]'],
  ] as const) {
    await next(page);
    await expectSpotlight(page, id, selector);
  }
  const counts = page.locator('.native-timeline-footer > span:last-child');
  const before = await counts.textContent();
  await page.locator('[data-tutorial="add-telop"]').click();
  await expect(page.locator('.tut[data-step="telop-done"]')).toBeVisible();
  await expect(counts).not.toHaveText(before ?? ''); // 前提: 本当に追加された
  await page.waitForTimeout(1800); // 自動保存（1000ms）が走り終わるのを待つ（基準値取得の最大350msとの余裕を広げる）
  // 前提の存在検査: 本当に自動保存で保存済みに戻っている（未保存のままなら、別の経路を見ていることになる）。
  await expect(page.locator('.native-save-state.native-save-saved')).toBeVisible();
  return before;
}

test('自動保存 ON（本番の既定）: 自動で保存されてから「残す」を押すと、保存の手順は保存済みの本文で「次へ」で進める', async ({ page }) => {
  await toTelopDoneWithAutoSave(page);
  await page.getByRole('button', { name: '残す', exact: true }).click();
  const save = page.locator('.tut[data-step="save"]');
  await expectSpotlight(page, 'save', '[data-tutorial="save"]');
  await expect(save).toContainText('この「保存」で、編集がプロジェクトに保存されます');
  await expect(save).not.toContainText('押してみましょう');
  await next(page);
  await expectSpotlight(page, 'render', '[data-tutorial="export"]');
});

test('自動保存 ON（本番の既定）: 「取り除く」で未保存になり自動保存で保存済みに戻ると、保存の手順から書き出しへ自動で進む', async ({ page }) => {
  const before = await toTelopDoneWithAutoSave(page);
  await page.getByRole('button', { name: '取り除く', exact: true }).click();
  await expect(page.locator('.native-timeline-footer > span:last-child')).toHaveText(before ?? ''); // 前提: 本当に取り除いた（＝未保存になった）
  // 取り除いた直後は未保存（保存の手順の基準値は「未保存」）→ 自動保存で保存済み → 書き出しへ自動前進。
  // 基準値を取り除く前の描画（保存済み）から取ると、ここで保存の手順に留まり続ける（M-1）。
  await expectSpotlight(page, 'render', '[data-tutorial="export"]');
  await expect(page.locator('.native-save-state.native-save-saved')).toBeVisible();
});

test('確認モードでも「？」だけは見えて押せ、他の上部右側ボタンは従来どおり隠れる', async ({ page }) => {
  await openNativeEditor(page);
  await page.getByRole('button', { name: '確認', exact: true }).click();
  const workspace = page.locator('main.native-workspace');
  await expect(workspace).toHaveClass(/native-mode-review/);

  const help = page.locator('[data-tutorial="help"]');
  await expect(help).toBeVisible();
  const geometry = await help.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { width: r.width, height: r.height, inView: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, unobstructed: hit !== null && el.contains(hit) };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.inView, '「？」が画面外').toBe(true);
  expect(geometry.unobstructed, '「？」の中心が他の要素に遮られている').toBe(true);

  for (const name of ['元に戻す', 'やり直す', 'AIの作業', '通知・エラー履歴', '設定']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeHidden();
  }
  await expect(page.locator('button[data-tutorial="save"]')).toBeHidden();
  await expect(page.locator('[data-tutorial="export"]')).toBeHidden();

  await help.click();
  await expect(page.locator('.help-overlay')).toBeVisible();
  await expect(page.locator('.help-replay-btn')).toBeVisible();
  await expect(page.getByText('もう一度最初から見る')).toBeVisible();
});

test('幅 1100（左パネルが自動で畳まれる幅）でも、素材の手順で左パネルを開いて照らす', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openNativeEditor(page);
  await startFromHelp(page);
  await next(page);
  await expectSpotlight(page, 'modes', '[data-tutorial="modes"]');
  await next(page);
  await expectSpotlight(page, 'materials', '[data-tutorial="materials"]');
});

test('設定などのダイアログ表示中は案内を隠し、閉じると同じ手順に戻る', async ({ page }) => {
  await openNativeEditor(page);
  await startFromHelp(page);
  await next(page);
  await expectSpotlight(page, 'modes', '[data-tutorial="modes"]');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.locator('.tut')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectSpotlight(page, 'modes', '[data-tutorial="modes"]');
});
