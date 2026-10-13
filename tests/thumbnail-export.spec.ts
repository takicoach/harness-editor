import { test, expect, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { textLayer } from '../src/core/thumbnail/fixtures';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';
import { removeTempProject } from './helpers';
import { shotDir } from './shotDir';
import { createThumbnailProject, openThumbnailMode, thumbnailCommand, thumbnailState } from './thumbnailHelpers';

test('ヘッダーの「PNG で書き出し」で今の案を書き出す。2MB を超えたら JPEG を勧め、JPEG は 2MB 以下になる', async ({ page, request }) => {
  test.setTimeout(240_000);
  const project = createThumbnailProject('e2e-thumb-export'), ffmpeg = resolveFfmpegBin(), base = `${basename(project.dir)} サムネ`;
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('title', '書き出し') });
    await page.getByRole('button', { name: 'PNG で書き出し' }).click();
    const link = page.locator('.native-thumbnail-export-link');
    await expect(link).toHaveText(`${base}.png`, { timeout: 120_000 });
    // 保存の画面に出る名前（無いと Electron は URL の末尾から file.png にする）。
    await expect(link).toHaveAttribute('download', `${base}.png`);
    const png = readFileSync(join(project.dir, 'サムネ', `${base}.png`));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 720]);
    // ざらざらの写真を全面に敷くと PNG は 2MB を超える。
    const noisy = join(project.dir, 'noise.png');
    execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=1280x720,noise=alls=100:allf=t+u', '-frames:v', '1', noisy]);
    const uploaded = await request.post(`/api/thumbnail/upload?id=${project.id}&name=noise.png`, { data: readFileSync(noisy) });
    expect(uploaded.ok(), await uploaded.text()).toBe(true);
    const asset = (await uploaded.json() as { asset: { id: string } }).asset, state = await thumbnailState(request, project.id);
    const registered = await request.post(`/api/thumbnail/register?id=${project.id}`, { data: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), assetIds: [asset.id] } });
    expect(registered.ok(), await registered.text()).toBe(true);
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, index: 0,
      layer: { id: 'noise', name: 'ざらざら', hidden: false, locked: false, content: { kind: 'image', assetId: asset.id, role: 'photo' }, visual: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1 } } });
    await page.getByRole('button', { name: 'PNG で書き出し' }).click();
    const offer = page.getByRole('alert').filter({ hasText: 'YouTube のサムネは 2MB まで' });
    await expect(offer).toBeVisible({ timeout: 120_000 });
    // 同じ名前は上書き（案ごとに最新の 1 枚）。
    await expect(link).toHaveText(`${base}.png`);
    expect(statSync(join(project.dir, 'サムネ', `${base}.png`)).size).toBeGreaterThan(2 * 1024 * 1024);
    await offer.getByRole('button', { name: 'JPEG で書き出す' }).click();
    await expect(link).toHaveText(`${base}.jpg`, { timeout: 120_000 });
    expect(statSync(join(project.dir, 'サムネ', `${base}.jpg`)).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    // JPEG に書き直したら、同じ名前の古い PNG は消える。
    expect(readdirSync(join(project.dir, 'サムネ'))).toEqual([`${base}.jpg`]);
    await expect(offer).toHaveCount(0);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

test('書き出し中に動画のモードへ戻っても、書き出しが終わったら知らせが出る。サムネに戻るとリンクが出ている', async ({ page, request }) => {
  test.setTimeout(180_000);
  const project = createThumbnailProject('e2e-thumb-export-leave'), base = `${basename(project.dir)} サムネ`;
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('title', '書き出し') });
    // 書き出しの状態の問い合わせを、動画のモードへ戻るまで止める（その間に書き出しが終わっても、画面はまだ知らない状態にする）。
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/thumbnail/export/status**', async route => { await gate; await route.continue().catch(() => undefined); });
    await page.getByRole('button', { name: 'PNG で書き出し' }).click();
    await expect(page.getByRole('button', { name: '取り消す' })).toBeVisible();
    const modes = page.getByRole('group', { name: 'モード' });
    await modes.getByRole('button', { name: '編集', exact: true }).click();
    await expect(page.locator('.native-main')).toBeVisible();
    await expect(page.locator('.native-thumbnail')).toHaveCount(0);
    await expect.poll(() => existsSync(join(project.dir, 'サムネ', `${base}.png`)), { timeout: 120_000 }).toBe(true);
    release();
    await expect(page.getByText(/に書き出しました/)).toBeVisible({ timeout: 30_000 });
    await modes.getByRole('button', { name: 'サムネ', exact: true }).click();
    await expect(page.locator('.native-thumbnail-export-link')).toHaveText(`${base}.png`);
  } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await page.goto('about:blank'); removeTempProject(project.dir); }
});

/** 画面を通さずに書き出す（一覧のライブ更新だけを確かめるため）。終わるまで待つ。 */
async function exportByApi(request: APIRequestContext, projectId: string, pageId: string): Promise<void> {
  const state = await thumbnailState(request, projectId), executionId = crypto.randomUUID();
  const started = await request.post(`/api/thumbnail/export?id=${projectId}`, { data: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId, pageId, format: 'png' } });
  expect(started.ok(), await started.text()).toBe(true);
  await expect.poll(async () => (await (await request.get(`/api/thumbnail/export/status?id=${projectId}&executionId=${executionId}`)).json() as { phase: string }).phase,
    { timeout: 120_000 }).toBe('complete');
}

test('メインの案を書き出すと、左のプロジェクト一覧のカードの画像が書き出した画像に変わる（一覧を開き直さなくてよい）', async ({ page, request }) => {
  test.setTimeout(240_000);
  const project = createThumbnailProject('e2e-thumb-cover');
  try {
    await openThumbnailMode(page, project.id);
    const pageId = (await thumbnailState(request, project.id)).document.pages[0]!.id;
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('title', 'カード') });
    await page.getByRole('group', { name: 'モード' }).getByRole('button', { name: '編集', exact: true }).click();
    await expect(page.locator('.native-thumbnail')).toHaveCount(0);
    const thumb = page.locator(`#native-panel-projects .fb-item[aria-label="${project.id}"] .fb-thumb`), cover = thumb.locator('img[src*="/api/thumbnail/cover"]');
    await expect(thumb).toHaveCount(1);
    await thumb.scrollIntoViewIfNeeded();
    await expect(cover).toHaveCount(0);
    await exportByApi(request, project.id, pageId);
    expect(existsSync(join(project.dir, 'サムネ', `${basename(project.dir)} サムネ.png`))).toBe(true);
    await expect(cover).toHaveCount(1, { timeout: 30_000 });
    await cover.scrollIntoViewIfNeeded();
    // 実際に書き出した画像（1280×720）が読み込まれている。
    await expect.poll(() => cover.evaluate((img: HTMLImageElement) => img.complete ? img.naturalWidth : 0), { timeout: 30_000 }).toBe(1280);
    const first = await cover.getAttribute('src');
    // 同じ名前に上書きした 2 回目も、更新時刻で取り直す。
    await thumbnailCommand(request, project.id, { type: 'add-layer', pageId, layer: textLayer('title-2', '二回目') });
    await exportByApi(request, project.id, pageId);
    await expect.poll(() => cover.getAttribute('src'), { timeout: 30_000 }).not.toBe(first);
  } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
});

for (const theme of ['light', 'dark'] as const) {
  test(`下部の「すべての案を書き出す」: 案ごとに順に書き出して名前を知らせ、2MB を超えた案は JPEG を勧める（${theme}）`, async ({ page, request }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1440, height: 860 });
    await page.addInitScript(value => localStorage.setItem('sme-theme', value), theme);
    const project = createThumbnailProject(`e2e-thumb-export-all-${theme}`), ffmpeg = resolveFfmpegBin(), base = `${basename(project.dir)} サムネ`, folder = join(project.dir, 'サムネ');
    if (!ffmpeg.ok) throw new Error(ffmpeg.message);
    try {
      await openThumbnailMode(page, project.id);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const first = (await thumbnailState(request, project.id)).document.pages[0]!.id;
      await thumbnailCommand(request, project.id, { type: 'add-layer', pageId: first, layer: textLayer('title', '案A') });
      await page.getByRole('button', { name: '＋ 案を追加' }).click();
      await page.getByRole('button', { name: '空の案' }).click();
      await expect.poll(async () => (await thumbnailState(request, project.id)).document.pages.map(item => item.name)).toEqual(['案A', '案B', '案C']);
      const pageC = (await thumbnailState(request, project.id)).document.pages[2]!.id;
      // 案C だけ、ざらざらの写真で PNG を 2MB 超にする。
      const noisy = join(project.dir, 'noise.png');
      execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=1280x720,noise=alls=100:allf=t+u', '-frames:v', '1', noisy]);
      const uploaded = await request.post(`/api/thumbnail/upload?id=${project.id}&name=noise.png`, { data: readFileSync(noisy) });
      expect(uploaded.ok(), await uploaded.text()).toBe(true);
      const asset = (await uploaded.json() as { asset: { id: string } }).asset, state = await thumbnailState(request, project.id);
      const registered = await request.post(`/api/thumbnail/register?id=${project.id}`, { data: { sessionId: state.sessionId, expectedRevision: state.document.revision, executionId: crypto.randomUUID(), assetIds: [asset.id] } });
      expect(registered.ok(), await registered.text()).toBe(true);
      await thumbnailCommand(request, project.id, { type: 'add-layer', pageId: pageC,
        layer: { id: 'noise', name: 'ざらざら', hidden: false, locked: false, content: { kind: 'image', assetId: asset.id, role: 'photo' }, visual: { position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1 } } });
      // 案B をメインにする（書き出しの名前が <案件名> サムネ.png になる）。
      const pages = page.getByRole('list', { name: '案' });
      await pages.getByRole('button', { name: '案Bをメインにする' }).click();
      await expect(pages.locator('li').nth(1).locator('.native-thumbnail-page-main')).toHaveText('メイン');
      await page.getByRole('button', { name: 'すべての案を書き出す' }).click();
      await expect(page.getByText(`3 枚を書き出しました: ${base} 案A.png、${base}.png、${base} 案C.png`)).toBeVisible({ timeout: 180_000 });
      expect(readdirSync(folder).sort()).toEqual([`${base}.png`, `${base} 案A.png`, `${base} 案C.png`].sort());
      for (const name of readdirSync(folder)) expect(readFileSync(join(folder, name)).subarray(1, 4).toString('latin1')).toBe('PNG');
      const offer = page.getByRole('alert').filter({ hasText: '案C は 2MB を超えました' });
      await expect(offer).toBeVisible();
      // 存在検査: 下の案の縮小画像が届いてから撮る（空枠のまま撮らない）。
      const previews = page.locator('.native-thumbnail-page-pick img');
      await expect(previews).toHaveCount(3, { timeout: 60_000 });
      await expect.poll(() => previews.evaluateAll(items => items.every(item => item instanceof HTMLImageElement && item.complete && item.naturalWidth > 0)), { timeout: 60_000 }).toBe(true);
      await page.screenshot({ path: join(shotDir('thumbnail'), `m4-export-all-${theme}.png`) });
      // 下の帯は知らせ（トースト）が消えてから撮る（重なって帯が隠れるため）。押した位置にトーストが出て、上に乗ったままだと消えないので外す。
      await page.mouse.move(700, 300);
      await expect(page.locator('.native-toast')).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: 'すべての案を書き出す' })).toBeVisible();
      await page.locator('.native-thumbnail-bottom').screenshot({ path: join(shotDir('thumbnail'), `m4-pages-band-${theme}.png`) });
      await offer.getByRole('button', { name: 'JPEG で書き出し直す' }).click();
      await expect(page.getByText(`1 枚を書き出しました: ${base} 案C.jpg`)).toBeVisible({ timeout: 120_000 });
      expect(readdirSync(folder).sort()).toEqual([`${base}.png`, `${base} 案A.png`, `${base} 案C.jpg`].sort());
      expect(statSync(join(folder, `${base} 案C.jpg`)).size).toBeLessThanOrEqual(2 * 1024 * 1024);
      await expect(offer).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await page.goto('about:blank'); removeTempProject(project.dir); }
  });
}
