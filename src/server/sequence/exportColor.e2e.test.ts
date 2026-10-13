// The JPEG intermediate must not move colours. Chromium's JPEG
// is YUV 4:2:0 in BT.601 full range (JFIF); reading it as BT.709 or limited range shifts saturated colours by 10-20.
// Solid patches of known sRGB colours go through the real capture and the product's FFmpeg arguments twice, once as
// PNG (the reference: RGB straight in) and once as JPEG (the product), and the delivered MP4s must agree per patch.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright-core';
import { resolveNativeChromiumBin } from '../resolveNativeChromium';
import { resolveFfmpegBin } from '../resolveFfmpeg';
import { captureFrameFormat, encoderArguments, nativeExportVideoSettings, openRenderSurface, startFrameEncoder } from './exportRunner';

const chromiumBin = resolveNativeChromiumBin(), ffmpeg = resolveFfmpegBin(), available = chromiumBin.ok && ffmpeg.ok;
if (!available && process.env.HARNESS_REQUIRE_CAPTURE_E2E === '1') throw new Error('書き出しの色の検証に通常Chrome/FFmpegが必要です');

/** sRGB: the primaries, a skin tone, greys, and saturated mixes where a 601/709 mix-up shows most. */
const COLORS: Array<[string, [number, number, number]]> = [
  ['red', [255, 0, 0]], ['green', [0, 255, 0]], ['blue', [0, 0, 255]], ['skin', [233, 180, 150]], ['grey', [128, 128, 128]],
  ['white', [255, 255, 255]], ['black', [0, 0, 0]], ['amber', [255, 200, 0]], ['sky', [0, 200, 255]], ['purple', [180, 0, 200]],
];
const WIDTH = 640, HEIGHT = 360, COLUMNS = 5, PATCH_W = WIDTH / COLUMNS, PATCH_H = HEIGHT / 2, FRAMES = 3, FPS = { num: 30, den: 1 };
const page = `<style>html,body{margin:0;overflow:hidden}#stage{width:${WIDTH}px;height:${HEIGHT}px;display:grid;grid-template-columns:repeat(${COLUMNS},${PATCH_W}px);grid-auto-rows:${PATCH_H}px}</style>`
  + `<div id="stage">${COLORS.map(([, [red, green, blue]]) => `<div style="background:rgb(${red},${green},${blue})"></div>`).join('')}</div>`
  + '<script>window.harnessNativeFrame=async()=>{};window.harnessNativeReady=true</script>';

let server: Server, browser: Browser, origin = '', directory = '';
beforeAll(async () => {
  if (!available) return;
  server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(page); }).listen(0, '127.0.0.1');
  await once(server, 'listening'); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ executablePath: chromiumBin.ok ? chromiumBin.bin : '' });
  directory = await mkdtemp(join(tmpdir(), 'export-color-e2e-'));
});
afterAll(async () => { await browser?.close(); server?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

/** Capture FRAMES frames in one mode and encode them with the product's arguments (optionally altered). */
async function exportPatches(mode: 'reference' | 'fast', name: string, alter: (args: string[]) => string[] = args => args) {
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  const surface = await openRenderSurface(browser, origin, { projectId: 'color', jobId: name }, { width: WIDTH, height: HEIGHT }, { captureMode: mode });
  const frames: Buffer[] = [];
  try { for (let frame = 0; frame < FRAMES; frame++) frames.push(await surface.capture(frame)); } finally { await surface.close?.(); }
  const audioFile = join(directory, `${name}.f32le`), output = join(directory, `${name}.mp4`);
  await writeFile(audioFile, Buffer.alloc(48000 * FRAMES / 30 * 2 * 4));
  const { filter, crf } = nativeExportVideoSettings({ width: WIDTH, height: HEIGHT });
  const encoder = startFrameEncoder(ffmpeg.bin, alter(encoderArguments({ fps: FPS, audioFile, filter, crf, output, input: captureFrameFormat(mode) })), new AbortController().signal);
  try { for (const frame of frames) await encoder.write(frame); await encoder.finish(); } finally { await encoder.stop(); }
  return { frames, output };
}
/** The delivered MP4's last frame as RGB (as tagged: BT.709 limited range), averaged over the inner half of each patch. */
function patchMeans(file: string): Array<[number, number, number]> {
  if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  const rgb = execFileSync(ffmpeg.bin, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${FRAMES - 1}),scale=in_color_matrix=bt709:in_range=tv,format=rgb24`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
  expect(rgb.length).toBe(WIDTH * HEIGHT * 3);
  return COLORS.map((_, index) => {
    const left = (index % COLUMNS) * PATCH_W + PATCH_W / 4, top = Math.floor(index / COLUMNS) * PATCH_H + PATCH_H / 4, sum = [0, 0, 0];
    for (let y = top; y < top + PATCH_H / 2; y++) for (let x = left; x < left + PATCH_W / 2; x++) for (let c = 0; c < 3; c++) sum[c]! += rgb[(y * WIDTH + x) * 3 + c]!;
    return sum.map(value => value / (PATCH_W / 2 * PATCH_H / 2)) as [number, number, number];
  });
}
const worst = (a: Array<[number, number, number]>, b: Array<[number, number, number]>) => Math.max(...a.flatMap((patch, i) => patch.map((value, c) => Math.abs(value - b[i]![c]!))));
const rounded = (means: Array<[number, number, number]>) => Object.fromEntries(COLORS.map(([name], i) => [name, means[i]!.map(value => Math.round(value * 10) / 10)]));

it.skipIf(!available)('the JPEG path delivers the same colours as the PNG path (each patch, each channel within 2)', async () => {
  const png = await exportPatches('reference', 'png'), jpeg = await exportPatches('fast', 'jpeg');
  // Presence: the two paths really captured different intermediates, of the drawn patches.
  expect(png.frames.every(frame => frame[0] === 0x89 && frame[1] === 0x50)).toBe(true);
  expect(jpeg.frames.every(frame => frame[0] === 0xff && frame[1] === 0xd8)).toBe(true);
  const expected = patchMeans(png.output), actual = patchMeans(jpeg.output);
  console.log('[export-color]', JSON.stringify({ png: rounded(expected), jpeg: rounded(actual), worst: Math.round(worst(expected, actual) * 100) / 100 }));
  // The reference path is near the drawn sRGB (limited range, 4:2:0 and crf 18 cost a few steps), so the patches exist.
  expect(worst(expected, COLORS.map(([, value]) => value))).toBeLessThanOrEqual(6);
  expect(worst(expected, actual)).toBeLessThanOrEqual(2);

  // Control: the same JPEGs read as BT.709 must fail this comparison, or it could not see the mix-up it is for.
  const misread = await exportPatches('fast', 'jpeg-709', args => args.map(arg => arg.replace('in_color_matrix=bt601', 'in_color_matrix=bt709')));
  const wrong = patchMeans(misread.output);
  console.log('[export-color] read as BT.709:', JSON.stringify({ jpeg709: rounded(wrong), worst: Math.round(worst(expected, wrong) * 100) / 100 }));
  expect(worst(expected, wrong)).toBeGreaterThan(10);
}, 120_000);
