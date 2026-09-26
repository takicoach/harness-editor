import { test, expect, type Page } from '@playwright/test';
import { createTempProject, removeTempProject } from './helpers';
import { HELP_TOPICS } from '../src/app/help/helpTopics';
import { CURRENT_FEATURE_GENERATION } from '../src/app/featureSeen';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';
import { shotDir } from './shotDir';

let project: { id: string; dir: string };
test.beforeEach(() => {
  project = createTempProject('help-native');
  // 旧sampleは200秒の編集データに短いテスト動画が付く。実プレビューで開ける20秒の入力へ揃える。
  cpSync(join(import.meta.dirname, '../scripts/guide-assets/demo-golf.mp4'), join(project.dir, 'public/main.mp4'));
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1',
    '-i', join(project.dir, 'public/main.mp4'), '-frames:v', '1', '-vf', 'scale=360:-1', join(project.dir, 'public/images/sample.png')]);
  rmSync(join(project.dir, 'cut-baseline.json'), { force: true });
  writeFileSync(join(project.dir, 'project-config.json'), JSON.stringify({ format: 'short', resolution: { width: 1080, height: 1920 }, fps: 60, durationFrames: 1200, sourceVideo: 'main.mp4' }));
  const config = join(project.dir, 'src/videoConfig.ts');
  writeFileSync(config, readFileSync(config, 'utf8').replace('DURATION_FRAMES = 12000', 'DURATION_FRAMES = 1200'));
  writeFileSync(join(project.dir, 'src/cutData.ts'), 'export const cutData = [{id:1,originalStart:0,originalEnd:1200,playbackStart:0,playbackEnd:1200}];');
  writeFileSync(join(project.dir, 'src/テロップテンプレート/telopData.ts'), "export const telopData = [{id:1,startFrame:0,endFrame:300,text:'ヘルプの表示確認',template:1,animation:'none'}];");
});
test.afterEach(() => { removeTempProject(project.dir); });

async function openHelp(page: Page) {
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('button', { name: '使い方を見る', exact: true }).click();
}

async function openEditor(page: Page) {
  await page.goto(`/?${new URLSearchParams({ project: project.id })}`);
  const migrate = page.getByRole('button', { name: '編集を始める', exact: true });
  await expect(migrate.or(page.locator('.native-timeline-panel'))).toBeVisible({ timeout: 30000 });
  if (await migrate.isVisible()) await migrate.click();
  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30000 });
  await page.getByRole('slider', { name: 'シークバー' }).fill('90');
  const insertedImage = page.frameLocator('iframe[data-native-preview]').locator('img').first();
  await expect(insertedImage).toBeVisible({ timeout: 15000 });
  await insertedImage.evaluate(node => (node as HTMLImageElement).decode());
  await expect(page.locator('.native-preview-status[role="alert"]')).toHaveCount(0);
}

test('チュートリアル図鑑: 現行設定から開き、全画像・検索・カテゴリ・項目選択・狭幅表示を確認できる', async ({ page }) => {
  const screenshots = shotDir('help-native');
  await openEditor(page);
  await openHelp(page);
  const dialog = page.locator('[data-testid="help-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);
  await expect(dialog.getByText(/この説明は旧画面/)).toHaveCount(0);
  // 新画面にもチュートリアルが入ったので、「もう一度最初から見る」を出す（spec 2026-09-25 §1）。
  await expect(dialog.locator('.help-replay-btn')).toHaveCount(1);

  for (const topic of HELP_TOPICS) {
    await dialog.locator(`.help-item[data-topic-id="${topic.id}"]`).click();
    const image = dialog.locator('.help-detail-pane .help-img');
    await expect(image).toHaveAttribute('alt', topic.title);
    await image.evaluate(node => (node as HTMLImageElement).decode());
    // 縦長の設定・書き出し画像も途中で切らず、元画像の縦横比で表示する。
    const ratio = await image.evaluate(node => {
      const img = node as HTMLImageElement;
      return { displayed: img.clientWidth / img.clientHeight, original: img.naturalWidth / img.naturalHeight };
    });
    expect(ratio.displayed).toBeCloseTo(ratio.original, 1);
  }

  // 検索絞り込み（1 項目にしか出ない語で 1 件に絞れることを確認）。
  // 現行設定の本文にしか出ない語で引く。
  await dialog.locator('.help-search-input').fill('セーフエリア');
  await expect(dialog.locator('.help-item')).toHaveCount(1);
  await expect(dialog.locator('.help-item')).toContainText('設定');
  await dialog.locator('.help-search-input').fill('');
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);

  // カテゴリチップ
  await dialog.locator('.help-chip', { hasText: '編集' }).click();
  await expect(dialog.locator('.help-item')).toHaveCount(
    HELP_TOPICS.filter((t) => t.category === '編集').length,
  );
  await dialog.locator('.help-chip', { hasText: 'すべて' }).click();
  await expect(dialog.locator('.help-item')).toHaveCount(HELP_TOPICS.length);

  // 項目選択で右ペイン切替
  await dialog.locator('.help-item', { hasText: '書き出し' }).click();
  await expect(dialog.locator('.help-detail-pane .help-cap')).toHaveText('書き出し');
  await expect(dialog.locator('.help-detail-pane .help-img')).toBeVisible();
  await dialog.locator('.help-detail-pane .help-img').evaluate(node => (node as HTMLImageElement).decode());
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('link', { name: '書き出しの画像を大きく表示' }).filter({ visible: true }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/render\.png/);
  await popup.close();
  await dialog.locator('.help-detail-pane').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await dialog.locator('.help-item[data-topic-id="layout"]').click();
  await expect.poll(() => dialog.locator('.help-detail-pane').evaluate(node => node.scrollTop)).toBe(0);
  await dialog.locator('.help-item[data-topic-id="render"]').click();
  await dialog.locator('.help-detail-pane .help-img').evaluate(node => (node as HTMLImageElement).decode());
  await page.screenshot({ path: join(screenshots, 'help-light.png') });

  // Esc で閉じる
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('radio', { name: 'ダーク', exact: true }).click();
  await page.keyboard.press('Escape');
  await openHelp(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await dialog.locator('.help-item[data-topic-id="timeline"]').click();
  await expect(dialog.locator('.help-detail-pane .help-img')).toBeVisible();
  await dialog.locator('.help-detail-pane .help-img').evaluate(node => (node as HTMLImageElement).decode());
  await page.screenshot({ path: join(screenshots, 'help-dark.png') });
  await page.keyboard.press('Escape');

  // 狭幅ではアコーディオンへ切り替わり、画像も読み込める。
  await page.setViewportSize({ width: 600, height: 900 });
  await openHelp(page);
  await expect(dialog).toBeVisible();
  await dialog.locator('.help-item[data-topic-id="layout"]').click();
  const narrowImage = dialog.locator('.help-accordion .help-img');
  await expect(narrowImage).toBeVisible();
  await narrowImage.evaluate(node => (node as HTMLImageElement).decode());
  const narrowRatio = await narrowImage.evaluate(node => {
    const img = node as HTMLImageElement;
    return { displayed: img.clientWidth / img.clientHeight, original: img.naturalWidth / img.naturalHeight };
  });
  expect(narrowRatio.displayed).toBeCloseTo(narrowRatio.original, 1);
  await page.screenshot({ path: join(screenshots, 'help-narrow.png') });
});

test('チュートリアル図鑑: 新機能の NEW バッジは開くと消え、リロードしても復活しない', async ({ page }) => {
  // 既読になるのはユーザーが項目を選んだときだけ（自動選択された先頭項目は既読にしない）。
  const expectedNew = HELP_TOPICS.filter((t) => t.addedIn === CURRENT_FEATURE_GENERATION);
  expect(expectedNew.length).toBeGreaterThan(0);
  const target = expectedNew[0]!;

  await openEditor(page);
  await openHelp(page);
  const dialog = page.locator('[data-testid="help-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.help-new-badge')).toHaveCount(expectedNew.length);

  // 該当項目を開くと、その項目のバッジだけ消える。
  const targetItem = dialog.locator(`.help-item[data-topic-id="${target.id}"]`);
  await expect(targetItem.locator('.help-new-badge')).toBeVisible();
  await targetItem.click();
  await expect(targetItem.locator('.help-new-badge')).toHaveCount(0);
  await expect(dialog.locator('.help-new-badge')).toHaveCount(expectedNew.length - 1);

  // リロード後も既読のまま（localStorage 永続）。
  await page.reload();
  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30000 });
  await openHelp(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(`.help-item[data-topic-id="${target.id}"] .help-new-badge`)).toHaveCount(0);
  await expect(dialog.locator('.help-new-badge')).toHaveCount(expectedNew.length - 1);
});
