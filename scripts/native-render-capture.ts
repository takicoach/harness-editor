/**
 * 描画の回帰基準（設計書 受け入れ条件 5）。任意項目を使わない文字・画像・図形を、
 * 指定した作業ツリーの dev サーバーで native-render.html に描かせて撮る。
 * 基準は bake-native-render-baseline.ts が「変更前のコミット」の作業ツリーで撮り、
 * nativeRenderBaseline.e2e.test.ts が今の作業ツリーで撮って画素を比べる。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { DEFAULT_MAIN_LAYOUT } from '../src/core/mainLayout';
import { DEFAULT_TEXT_APPEARANCE, type ClipVisual, type SequenceAsset, type SequenceClip, type SequenceDocument, type TextAppearance } from '../src/core/sequence/model';
import type { ShapeKind, ShapeThickness } from '../src/core/types';
import { resolveFfmpegBin } from '../src/server/resolveFfmpeg';
import { resolveNativeChromiumBin } from '../src/server/resolveNativeChromium';
import { importSequenceAsset } from '../src/server/sequence/assets';
import { SequenceStore } from '../src/server/sequence/store';

export const BASELINE_REF = '35f740a9';
export const BASELINE_DIR = '.native-render-baseline';
export const RENDER_PROJECT_ID = 'render-baseline';
export interface RenderCase { name: string; document: SequenceDocument }
export interface RenderShot { name: string; width: number; height: number; png: Buffer; rgba: Buffer; sha256: string }
export interface BaselineManifest { ref: string; commit: string; chromium: string; cases: Record<string, { width: number; height: number; sha256: string }> }
export interface RenderAssets { pattern: SequenceAsset; cutout: SequenceAsset }
type PreviewWindow = Window & { harnessNativeReady?: boolean; harnessNativeError?: string;
  harnessNativePreviewFrame?: (document: string, frame: number, bypass: boolean, isCurrent: () => boolean) => Promise<unknown> };

const clock = () => ({ offset: { num: 0, den: 1 }, rate: { num: 1, den: 1 }, duration: { num: 1, den: 1 } });
const still = () => ({ kind: 'none' as const, frames: 0 });
function placed(x: number, y: number, scale: number, rotation: number, opacity = 1): ClipVisual {
  return { layout: { ...DEFAULT_MAIN_LAYOUT, position: { x, y }, scale, rotation }, opacity, keyframes: [], enter: still(), exit: still() };
}
function caseDocument(name: string, width: number, height: number, assets: SequenceAsset[], clips: SequenceClip[]): SequenceDocument {
  return { schemaVersion: 2, id: `case-${name}`, name, revision: 1, fps: { num: 30, den: 1 }, resolution: { width, height }, sequenceEndFrame: 1,
    background: '#101820', assets, tracks: clips.map(clip => ({ id: clip.trackId, kind: 'visual' as const, name: clip.name, enabled: true })),
    clips, transitions: [], transcripts: [], ducking: { enabled: false, strength: 'mid' } };
}
function clipOf(id: string, content: SequenceClip['content'], visual?: ClipVisual): SequenceClip {
  return { id, trackId: `t-${id}`, name: id, startFrame: 0, durationFrames: 1, clock: clock(), content, ...(visual ? { visual } : {}) };
}
function text(id: string, value: string, appearance: TextAppearance, visual?: ClipVisual): SequenceClip {
  return clipOf(id, { kind: 'telop', data: { text: value, animation: 'none' }, appearance, textMode: 'free' }, visual);
}
function shape(id: string, kind: ShapeKind, points: [number, number, number, number], color: string, thickness: ShapeThickness, extra: { opacity?: number; x3?: number; y3?: number } = {}): SequenceClip {
  const [x1, y1, x2, y2] = points;
  return clipOf(id, { kind: 'shape', data: { kind, x1, y1, x2, y2, color, thickness, ...extra } }, placed(0, 0, 1, 0));
}

/** 任意項目を 1 つも使わない描画ケース。動画側の既存テロップ（visual なし）とサムネ相当（visual あり）の両方を含める。 */
export function renderCases(assets: RenderAssets): RenderCase[] {
  const both = [assets.pattern, assets.cutout];
  return [
    { name: 'text-default', document: caseDocument('text-default', 640, 360, [], [text('t1', 'サムネの基準 ABC', { ...DEFAULT_TEXT_APPEARANCE, fontSize: 40 })]) },
    { name: 'text-styled', document: caseDocument('text-styled', 640, 360, [], [text('t1', 'ふたつの\n行です', { ...DEFAULT_TEXT_APPEARANCE, fontSize: 36, fontWeight: 700,
      color: '#ffd400', strokeColor: '#000000', strokeWidth: 4, background: '#d0204a', align: 'left', lineHeight: 1.2, letterSpacing: 2 }, placed(0, -.15, .9, 8))]) },
    { name: 'text-vertical', document: caseDocument('text-vertical', 360, 640, [], [text('t1', '縦の画面', { ...DEFAULT_TEXT_APPEARANCE, fontSize: 32 })]) },
    { name: 'image-plain', document: caseDocument('image-plain', 640, 360, both, [
      clipOf('i1', { kind: 'image', assetId: assets.pattern.id, style: 'plain' }, placed(.2, -.1, .5, -12, .8)),
      clipOf('i2', { kind: 'image', assetId: assets.cutout.id, style: 'plain' }, placed(-.5, .4, .3, 0))]) },
    { name: 'shapes', document: caseDocument('shapes', 640, 360, [], [
      shape('s1', 'rect', [.1, .1, .4, .5], '#ff3b30', 'thick'),
      shape('s2', 'ellipse', [.45, .1, .7, .45], '#ffcc00', 'thin', { opacity: .6 }),
      shape('s3', 'arrow', [.1, .8, .5, .6], '#ffffff', 'medium'),
      shape('s4', 'line', [.55, .9, .95, .55], '#0a84ff', 'thin'),
      shape('s5', 'triangle', [.75, .1, .95, .4], '#e05c8a', 'thick'),
      shape('s6', 'angle', [.7, .7, .9, .6], '#34c759', 'medium', { x3: .85, y3: .9 })]) },
    { name: 'mixed', document: caseDocument('mixed', 640, 360, both, [
      clipOf('m1', { kind: 'image', assetId: assets.pattern.id, style: 'plain' }, placed(0, 0, 1, 0)),
      shape('m2', 'rect', [.05, .6, .6, .95], '#000000', 'medium'),
      text('m3', '重ねた文字', { ...DEFAULT_TEXT_APPEARANCE, fontSize: 44, fontWeight: 700 }, placed(0, .3, 1, 0))]) },
  ];
}

/** 案件ルートに描画用の案件を 1 つ作る。画像素材は ffmpeg で生成して管理素材として取り込む。 */
export async function prepareRenderProject(projectRoot: string): Promise<RenderAssets> {
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  const project = join(projectRoot, RENDER_PROJECT_ID), work = mkdtempSync(join(tmpdir(), 'render-assets-'));
  mkdirSync(project, { recursive: true });
  try {
    const patternFile = join(work, 'pattern.png'), cutoutFile = join(work, 'cutout.png');
    execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x3366cc:s=64x48', '-vf', 'drawbox=x=0:y=0:w=32:h=48:color=0xffaa00:t=fill', '-frames:v', '1', patternFile]);
    execFileSync(ffmpeg.bin, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=100x100,format=rgba', '-vf', 'drawbox=x=25:y=25:w=50:h=50:color=0x00ff00@1:t=fill:replace=1', '-frames:v', '1', cutoutFile]);
    const pattern = await importSequenceAsset(project, patternFile, 'pattern.png'), cutout = await importSequenceAsset(project, cutoutFile, 'cutout.png');
    new SequenceStore(project).save({ expectedSavedRevision: null, executionId: 'render-baseline', document: caseDocument('project', 640, 360, [pattern, cutout], []) });
    return { pattern, cutout };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('空きポートを取れません')));
    });
  });
}

/** 指定した作業ツリーの vite を子プロセスで起動する（その作業ツリーの描画コードとサーバーで動く）。 */
export async function startEditorServer(treeDirectory: string, projectRoot: string): Promise<{ origin: string; pid: number; stop(): Promise<void> }> {
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(treeDirectory, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: treeDirectory, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SME_PORT: String(port), SME_NO_OPEN: '1', HARNESS_PROJECT_ROOT: projectRoot, SME_PROJECT_ROOT: projectRoot, SME_TUTORIAL: '0', SME_AUTO_SAVE: '0' } });
  let log = '';
  child.stdout!.on('data', data => { log = (log + String(data)).slice(-8000); });
  child.stderr!.on('data', data => { log = (log + String(data)).slice(-8000); });
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev サーバーが終了しました:\n${log}`);
    try { const response = await fetch(`${origin}/api/ping`); if (response.ok) return { origin, pid: child.pid!, stop }; } catch { /* 起動中 */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await stop();
  throw new Error(`dev サーバーが 90 秒以内に起動しませんでした:\n${log}`);
}

async function openRenderPage(browser: Browser, origin: string): Promise<Page> {
  for (let attempt = 1; ; attempt++) {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${origin}/native-render.html?${new URLSearchParams({ id: RENDER_PROJECT_ID, preview: '1' })}`);
      await page.waitForFunction(() => (window as PreviewWindow).harnessNativeReady === true || !!(window as PreviewWindow).harnessNativeError, undefined, { timeout: 60_000 });
      const error = await page.evaluate(() => (window as PreviewWindow).harnessNativeError);
      if (error) throw new Error(error);
      return page;
    } catch (error) {
      // 初回は vite の依存最適化で再読み込みが入ることがある。
      await page.close();
      if (attempt >= 3) throw error;
    }
  }
}

export async function captureCase(page: Page, document: SequenceDocument): Promise<Buffer> {
  await page.setViewportSize(document.resolution);
  await page.evaluate(async serialized => { await (window as PreviewWindow).harnessNativePreviewFrame!(serialized, 0, false, () => true); }, JSON.stringify(document));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.screenshot({ type: 'png', clip: { x: 0, y: 0, ...document.resolution } });
}

export function decodeRgba(png: Buffer): Buffer {
  const ffmpeg = resolveFfmpegBin(); if (!ffmpeg.ok) throw new Error(ffmpeg.message);
  return execFileSync(ffmpeg.bin, ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { input: png, maxBuffer: 64 * 1024 * 1024 });
}

/** treeDirectory の描画で全ケースを撮る。同じ入力で 2 回撮り、一致しなければ失敗（撮影の揺れを基準に持ち込まない）。 */
export async function captureRenderCases(treeDirectory: string): Promise<{ chromium: string; shots: RenderShot[] }> {
  const chromiumBin = resolveNativeChromiumBin(); if (!chromiumBin.ok) throw new Error(chromiumBin.message);
  const projectRoot = mkdtempSync(join(tmpdir(), 'render-baseline-root-'));
  let server: Awaited<ReturnType<typeof startEditorServer>> | undefined, browser: Browser | undefined;
  try {
    const assets = await prepareRenderProject(projectRoot);
    server = await startEditorServer(treeDirectory, projectRoot);
    browser = await chromium.launch({ executablePath: chromiumBin.bin });
    const page = await openRenderPage(browser, server.origin), cases = renderCases(assets), shots: RenderShot[] = [];
    await captureCase(page, cases[0]!.document);
    for (const item of cases) {
      const first = await captureCase(page, item.document), second = await captureCase(page, item.document);
      const rgba = decodeRgba(first);
      if (!rgba.equals(decodeRgba(second))) throw new Error(`同じ入力で 2 回撮った画素が違います: ${item.name}`);
      shots.push({ name: item.name, ...item.document.resolution, png: first, rgba, sha256: createHash('sha256').update(rgba).digest('hex') });
    }
    return { chromium: browser.version(), shots };
  } finally {
    await browser?.close().catch(() => undefined);
    await server?.stop();
    rmSync(projectRoot, { recursive: true, force: true });
  }
}
