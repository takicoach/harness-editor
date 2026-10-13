import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { decodeRgba, startEditorServer } from '../../../scripts/native-render-capture';
import { applySlideCommand } from '../../core/slides/commands';
import { slidesFixture } from '../../core/slides/fixtures';
import { slidePageToSequence } from '../../core/slides/pageView';
import { SLIDE_THEMES } from '../../core/slides/themes';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { importSequenceAsset } from '../sequence/assets';
import { SlidesStore } from './store';

const chromiumBin = resolveNativeChromiumBin(), ffmpeg = resolveFfmpegBin(), available = chromiumBin.ok && ffmpeg.ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('スライドの描画の検証に Chromium と FFmpeg が必要です');
type RGB = readonly [number, number, number];
const hexRgb = (value: string): RGB => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
let root = '', server: Awaited<ReturnType<typeof startEditorServer>> | undefined, browser: Browser | undefined;
let document = slidesFixture();
beforeAll(async () => {
  if (!available || !ffmpeg.ok || !chromiumBin.ok) return;
  root = mkdtempSync(join(tmpdir(), 'slides-render-')); const project = join(root, 'render-case'); mkdirSync(project);
  const png = join(root, 'blue.png');
  execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=320x240', '-frames:v', '1', png]);
  const asset = await importSequenceAsset(project, png, 'blue.png');
  document = applySlideCommand(document, { type: 'batch', commands: [{ type: 'register-assets', assets: [asset] }, { type: 'add-page', pageId: 'page-3', layout: 'image-text' }] });
  document = applySlideCommand(document, { type: 'fill-image-slot', pageId: 'page-3', slot: 'image', assetId: asset.id });
  new SlidesStore(project).save({ expectedSavedRevision: null, executionId: 'seed', document });
  server = await startEditorServer(process.cwd(), root);
  browser = await chromium.launch({ executablePath: chromiumBin.bin });
}, 120_000);
afterAll(async () => { await browser?.close(); await server?.stop(); if (root) rmSync(root, { recursive: true, force: true }); });

it.skipIf(!available)('プレビューの slides 経路で、見出しの文字色と画像枠の画像（/api/slides/asset）が描かれる', async () => {
  const page = await browser!.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.goto(`${server!.origin}/native-render.html?${new URLSearchParams({ id: 'render-case', preview: '1', slides: '1' })}`);
  await page.waitForFunction(() => (window as unknown as { harnessNativeReady?: boolean; harnessNativeError?: string }).harnessNativeReady || (window as unknown as { harnessNativeError?: string }).harnessNativeError, undefined, { timeout: 60_000 });
  await page.evaluate(async serialized => {
    await (window as unknown as { harnessNativePreviewFrame(document: string, frame: number, bypass: boolean, isCurrent: () => boolean): Promise<unknown> }).harnessNativePreviewFrame(serialized, 0, false, () => true);
  }, JSON.stringify(slidePageToSequence(document, 'page-3')));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const rgba = decodeRgba(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } }));
  const count = (target: RGB, tolerance = 40) => { let total = 0; for (let i = 0; i < rgba.length; i += 4) if (Math.hypot(rgba[i]! - target[0], rgba[i + 1]! - target[1], rgba[i + 2]! - target[2]) < tolerance) total++; return total; };
  expect(count(hexRgb(SLIDE_THEMES['forest-gold'].colors.text))).toBeGreaterThan(300);
  expect(count([0, 0, 255])).toBeGreaterThan(50_000);
  expect(count([255, 0, 255])).toBe(0);
});
