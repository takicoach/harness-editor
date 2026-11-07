import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT } from './helpers';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';

/**
 * OSS 利用者の要望（2026-11-04）: 複数の動画は 1 本ずつ別のプロジェクト、フォルダは 1 つのプロジェクトの素材欄へ。
 * 本物のフォルダのドロップは Chrome の入力の口（CDP の Input.dispatchDragEvent）から作れる（JS で作る DataTransfer では webkitGetAsEntry が null になる）。
 */
let dir = '', vertical: Buffer, longer: Buffer;
const made: string[] = [];
test.beforeAll(() => {
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  dir = mkdtempSync(join(tmpdir(), 'home-folder-'));
  const sample = (seconds: number) => {
    const out = join(dir, `vertical-${seconds}.mp4`);
    execFileSync(ffmpeg.bin, ['-y', '-f', 'lavfi', '-i', `testsrc2=size=360x640:rate=24:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out], { stdio: 'ignore' });
    return readFileSync(out);
  };
  vertical = sample(1); longer = sample(2);
});
test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const id of made) rmSync(join(FIXTURES_ROOT, id), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('ホーム: 動画を 3 本ドロップすると 1 本ずつ別のプロジェクトになり、トップに留まる', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });
  const stamp = `multi-${process.pid}-${Date.now()}`;
  const dataTransfer = await page.evaluateHandle(([data, prefix]) => {
    const bytes = Uint8Array.from(atob(data!), (c) => c.charCodeAt(0)), dt = new DataTransfer();
    for (const n of ['c', 'a', 'b']) dt.items.add(new File([bytes], `${prefix}-${n}.mp4`, { type: 'video/mp4' }));
    return dt;
  }, [vertical.toString('base64'), stamp]);
  await page.dispatchEvent('.home', 'drop', { dataTransfer });
  const names = page.getByRole('list', { name: '作るプロジェクト' }).getByRole('listitem');
  await expect(names).toHaveCount(3);
  await expect(names.nth(0)).toContainText(`${stamp}-a`);
  await page.getByTestId('home-create-copy').check();
  await page.locator('.home-create-dialog .export-start').click();
  await expect(page.locator('.home-drop-notice')).toHaveText('3 本のプロジェクトを作りました', { timeout: 60_000 });
  expect(new URL(page.url()).searchParams.get('project')).toBeNull();
  const listed = await (await page.request.get('/api/projects')).json() as { projects: Array<{ id: string }> };
  made.push(...listed.projects.filter((project) => project.id.includes(stamp)).map((project) => project.id));
  expect(made.filter((id) => id.includes(stamp))).toHaveLength(3);
  for (const n of ['a', 'b', 'c']) await expect(page.locator('.home-card', { hasText: `${stamp}-${n}` })).toBeVisible();
});

test('ホーム: 本物のフォルダを落とすと、下の階層の動画まで素材欄に入り、動画以外と隠しファイルは入らない', async ({ page }) => {
  const name = `real-folder-${process.pid}-${Date.now()}`, folder = join(dir, name);
  mkdirSync(join(folder, '2日目'), { recursive: true });
  writeFileSync(join(folder, 'first.mp4'), vertical); writeFileSync(join(folder, '2日目', 'second.mp4'), longer);
  writeFileSync(join(folder, '.hidden.mp4'), vertical); writeFileSync(join(folder, 'memo.txt'), 'memo');
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });
  const box = await page.locator('.home-head').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [folder], dragOperationsMask: 1 }, at = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, ...at, data });
  const dialog = page.locator('.home-create-dialog');
  await expect(dialog).toContainText(`フォルダ「${name}」の動画 2 本を素材欄に入れます`);
  await expect(dialog).toContainText('台本や書類 1 件は「資料」に保管します');
  await page.getByTestId('home-create-copy').check();
  await dialog.locator('.export-start').click();
  await page.waitForURL(/project=/, { timeout: 60_000 });
  const id = new URL(page.url()).searchParams.get('project')!; made.push(id);
  await expect(page.getByRole('button', { name: 'first.mp4を再生位置に置く' })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'second.mp4を再生位置に置く' })).toBeAttached();
  const { document } = await (await page.request.post(`/api/sequence/session?${new URLSearchParams({ id })}`, { data: {} })).json() as { document: { assets: unknown[]; clips: unknown[] } };
  expect(document.assets).toHaveLength(2); expect(document.clips).toEqual([]);
});

async function dropRealFolders(page: Page, folders: string[]) {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });
  const box = await page.locator('.home-head').boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: folders, dragOperationsMask: 1 }, at = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, ...at, data });
}
async function openScriptPanel(page: Page) {
  await page.getByRole('tab', { name: '台本' }).first().click();
}

test('ホーム: 本物のフォルダを 2 つ落とすと 2 プロジェクトになりトップに留まる。開くと素材欄に動画、台本欄に書類があり、読み込むと本文が入る', async ({ page }) => {
  const stamp = `${process.pid}-${Date.now()}`, one = `two-a-${stamp}`, two = `two-b-${stamp}`, empty = `two-empty-${stamp}`;
  for (const name of [one, two, empty]) mkdirSync(join(dir, name, '台本'), { recursive: true });
  writeFileSync(join(dir, one, 'first.mp4'), vertical); writeFileSync(join(dir, two, 'second.mp4'), longer);
  writeFileSync(join(dir, one, '台本', '第1回.txt'), '一行目の台本です\n二行目です\n'); writeFileSync(join(dir, one, '~$第1回.docx'), 'lock');
  writeFileSync(join(dir, empty, '台本', 'メモ.txt'), 'x');
  await dropRealFolders(page, [join(dir, one), join(dir, two), join(dir, empty)]);
  const dialog = page.locator('.home-create-dialog');
  await expect(dialog).toContainText('フォルダ 2 個を、それぞれ別のプロジェクトとして作ります');
  await expect(dialog.getByRole('list', { name: '作るプロジェクト' }).getByRole('listitem')).toHaveText([one, two]);
  await expect(dialog).toContainText(`作らないフォルダ: フォルダ「${empty}」に動画がありません`);
  await expect(page.getByTestId('home-create-copy')).toBeChecked(); // ブラウザ版はコピーが既定
  await dialog.locator('.export-start').click();
  made.push(one, two);
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('.home-card', { hasText: one })).toBeVisible();
  await expect(page.locator('.home-card', { hasText: two })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('project')).toBeNull();
  // 待ち終えた時点で準備が済んでいる。開くと素材欄へ自動で入る。
  await page.goto(`/?${new URLSearchParams({ project: one })}`);
  await expect(page.getByRole('button', { name: 'first.mp4を再生位置に置く' })).toBeAttached({ timeout: 30_000 });
  const { document } = await (await page.request.post(`/api/sequence/session?${new URLSearchParams({ id: one })}`, { data: {} })).json() as { document: { assets: unknown[]; clips: unknown[] } };
  expect(document.assets).toHaveLength(1); expect(document.clips).toEqual([]);
  await openScriptPanel(page);
  const documents = page.getByRole('region', { name: '資料' });
  await expect(documents).toContainText('台本/第1回.txt');
  await expect(documents).not.toContainText('~$');
  await documents.getByRole('button', { name: '台本/第1回.txt を台本に読み込む' }).click();
  await expect(page.locator('#native-shooting-script')).toHaveValue(/一行目の台本です/);
  // 別のプロジェクトには書類が混ざらない。
  const list = await (await page.request.get(`/api/project/documents?${new URLSearchParams({ id: two })}`)).json() as { documents: unknown[] };
  expect(list.documents).toEqual([]);
});

test('ホーム: 「素材フォルダから作成」で選んだフォルダは、ドロップと同じく動画と書類に分かれ、開くと素材欄に入る', async ({ page }) => {
  const name = `picked-${process.pid}-${Date.now()}`, folder = join(dir, name);
  mkdirSync(join(folder, '2日目'), { recursive: true });
  writeFileSync(join(folder, 'first.mp4'), vertical); writeFileSync(join(folder, '2日目', 'second.mp4'), longer);
  writeFileSync(join(folder, '構成.md'), '# 構成\n'); writeFileSync(join(folder, '.hidden.mp4'), vertical);
  await page.goto('/');
  await expect(page.getByTestId('home-create-media-folder')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('home-create-folder-input').setInputFiles(folder);
  const dialog = page.locator('.home-create-dialog');
  await expect(dialog).toContainText(`フォルダ「${name}」の動画 2 本を素材欄に入れます`);
  await expect(dialog).toContainText('台本や書類 1 件は「資料」に保管します');
  await page.getByTestId('home-create-copy').check();
  await dialog.locator('.export-start').click();
  await page.waitForURL(/project=/, { timeout: 60_000 });
  const id = new URL(page.url()).searchParams.get('project')!; made.push(id);
  await expect(page.getByRole('button', { name: 'second.mp4を再生位置に置く' })).toBeAttached({ timeout: 30_000 });
  expect(readFileSync(join(FIXTURES_ROOT, id, '資料', '構成.md'), 'utf8')).toBe('# 構成\n');
});

test('フォルダの流れ: 動画は素材欄にだけ入り、最初に置いた縦動画の大きさと fps に案件が合う', async ({ page }) => {
  const name = `folder-${process.pid}-${Date.now()}`;
  const created = await page.request.post(`/api/create-project-empty?${new URLSearchParams({ name, native: '1' })}`);
  expect(created.ok(), await created.text()).toBe(true);
  const { id } = await created.json() as { id: string };
  made.push(id);
  const batch = await page.request.post(`/api/sequence/imports?${new URLSearchParams({ id })}`, {
    data: { requestId: crypto.randomUUID(), mode: 'copy', origin: 'home', placement: 'materials', items: [{ key: '0', name: 'clip-a.mp4' }, { key: '1', name: 'clip-b.mp4' }] },
  });
  expect(batch.ok(), await batch.text()).toBe(true);
  const view = await batch.json() as { batchId: string; placement: string; items: Array<{ itemId: string }> };
  expect(view.placement).toBe('materials');
  for (const [index, item] of view.items.entries()) {
    const sent = await page.request.post(`/api/sequence/imports/upload?${new URLSearchParams({ id, batch: view.batchId, item: item.itemId })}`, { data: index === 0 ? vertical : longer, headers: { 'content-type': 'application/octet-stream' } });
    expect(sent.ok(), await sent.text()).toBe(true);
  }
  await page.goto(`/?project=${encodeURIComponent(id)}`);
  // 素材の欄が開いていて、準備ができたら自動で素材欄に入る。メインには並ばない（仮の枠も出ない）。
  const place = (asset: string) => page.getByRole('button', { name: `${asset}を再生位置に置く` });
  await expect(place('clip-a.mp4')).toBeVisible({ timeout: 30_000 });
  await expect(place('clip-b.mp4')).toBeVisible();
  const session = async () => (await (await page.request.post(`/api/sequence/session?${new URLSearchParams({ id })}`, { data: {} })).json() as { document: { clips: unknown[]; assets: unknown[]; resolution: { width: number; height: number }; fps: { num: number; den: number } } }).document;
  const before = await session();
  expect(before.clips).toEqual([]);expect(before.assets).toHaveLength(2);
  await expect(page.locator('.native-import-frame')).toHaveCount(0);
  // 「再生位置に置く」は行に指を乗せた時だけ押せる重ね表示。
  await page.locator('.native-asset-row', { hasText: 'clip-a.mp4' }).hover();
  await place('clip-a.mp4').click();
  await expect.poll(async () => (await session()).clips.length).toBeGreaterThan(0);
  const after = await session();
  expect(after.resolution).toEqual({ width: 360, height: 640 });
  expect(after.fps.num / after.fps.den).toBe(24);
});
