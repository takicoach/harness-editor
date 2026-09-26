import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveFfmpegBin, resolveFfprobeBin } from '../src/server/resolveFfmpeg';
import { makeMediaSamples, type MediaSamples } from '../src/server/sequence/__fixtures__/mediaSamples';
import { imageUploadPrefix } from '../src/shared/imageUploadFrame';

/**
 * 新画面: 音声・画像から作品を作る（spec: docs/specs/2026-09-26-native-media-import-design.md）。
 * jsdom では確かめられない「実ブラウザの入口・実際の MP4 書き出し・EXIF の表示の縦横・チュートリアルの再開」をここで確かめる。
 * 作成物は SME_PROJECT_ROOT（src/server/__fixtures__）に専用名で作り、前後で消す。名前に worker 番号を混ぜる（create-project.spec.ts と同じ理由）。
 * 単一の素材は「コピーして取り込む」にチェックして作る（参照を優先する既定の経路は e2e 環境で保存場所の確認に入るため。着手前の赤 create-project.spec.ts 5 件と同じ事情）。
 */
const W = process.env['TEST_PARALLEL_INDEX'] ?? '0';
const FIXTURES_ROOT = resolve(import.meta.dirname, '../src/server/__fixtures__');
const BROWSE_ROOT = resolve(import.meta.dirname, '.browse-root');
const LEARNING_HOME = resolve(import.meta.dirname, '.learning-home');
const SAMPLES_DIR = resolve(import.meta.dirname, `.native-media-tmp-${W}`);
const NAMES = { audio: `e2e-media-audio-${W}`, images: `e2e-media-images-${W}`, exif: `e2e-media-exif-${W}`, picked: `e2e-media-picked-${W}`,
  tutorial: `e2e-media-tutorial-${W}`, tutorialAudio: `e2e-media-tutorial-audio-${W}`, legacy: `e2e-media-legacy-${W}`, cardAudio: `e2e-media-card-audio-${W}`, cardImages: `e2e-media-card-images-${W}` };
const PICKED = [`picked-b-${W}.png`, `picked-a-${W}.png`].map((name) => join(BROWSE_ROOT, name));
let samples: MediaSamples;

const cleanup = () => { for (const name of Object.values(NAMES)) rmSync(join(FIXTURES_ROOT, name), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); };
test.beforeAll(() => {
  cleanup(); rmSync(SAMPLES_DIR, { recursive: true, force: true }); mkdirSync(SAMPLES_DIR, { recursive: true });
  samples = makeMediaSamples(SAMPLES_DIR);
  // 3 秒の音声（2 秒の試料より長く、文字起こしの試料の語 0.5〜1.2 秒を含む）。
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  execFileSync(ffmpeg.bin, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', join(SAMPLES_DIR, 'podcast.wav')]);
  mkdirSync(BROWSE_ROOT, { recursive: true });
  copyFileSync(samples.green, PICKED[0]!); copyFileSync(samples.blue, PICKED[1]!);
});
test.afterAll(() => { cleanup(); rmSync(SAMPLES_DIR, { recursive: true, force: true }); for (const path of PICKED) rmSync(path, { force: true }); });
test.afterEach(async ({ page }) => { await page.close(); });

const savedDocument = (name: string) => { const saved = JSON.parse(readFileSync(join(FIXTURES_ROOT, name, '.harness/project.v2.json'), 'utf8')); return saved.document ?? saved; };

async function createFromFiles(page: Page, files: string[], name: string, options: { copy?: boolean; path?: string } = {}): Promise<void> {
  await page.goto(options.path ?? '/');
  await page.locator('[data-testid=home-create-file]').setInputFiles(files);
  const dialog = page.locator('.home-create-dialog');
  await expect(dialog).toBeVisible();
  if (options.copy) await dialog.getByTestId('home-create-copy').check();
  await dialog.locator('.home-create-name').fill(name);
  await dialog.getByRole('button', { name: '作成', exact: true }).click();
  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });
}

/** 画面の「書き出し」から書き出し、完了した書き出しの記録を返す。 */
async function exportFromScreen(page: Page, request: APIRequestContext, name: string): Promise<{ id: string; file: string }> {
  const button = page.getByRole('button', { name: '書き出し', exact: true });
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
  await page.getByRole('button', { name: '書き出し開始' }).click();
  let job: { id: string; phase: string; error?: string } | undefined;
  await expect.poll(async () => {
    const list = await (await request.get(`/api/sequence/export/list?id=${encodeURIComponent(name)}`)).json();
    job = list.jobs[0];
    return job?.phase;
  }, { timeout: 150_000, intervals: [1000] }).toMatch(/^(complete|failed)$/);
  expect(job!.error ?? '').toBe('');
  return { id: job!.id, file: join(FIXTURES_ROOT, name, '.harness/exports', job!.id, 'output.mp4') };
}

function probe(file: string): { streams: Array<Record<string, unknown>> } {
  const ffprobe = resolveFfprobeBin(); if (!ffprobe.ok) throw new Error(ffprobe.message);
  return JSON.parse(execFileSync(ffprobe.bin, ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
}
/** 書き出した MP4 の 1 コマを 1 画素へ縮めた色（R,G,B）。 */
function colorAt(file: string, seconds: number): number[] {
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  return [...execFileSync(ffmpeg.bin, ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])];
}

/** 学習ループの回帰条件: 新規作成の作品を書き出しても、差分パネルも学習の記録も出ない。 */
async function expectNoLearning(page: Page, request: APIRequestContext, name: string, jobId: string): Promise<void> {
  await page.waitForTimeout(2000);
  await expect(page.getByRole('dialog', { name: 'AIとの差分レビュー' })).toHaveCount(0);
  const diff = await (await request.get(`/api/learning/diff?id=${encodeURIComponent(name)}&job=${encodeURIComponent(jobId)}`)).json();
  expect(diff).toMatchObject({ cut: null, telops: null, ses: null });
  for (const file of ['cut_feedback.jsonl', 'telop_feedback.jsonl', 'se_feedback.jsonl']) {
    const path = join(LEARNING_HOME, file);
    expect(existsSync(path) ? readFileSync(path, 'utf8').includes(`"videoId":"${name}"`) : false, file).toBe(false);
  }
}

test('音声1件: 作成 → 文字起こし → ことばのカット → Undo・やり直し → 字幕 → 保存・再読み込み → 実際の MP4（映像1本・コマ数・音声1本）', async ({ page, request }) => {
  test.setTimeout(240_000);
  await createFromFiles(page, [join(SAMPLES_DIR, 'podcast.wav')], NAMES.audio, { copy: true });
  let doc = savedDocument(NAMES.audio);
  expect(doc).toMatchObject({ fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 90 });
  expect(doc.tracks.map((track: { id: string }) => track.id)).toEqual(['a-main']);

  // 文字起こしのボタンが使える（右パネルの「字幕一覧」。SME_TRANSCRIBE_MOCK の試料: 「ゆる」0.5〜0.8秒・「素振り」0.8〜1.2秒）。
  await page.getByRole('tab', { name: '字幕一覧' }).click();
  await page.getByRole('button', { name: '文字起こしを生成' }).click();
  await expect(page.getByRole('status').filter({ hasText: '文字起こしができました' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: '生成結果を確認' }).click();
  await page.getByRole('button', { name: 'この結果を取り込む' }).click();
  const word = page.locator('.native-words button', { hasText: 'ゆる' });
  await expect(word).toBeVisible();

  await word.click();
  await page.getByRole('button', { name: '選択したことばをカット' }).click();
  await expect(page.getByRole('button', { name: '元に戻す' })).toBeEnabled();
  await page.getByRole('button', { name: '元に戻す' }).click();
  await page.getByRole('button', { name: 'やり直す' }).click();
  await page.getByRole('button', { name: 'T テキスト' }).click();
  await expect(page.locator('.native-save-state')).toHaveText('未保存の変更');
  await page.locator('.native-save-button').click();
  await expect(page.locator('.native-save-state')).toHaveText('保存済み', { timeout: 15_000 });

  doc = savedDocument(NAMES.audio);
  expect(doc.transcripts[0].words.map((w: { text: string }) => w.text)).toEqual(['ゆる', '素振り']);
  expect(doc.cutArchive.entries).toHaveLength(1);
  // ことばの分だけ原音が短くなる（字幕は再生位置から 3 秒で置くので、作品の長さではなく原音の長さで確かめる）。
  const speech = doc.clips.filter((clip: { content: { kind: string } }) => clip.content.kind === 'audio');
  expect(speech.reduce((sum: number, clip: { durationFrames: number }) => sum + clip.durationFrames, 0)).toBeLessThan(90);
  expect(doc.clips.filter((clip: { content: { kind: string } }) => clip.content.kind === 'telop')).toHaveLength(1);
  await page.reload();
  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });
  // 再読み込み後も、カットで分かれた原音2つと字幕1つがタイムラインに残る。
  await expect(page.getByRole('button', { name: /^podcast\.wav \d+〜\d+フレーム$/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^テキスト \d+〜\d+フレーム$/ })).toHaveCount(1);

  const job = await exportFromScreen(page, request, NAMES.audio);
  const streams = probe(job.file).streams;
  const videos = streams.filter((s) => s['codec_type'] === 'video'), audios = streams.filter((s) => s['codec_type'] === 'audio');
  expect(videos).toHaveLength(1); expect(audios).toHaveLength(1);
  expect(Number(videos[0]!['nb_read_frames'])).toBe(doc.sequenceEndFrame);
  expect(Math.abs(Number(audios[0]!['duration_ts']) - doc.sequenceEndFrame / 30 * 48000)).toBeLessThanOrEqual(1);
  await expectNoLearning(page, request, NAMES.audio, job.id);
});

test('画像3枚: 作成 → 5秒ずつ並ぶ → 保存・再読み込み → 実際の MP4（無音の AAC・各画像が切り替わる）', async ({ page, request }) => {
  test.setTimeout(240_000);
  await createFromFiles(page, [samples.red, samples.green, samples.blue], NAMES.images);
  const doc = savedDocument(NAMES.images);
  expect(doc).toMatchObject({ fps: { num: 30, den: 1 }, resolution: { width: 1920, height: 1080 }, sequenceEndFrame: 450 });
  const expectClips = async () => {
    for (const [index, name] of ['red.png', 'green.png', 'blue.png'].entries()) {
      await expect(page.getByRole('button', { name: `${name} ${index * 150}〜${(index + 1) * 150}フレーム`, exact: true })).toBeVisible();
    }
  };
  await expectClips();
  // 作成で保存済み。開き直しても同じ並び（テスト方針（第2版）の「保存・再読み込み」）。
  await page.reload();
  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });
  await expectClips();
  const job = await exportFromScreen(page, request, NAMES.images);
  const streams = probe(job.file).streams;
  const video = streams.find((s) => s['codec_type'] === 'video')!, audios = streams.filter((s) => s['codec_type'] === 'audio');
  expect(Number(video['nb_read_frames'])).toBe(450);
  expect(audios).toHaveLength(1); expect(audios[0]!['codec_name']).toBe('aac');
  expect(Math.abs(Number(audios[0]!['duration_ts']) - 720_000)).toBeLessThanOrEqual(1);
  const dominant = (rgb: number[]) => rgb.indexOf(Math.max(...rgb));
  expect([2.5, 7.5, 12.5].map((seconds) => dominant(colorAt(job.file, seconds)))).toEqual([0, 1, 2]);
  await expectNoLearning(page, request, NAMES.images, job.id);
});

test('EXIF の向き付き JPEG: 作品の縦横がブラウザーの表示の縦横と一致する（設計 M3c）', async ({ page }) => {
  await createFromFiles(page, [samples.exifRotatedJpg], NAMES.exif, { copy: true });
  const doc = savedDocument(NAMES.exif);
  expect(doc.resolution).toEqual({ width: 1080, height: 1920 });
  const natural = await page.evaluate(async (src) => { const image = new Image(); image.src = src; await image.decode(); return [image.naturalWidth, image.naturalHeight]; },
    `/api/sequence/asset?${new URLSearchParams({ id: NAMES.exif, asset: doc.assets[0].id })}`);
  expect(natural).toEqual([360, 640]);
  expect(natural[0]! / natural[1]!).toBeCloseTo(doc.resolution.width / doc.resolution.height, 3);
});

test('入口: ドロップは画像の複数を受け、混在は案内だけ。フォルダから選ぶは画像を複数選べてコピーで作る（設計 M1・M6b）', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home')).toBeVisible({ timeout: 15_000 });
  const drop = async (files: Array<[string, string]>) => {
    const dataTransfer = await page.evaluateHandle((list) => { const dt = new DataTransfer(); for (const [name, type] of list) dt.items.add(new File(['00'], name, { type })); return dt; }, files);
    await page.dispatchEvent('.home', 'drop', { dataTransfer });
  };
  await drop([['talk.mp3', 'audio/mpeg'], ['cover.png', 'image/png']]);
  await expect(page.locator('.home-drop-notice')).toHaveText('動画・音声・画像のどれか1種類を選んでください');
  await expect(page.locator('.home-create-dialog')).toHaveCount(0);
  await drop([['b.png', 'image/png'], ['a.png', 'image/png']]);
  await expect(page.locator('.home-create-file-note')).toHaveText('素材: 画像 2 枚（a.png ほか）');
  await page.locator('.export-cancel').click();

  await page.locator('.home-create-link-btn').first().click();
  await page.locator('.mp-root').first().click();
  await page.locator('.mp-file', { hasText: `picked-b-${W}.png` }).click();
  await page.locator('.mp-file', { hasText: `picked-a-${W}.png` }).click();
  await page.getByTestId('mp-confirm').click();
  await expect(page.getByTestId('home-create-images-note')).toContainText('画像 2 枚');
  await page.locator('.home-create-name').fill(NAMES.picked);
  await page.locator('.home-create-dialog').getByRole('button', { name: '作成', exact: true }).click();
  await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });
  const doc = savedDocument(NAMES.picked);
  expect(doc.clips.map((clip: { name: string }) => clip.name)).toEqual([`picked-b-${W}.png`, `picked-a-${W}.png`]);
  for (const asset of doc.assets) expect(lstatSync(join(FIXTURES_ROOT, NAMES.picked, asset.file)).isSymbolicLink()).toBe(false);
});

for (const kind of ['audio', 'images'] as const) {
  test(`チュートリアル: ${kind === 'audio' ? '音声1件' : '画像3枚'}から作っても、作成後の編集画面で案内が続く（設計 M6b）`, async ({ page }) => {
    // 案内の続き（再開）は設定が有効なときだけ働く（SME_TUTORIAL=0 のままだと編集画面で消される）。/api/config を差し替えて有効にする。
    let configHits = 0;
    await page.route('**/api/config', async (route) => {
      configHits += 1;
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), tutorialEnabled: true } });
    });
    await page.goto('/');
    await expect(page.locator('[data-tutorial="home-grid"]')).toBeVisible({ timeout: 15_000 });
    for (const step of ['welcome', 'home-intro', 'board']) {
      await expect(page.locator(`.tut[data-step="${step}"]`)).toBeVisible();
      await page.locator('.tut .tut-next').click();
    }
    await expect(page.locator('.tut[data-step="create"]')).toBeVisible();
    await page.getByTestId('home-create-file').setInputFiles(kind === 'audio' ? [join(SAMPLES_DIR, 'podcast.wav')] : [samples.red, samples.green, samples.blue]);
    const dialog = page.locator('.home-create-dialog');
    if (kind === 'audio') await dialog.getByTestId('home-create-copy').check();
    await dialog.locator('.home-create-name').fill(kind === 'audio' ? NAMES.tutorialAudio : NAMES.tutorial);
    await dialog.getByRole('button', { name: '作成', exact: true }).click();
    await expect(page.locator('.native-timeline-panel')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.tut[data-step="modes"]')).toBeVisible({ timeout: 15_000 });
    expect(configHits, '/api/config の差し替えが効いていない').toBeGreaterThan(0);
  });
}

test('旧画面（?legacy=1）のホームも同じ入口で、画像から作ると新画面の編集へ移る', async ({ page }) => {
  await page.goto('/?legacy=1');
  const input = page.locator('[data-testid=home-create-file]');
  await expect(input).toHaveAttribute('multiple', '');
  expect((await input.getAttribute('accept'))!.split(',')).toEqual(expect.arrayContaining(['.mp3', '.png']));
  await createFromFiles(page, [samples.red, samples.green], NAMES.legacy, { path: '/?legacy=1' });
  expect(savedDocument(NAMES.legacy).clips).toHaveLength(2);
  await expect(page).toHaveURL(new RegExp(`project=${NAMES.legacy}`));
});

test('ホームのカード: 音声の作品は音声の印と長さ、画像の作品は先頭の画像（設計 M6c）', async ({ page, request }) => {
  // このテストだけで完結させる（前のテストの作品に頼らない）。作成は画面と同じ API で行う。
  const audio = await request.post(`/api/create-project?${new URLSearchParams({ native: '1', name: NAMES.cardAudio, video: 'podcast.wav' })}`, { data: readFileSync(join(SAMPLES_DIR, 'podcast.wav')) });
  expect(audio.status(), await audio.text()).toBe(200);
  const images = [samples.green, samples.red].map((path) => ({ name: path.split('/').at(-1)!, bytes: readFileSync(path) }));
  const body = Buffer.concat([Buffer.from(imageUploadPrefix(images.map((image) => ({ name: image.name, size: image.bytes.length })))), ...images.map((image) => image.bytes)]);
  const created = await request.post(`/api/create-project-images?${new URLSearchParams({ native: '1', name: NAMES.cardImages })}`, { data: body });
  expect(created.status(), await created.text()).toBe(200);
  await page.goto('/');
  await expect(page.locator('.home-card', { hasText: NAMES.cardAudio }).getByRole('img', { name: '音声の作品（0:03）' })).toBeVisible({ timeout: 15_000 });
  const thumb = page.locator('.home-card', { hasText: NAMES.cardImages }).locator('.home-card-thumb img');
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(640);
});
