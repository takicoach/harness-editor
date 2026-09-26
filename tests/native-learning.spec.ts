import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempProject, removeTempProject } from './helpers';

// 新画面の書き出し後の学習ループ（OSS 0.3.1 の差分レビューの移植）の実ブラウザ検証。
// - 取り込み案件の試料を作り、テロップを1つ直して、画面の「書き出し」から実際に書き出す（新形式の書き出しは実描画）。
// - 学習フォルダは playwright.config.ts の webServer env（HARNESS_LEARNING_HOME / SUPERMOVIE_LEARNING_HOME）で
//   tests/.learning-home に隔離済み。並列の他 spec と共有なので、自分の videoId（= 一時プロジェクト ID）で絞って検証する。
// - jsdom では確かめられない「見える・押せる・フォーカス」をここで確かめる。

const LEARNING_HOME = resolve(import.meta.dirname, '.learning-home');
let project = { id: '', dir: '' };
// テロップの本文は実行ごとに一意にする。学習フォルダ（tests/.learning-home）は実行をまたいで残るため、
// 固定の本文だと「同じ修正が別の動画で2回目」になった実行だけルール昇格が 1 件になり、
// 「1 本目は昇格 0 件」の検証が前回までの実行の残りに左右される（実測: 2 回目の実行で昇格 1 件）。
let telopBefore = '';
let telopAfter = '';

/** 1 秒（30 フレーム）の旧形式案件にする。sample-project の main.mp4 は 30fps・1 秒・音声つき。 */
function writeShortLegacyProject(dir: string): void {
  writeFileSync(join(dir, 'src/videoConfig.ts'), `export type VideoFormat = 'youtube' | 'short' | 'square';
export const FORMAT: VideoFormat = 'youtube';
export const FPS = 30;
export const DURATION_FRAMES = 30;
export const VIDEO_FILE = 'main.mp4';
const RESOLUTION_MAP = { youtube: { width: 1920, height: 1080 }, short: { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 } } as const;
export const RESOLUTION = RESOLUTION_MAP[FORMAT];
`);
  writeFileSync(join(dir, 'src/cutData.ts'), `export const cutData: { id: number; originalStart: number; originalEnd: number; playbackStart: number; playbackEnd: number }[] = [
  { id: 1, originalStart: 0, originalEnd: 30, playbackStart: 0, playbackEnd: 30 },
];
`);
  writeFileSync(join(dir, 'src/テロップテンプレート/telopData.ts'), `import type { TelopSegment } from './telopTypes';
export const telopData: TelopSegment[] = [
  { id: 1, startFrame: 0, endFrame: 30, text: ${JSON.stringify(telopBefore)}, style: "normal", template: 1, animation: "fadeOnly" },
];
`);
  writeFileSync(join(dir, 'src/SoundEffects/seData.ts'), `import type { SoundEffect } from './SEPlayer';
export const seData: SoundEffect[] = [];
`);
  writeFileSync(join(dir, 'src/InsertImage/insertImageData.ts'), `import type { ImageSegment } from './types';
export const insertImageData: ImageSegment[] = [];
`);
  writeFileSync(join(dir, 'transcript.json'), JSON.stringify({ engine: 'fixture', language: 'ja', duration_ms: 1000,
    words: [{ text: 'ゆる', start: 0, end: 500 }, { text: '素振り', start: 500, end: 1000 }], segments: [] }));
}

/** 取り込み → テロップ1つの本文を直して保存。文書 ID を返す。 */
async function importAndFixOneTelop(request: APIRequestContext, id: string): Promise<string> {
  const migrated = await request.post(`/api/sequence/migrate?id=${id}`, { data: { executionId: `e2e-migrate-${randomUUID()}` } });
  expect(migrated.status(), await migrated.text()).toBe(200);
  const opened = await request.post(`/api/sequence/session?id=${id}`, { data: {} });
  expect(opened.status(), await opened.text()).toBe(200);
  const session = await opened.json();
  const telop = session.document.clips.find((clip: { content: { kind: string; legacyId?: number } }) => clip.content.kind === 'telop' && clip.content.legacyId === 1);
  expect(telop, '取り込んだ文書にテロップ（legacyId 1）が無い').toBeTruthy();
  const edited = await request.post(`/api/sequence/command?id=${id}`, { data: { sessionId: session.sessionId, expectedRevision: session.document.revision,
    executionId: randomUUID(), command: { type: 'update-clip', clipId: telop.id, patch: { content: { ...telop.content, data: { ...telop.content.data, text: telopAfter } } } } } });
  expect(edited.status(), await edited.text()).toBe(200);
  const state = await edited.json();
  const saved = await request.post(`/api/sequence/save?id=${id}`, { data: { sessionId: state.sessionId, executionId: randomUUID(),
    expectedRevision: state.document.revision, expectedSavedRevision: state.savedRevision } });
  expect(saved.status(), await saved.text()).toBe(200);
  return state.document.id as string;
}

function myTelopLines(videoId: string): Array<Record<string, unknown>> {
  const file = join(LEARNING_HOME, 'telop_feedback.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry['videoId'] === videoId);
}
function myLedgerEntry(documentId: string): unknown {
  const file = join(LEARNING_HOME, 'harvest_v2_state.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, unknown> }).projects[documentId] : undefined;
}

/** 実際に書き出された動画（.harness/exports/<jobId>/output.mp4）の大きさ。パネルが「本当に書き出した後」に開いたことの存在検査。 */
function exportedOutputSizes(dir: string): number[] {
  const root = join(dir, '.harness/exports');
  if (!existsSync(root)) return [];
  return readdirSync(root).map((job) => join(root, job, 'output.mp4')).filter((file) => existsSync(file)).map((file) => statSync(file).size);
}

test.beforeEach(() => {
  project = createTempProject('native-learning');
  const tag = randomUUID().slice(0, 8);
  telopBefore = `ゆる素振り${tag}`;
  telopAfter = `ゆるい素振り${tag}`;
  writeShortLegacyProject(project.dir);
});
test.afterEach(async ({ page }) => {
  await page.close();
  removeTempProject(project.dir);
});

/**
 * マウスを乗せた後のボタンの色（背景・文字）と、同じ場所で解決した --bg-2 の値。
 * :hover が実際に効いたことを確かめ、色の変化（transition）が終わってから読む。
 */
async function hoveredColors(button: import('@playwright/test').Locator): Promise<{ hovered: boolean; background: string; color: string; bg2: string }> {
  await button.hover();
  return button.evaluate(async (el) => {
    const hovered = el.matches(':hover');
    getComputedStyle(el).backgroundColor; // スタイルを確定させてから進行中の transition を拾う
    await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--bg-2)';
    el.parentElement!.appendChild(probe);
    const bg2 = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const style = getComputedStyle(el);
    return { hovered, background: style.backgroundColor, color: style.color, bg2 };
  });
}

/** WCAG のコントラスト比（rgb()/rgba() の不透明色どうし）。 */
function contrastRatio(a: string, b: string): number {
  const luminance = (css: string): number => {
    const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** マウスを乗せても読める: 背景が基底 hover の --bg-2 に化けず、文字との差が保たれている。 */
async function expectReadableOnHover(button: import('@playwright/test').Locator): Promise<void> {
  const colors = await hoveredColors(button);
  expect(colors.hovered, 'hover が効いていない（検査が空振りしている）').toBe(true);
  expect(colors.background).not.toBe(colors.bg2);
  expect(colors.background).not.toMatch(/rgba\(.*,\s*0\)$/); // 透明（地の色が透ける）でもない
  expect(contrastRatio(colors.color, colors.background), JSON.stringify(colors)).toBeGreaterThanOrEqual(3);
}

async function exportFromScreen(page: import('@playwright/test').Page, id: string): Promise<void> {
  await page.goto(`/?project=${id}`);
  const exportButton = page.getByRole('button', { name: '書き出し', exact: true });
  await expect(exportButton).toBeEnabled({ timeout: 30_000 });
  await exportButton.click();
  await page.getByRole('button', { name: '書き出し開始' }).click();
}

test('テロップを1つ直して書き出すと差分パネルが開き、承認すると jsonl に1行・台帳に1件増える', async ({ page, request }) => {
  test.setTimeout(180_000);
  const documentId = await importAndFixOneTelop(request, project.id);
  await exportFromScreen(page, project.id);

  const panel = page.getByRole('dialog', { name: 'AIとの差分レビュー' });
  await expect(panel).toBeVisible({ timeout: 150_000 });
  expect(exportedOutputSizes(project.dir)).toEqual([expect.any(Number)]);
  expect(exportedOutputSizes(project.dir)[0]).toBeGreaterThan(0);
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect(panel).toBeFocused();
  await expect(panel).toContainText('あなたの編集から 1 件の学習候補が見つかりました');
  await expect(panel).toContainText('比較元: 新エディターへ取り込んだ時点の内容');
  await expect(panel.getByRole('heading', { name: 'テロップ修正（1）' })).toBeVisible();
  await expect(panel).toContainText(`${telopBefore} → ${telopAfter}`);
  await expect(panel.getByRole('checkbox')).toBeChecked();
  // 見える・押せる: 承認ボタンの中心で一番手前にあるのがそのボタン自身（暗幕や他の部品に覆われていない）。
  const approve = panel.getByRole('button', { name: '選択分を学習する' });
  const box = await approve.boundingBox();
  expect(box && box.width > 0 && box.height > 0).toBe(true);
  const topmost = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent ?? null,
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
  expect(topmost).toBe('選択分を学習する');
  // マウスを乗せても主ボタンの文字が読める（新画面の基底ボタン hover に色を奪われない）。
  await expectReadableOnHover(approve);

  expect(myTelopLines(project.id)).toEqual([]);
  await approve.click();
  const done = page.getByRole('dialog', { name: '学習結果' });
  await expect(done).toContainText('修正 1 件を記録しました（ルール昇格 0 件）。');
  expect(myTelopLines(project.id)).toEqual([expect.objectContaining({ kind: 'changed', before: telopBefore, after: telopAfter })]);
  expect(myLedgerEntry(documentId)).toMatchObject({ videoId: project.id, source: 'editor-panel', counts: { telop: { changed: 1 } } });
  await expectReadableOnHover(done.getByRole('button', { name: '閉じる' }));
  await done.getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Esc は「今回は学習しない」と同じで、何も記録しない', async ({ page, request }) => {
  test.setTimeout(180_000);
  const documentId = await importAndFixOneTelop(request, project.id);
  await exportFromScreen(page, project.id);
  const panel = page.getByRole('dialog', { name: 'AIとの差分レビュー' });
  await expect(panel).toBeVisible({ timeout: 150_000 });
  expect(exportedOutputSizes(project.dir)).toEqual([expect.any(Number)]);
  // 他のダイアログが前に出ている間は隠れて待つ（見えない・Esc で閉じない）。閉じたらチェックの選択を保ったまま戻る。
  await panel.getByRole('checkbox').uncheck();
  await page.evaluate(() => { const other = document.createElement('div'); other.className = 'preference-overlay'; other.id = 'e2e-other-dialog'; document.body.appendChild(other); });
  const overlay = page.locator('.diff-review-overlay');
  await expect(overlay).toBeHidden();
  await expect(overlay).toHaveCount(1); // 隠れているだけで、外されてはいない（選択を保つ）
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(1);
  await page.evaluate(() => document.getElementById('e2e-other-dialog')?.remove());
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(panel.getByRole('checkbox')).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  expect(myTelopLines(project.id)).toEqual([]);
  expect(myLedgerEntry(documentId)).toBeUndefined();
});
