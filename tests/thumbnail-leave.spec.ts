import { test, expect } from '@playwright/test';
import { textLayer } from '../src/core/thumbnail/fixtures';
import { removeTempProject } from './helpers';
import { createThumbnailProject, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

test('案件を切り替える途中でサムネの保存に失敗したら、編集を保持して離れない（受け入れ 11）', async ({ page, request }) => {
  test.setTimeout(120_000);
  const a = createThumbnailProject('e2e-thumb-leave-a'), b = createThumbnailProject('e2e-thumb-leave-b');
  try {
    await page.goto(`/?project=${a.id}`);
    await page.getByRole('region', { name: 'プロジェクト一覧' }).getByText(b.id, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`project=${b.id}`));
    await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect.poll(async () => (await thumbnailState(request, b.id)).document.pages.length).toBe(1);
    const pageId = (await thumbnailState(request, b.id)).document.pages[0]!.id;
    await thumbnailCommand(request, b.id, { type: 'add-layer', pageId, layer: textLayer('leave') });
    await expect(page.locator('.native-save-dirty')).toBeVisible();
    await page.route('**/api/thumbnail/save?**', route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '保存できませんでした（試験）' }) }));
    await page.goBack();
    await expect(page.getByText('サムネを保存できなかったため、移動を止めました')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`project=${b.id}`));
    await page.getByRole('button', { name: 'ホームに戻る' }).click();
    await expect(page).toHaveURL(new RegExp(`project=${b.id}`));
    const kept = await thumbnailState(request, b.id);
    expect(kept.dirty).toBe(true);
    expect(kept.document.pages[0]!.layers.map(layer => layer.id)).toEqual(['leave']);
    await page.unroute('**/api/thumbnail/save?**');
    await page.getByRole('button', { name: 'ホームに戻る' }).click();
    await expect(page.locator('.native-home-app')).toBeVisible();
    expect((await thumbnailState(request, b.id)).dirty).toBe(false);
  } finally { await page.goto('about:blank'); removeTempProject(a.dir); removeTempProject(b.dir); }
});

test('自動保存はサムネにも効く', async ({ page, request }) => {
  const project = createThumbnailProject('e2e-thumb-autosave');
  try {
    await page.addInitScript(() => { try { localStorage.setItem('sme-auto-save-enabled', '1'); } catch { /* 保存できなくても既定で進む */ } });
    await page.goto(`/?project=${project.id}&autoSaveDelayMsForTest=500`);
    await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect.poll(async () => (await thumbnailState(request, project.id)).document.pages.length).toBe(1);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('auto') });
    await expect.poll(async () => (await thumbnailState(request, project.id)).dirty, { timeout: 15_000 }).toBe(false);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});
