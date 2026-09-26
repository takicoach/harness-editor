/**
 * nativeExport オーバーレイ通し合成 e2e。
 *
 * M2c ではじめて「テロップ / タイトル / 挿入画像 / 図形 / SE が載ったプロジェクトを
 * planFastCut → prepareCapture（実 Chromium 撮影）→ 実 ffmpeg 合成」まで通しで回し、
 * 出力 mp4 の**画素**を実測する。ここまでの検証は層ごと（撮影スモーク＝PNG まで／
 * 図形 e2e＝ffmpeg だけ）に閉じており、「撮った PNG が本当に正しいフレームへ正しい z 順で
 * 焼かれているか」は一度も観測されていない。
 *
 * ## 期待値の作り方（この e2e の骨）
 * 出力 mp4 の画素を「手計算した色」ではなく **撮影された代表 PNG そのもの**から作る:
 *   expected(x,y,f) = over(BG, capturedPng(runOf(f))(x,y))
 * こうすると
 *   - フレーム写像（密連番 + image2 + setpts シフト）が frame-exact か
 *   - スパンが途中フレームから始まる（startFrame>0）ときも写像がずれないか
 *   - z 順（画像 → 図形 → telop+title）が保たれているか
 * が **1つの計器**で測れる。比較器が「何を比べても通る」無感な物になっていないことは、
 * 期待写像を1フレームずらす対照（RED 相当）で毎回証明する。
 *
 * ベース映像は単色（0x004400）。over() の背景が全画素で定数になるので、期待値が
 * 撮影 PNG だけで決まる（nativeExportShape.e2e.test.ts と同じ流儀・同じ色域選定）。
 *
 * ## サーバ / ブラウザの起動方式
 * captureSmoke.e2e.test.ts と同じ: vite の createServer を in-process で起動し、
 * chromium は1本をファイル内で共有する（撮影ドライバへ deps で流す）。
 * getServerOrigin() は plugin.ts 側の realm でしか記録されないため（captureSmoke の
 * 調査コメント参照）、planFastCut には serverOrigin を deps 注入する。
 *
 * ## レンダ回数
 * 本ファイルの ffmpeg 実行は **base プロジェクト1本 × 1回**（通し合成の全ケース）。撮影も同数。
 * 実テロップ（金ストローク）での yuv420 クロマ乖離の実測（ケース4）は有料素材を使うので
 * `.product.e2e.test.ts` へ分けた。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planFastCut, type FastCutCaptureDeps } from './fastCutPlan';
import {
  captureSpecifiedRuns,
  type CaptureDeps,
  type CaptureManifestRun,
  type CapturePage,
} from './captureDriver';
import { decodePngRgba } from './pngRgba';
import { probeFrameCount } from './probeFrames';
import { pcmWindowRms } from './renderCompare';
import { resolveChromiumBin } from './resolveChromium';
import { resolveFfmpegBin } from './resolveFfmpeg';
import type { FastCutPrepareOutcome } from './fastCutCapture';

/**
 * chromium が使えない環境（未ダウンロード・実体不在）ではファイルごと skip する。
 * M2d T1: 判定の正本を resolveChromiumBin に一本化（captureDriver の実起動経路と同じ関数）。
 */
const chromiumResolved = resolveChromiumBin();
const chromiumUsable = chromiumResolved.ok;

// captureSmoke.e2e.test.ts と同じ I-5 規律: CI で黙って skip され続ける事故を防ぐ。
if (!chromiumUsable && process.env['HARNESS_REQUIRE_CAPTURE_E2E'] === '1') {
  throw new Error(
    `HARNESS_REQUIRE_CAPTURE_E2E=1 ですが chromium が使えません（kind: ${chromiumResolved.ok ? '' : chromiumResolved.kind}）。` +
      'nativeExport オーバーレイ e2e が黙って skip されるのを防ぐため、テストファイルの読み込み自体を失敗させます。',
  );
}

const ffmpeg = resolveFfmpegBin();
if (!ffmpeg.ok && process.env['HARNESS_REQUIRE_CAPTURE_E2E'] === '1') {
  throw new Error('HARNESS_REQUIRE_CAPTURE_E2E=1 ですが ffmpeg が見つかりません。');
}
const FFMPEG = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';

// ---------------------------------------------------------------------------
// fixture 諸元（すべて原本＝合成解像度基準）
// ---------------------------------------------------------------------------
const W = 360;
const H = 640;
const FPS = 30;
/** 原本尺。カット [80,120) を落とすので再生尺は 160。 */
const DURATION_FRAMES = 200;
const TOTAL_FRAMES = 160;
/** ベース映像の色（0x004400・YUV 往復が素直な色域。shape e2e と同じ選定）。 */
const BG = { r: 0, g: 68, b: 0 };

/** 実撮影に使う PNG。説明画像は版ごとに違うため、試験内で同じ画像を生成する。 */
const REAL_IMAGE_FILE = 'overlay-e2e-photo.png';

/**
 * テロップ / タイトルの再生フレーム座標（cutData の [80,120) 落としを反映済み）。
 * - telopA: 原本 [10,70) → 再生 [10,70)
 * - telopB: 原本 [130,190) → 再生 [90,150)
 * - title : 原本 [140,180) → 再生 [100,140)（telopB と時間・空間の両方で重なる）
 * - image : 原本 [10,70) → 再生 [10,70)
 * - shape : 原本 [130,190) → 再生 [90,150)
 * - SE    : 原本 130 → 再生 90（= 3.0 秒）
 */
const TELOP_B = { start: 90, end: 150 };
const IMAGE = { start: 10, end: 70 };

/** 撮影スパン（planFastCut が作る和集合）。telop+title は2本・image は1本。 */
const TELOP_TITLE_SPANS = [
  { start: 10, end: 70 },
  { start: 90, end: 150 },
];

/** タイトル帯（TELOP_CONFIG）。telopB の文字帯と重なる位置へ意図的に置く。 */
const TITLE_STYLE = { top: 380, left: 60, fontSize: 40 };

/**
 * 観測領域（実測で決めた実値・すべて出力解像度＝原本解像度の絶対座標）。
 * - TELOP_RECT: テロップ文字帯（実測 y=362..433）とタイトル帯（実測 y=380..443）を含む矩形
 * - TELOP_LOWER_RECT: 帯の下端だけ。スパン1では挿入画像（実測 y=223..416）が重なるため、
 *   テロップ単独の写像を見るときはこの帯だけを使う
 * - IMAGE_RECT: 挿入画像の内側（テロップ帯より上）
 * - OVERLAP: タイトルとテロップのインクが両方かかる点（実測で選定・下のテストが非退化を検査）
 * - SHAPE_EDGE: 矩形図形の上辺の内側（実測: ストロークは y=59..68）
 */
const TELOP_RECT = { x: 40, y: 358, w: 280, h: 88 };
const TELOP_LOWER_RECT = { x: 40, y: 418, w: 280, h: 16 };
const IMAGE_RECT = { x: 40, y: 230, w: 280, h: 100 };
const OVERLAP = { x: 150, y: 400 };
const SHAPE_EDGE = { x: 180, y: 63 };

/** nativeExportShape.e2e.test.ts と同じ書式の近似一致（差と許容を必ずメッセージへ出す）。 */
function expectClose(actual: number, expected: number, tol: number, label: string): void {
  const diff = Math.abs(actual - expected);
  expect(
    diff,
    `${label}: 実測${actual.toFixed(2)} 期待${expected.toFixed(2)} 差${diff.toFixed(2)} 許容${tol}`,
  ).toBeLessThanOrEqual(tol);
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** RGBA（straight alpha）を背景色へ合成する（overlay の基本式）。 */
function over(bg: Rgb, fg: { r: number; g: number; b: number; a: number }): Rgb {
  return {
    r: (bg.r * (255 - fg.a) + fg.r * fg.a) / 255,
    g: (bg.g * (255 - fg.a) + fg.g * fg.a) / 255,
    b: (bg.b * (255 - fg.a) + fg.b * fg.a) / 255,
  };
}

/** 出力 mp4 の [from,to] フレーム × 矩形領域を rgb24 生データで取り出す。 */
function extractRegionFrames(
  video: string,
  from: number,
  to: number,
  rect: { x: number; y: number; w: number; h: number },
): Buffer[] {
  const filter = `select='between(n\\,${from}\\,${to})',crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`;
  const buf = execFileSync(
    FFMPEG,
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', video,
      '-vf', filter,
      '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-y', '-',
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  const frameBytes = rect.w * rect.h * 3;
  const count = to - from + 1;
  if (buf.length !== frameBytes * count) {
    throw new Error(
      `extractRegionFrames: 取り出せたバイト数(${buf.length})が想定(${frameBytes * count} = ${count}フレーム)と一致しません`,
    );
  }
  return Array.from({ length: count }, (_, i) => buf.subarray(i * frameBytes, (i + 1) * frameBytes));
}

/** 1 フレーム分の rgb24 バッファから (x,y) の色を読む（rect 相対座標）。 */
function pixelOf(frame: Buffer, rect: { w: number }, x: number, y: number): Rgb {
  const off = (y * rect.w + x) * 3;
  return { r: frame[off]!, g: frame[off + 1]!, b: frame[off + 2]! };
}

/** 撮影マニフェスト（レイヤ種別ごとに記録する）。 */
interface RecordedManifest {
  runs: CaptureManifestRun[];
  pngFiles: string[];
}

/** フレーム f を含む run の代表 PNG を返す（無ければ null＝そのフレームは撮影対象外）。 */
function pngForFrame(manifest: RecordedManifest, f: number): string | null {
  const run = manifest.runs.find((r) => r.startFrame <= f && f < r.endFrame);
  if (run === undefined) return null;
  return manifest.pngFiles[run.pngFileIndex] ?? null;
}

/** 撮影 PNG（RGBA）を decode してキャッシュする。 */
const pngCache = new Map<string, ReturnType<typeof decodePngRgba>>();
function decodeCached(path: string): ReturnType<typeof decodePngRgba> {
  const hit = pngCache.get(path);
  if (hit !== undefined) return hit;
  const decoded = decodePngRgba(readFileSync(path));
  pngCache.set(path, decoded);
  return decoded;
}

function rgbaAt(
  img: ReturnType<typeof decodePngRgba>,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const off = (y * img.width + x) * 4;
  return { r: img.data[off]!, g: img.data[off + 1]!, b: img.data[off + 2]!, a: img.data[off + 3]! };
}

/** 領域内の「期待（撮影 PNG を背景へ合成）」と「実測（mp4）」の乖離統計。 */
interface DeviationStats {
  /** 比較した画素数。 */
  pixels: number;
  /** 3 チャンネルの絶対差の最大。 */
  maxAbs: number;
  /** 3 チャンネルの絶対差の平均。 */
  meanAbs: number;
  /** 撮影 PNG 側で不透明（a=255）だった画素の数（非退化の存在検査）。 */
  opaquePixels: number;
}

function compareRegion(
  frame: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  png: ReturnType<typeof decodePngRgba> | null,
): DeviationStats {
  let maxAbs = 0;
  let sum = 0;
  let opaque = 0;
  for (let dy = 0; dy < rect.h; dy++) {
    for (let dx = 0; dx < rect.w; dx++) {
      const actual = pixelOf(frame, rect, dx, dy);
      const fg = png === null
        ? { r: 0, g: 0, b: 0, a: 0 }
        : rgbaAt(png, rect.x + dx, rect.y + dy);
      if (fg.a === 255) opaque += 1;
      const expected = over(BG, fg);
      const d = [
        Math.abs(actual.r - expected.r),
        Math.abs(actual.g - expected.g),
        Math.abs(actual.b - expected.b),
      ];
      for (const v of d) {
        if (v > maxAbs) maxAbs = v;
        sum += v;
      }
    }
  }
  const pixels = rect.w * rect.h;
  return { pixels, maxAbs, meanAbs: sum / (pixels * 3), opaquePixels: opaque };
}

// ---------------------------------------------------------------------------
// fixture プロジェクトの組み立て
// ---------------------------------------------------------------------------

function videoConfigSource(opts: {
  fps: number;
  duration: number;
  width: number;
  height: number;
  titleStyle?: { top: number; left: number; fontSize: number };
}): string {
  const telopConfig = opts.titleStyle === undefined
    ? ''
    : `export const TELOP_CONFIG = { titleTop: ${opts.titleStyle.top}, titleLeft: ${opts.titleStyle.left}, titleFontSize: ${opts.titleStyle.fontSize} };\n`;
  return (
    `export type VideoFormat = 'youtube' | 'short' | 'square';\n` +
    `export const FORMAT: VideoFormat = 'short';\n` +
    `export const FPS = ${opts.fps};\n` +
    `export const DURATION_FRAMES = ${opts.duration};\n` +
    `export const VIDEO_FILE = 'main.mp4';\n` +
    `export const RESOLUTION = { width: ${opts.width}, height: ${opts.height} };\n` +
    telopConfig
  );
}

/** 単色・CFR のベース映像（無音トラック付き）を作る。 */
function writeBaseVideo(path: string, durationFrames: number, fps: number): void {
  const durationSec = durationFrames / fps;
  execFileSync(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=0x004400:size=${W}x${H}:rate=${fps}:duration=${durationSec}`,
    '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:duration=${durationSec}`,
    '-shortest',
    '-r', String(fps),
    '-pix_fmt', 'yuv420p',
    path,
  ]);
}

describe.skipIf(!chromiumUsable || !ffmpeg.ok)('nativeExport オーバーレイ通し合成（実 ffmpeg + 実 Chromium）', () => {
  let tmpRoot: string;
  let previousProjectRoot: string | undefined;
  let previousNoOpen: string | undefined;
  let server: { close(): Promise<void> };
  let browser: { newPage(opts: unknown): Promise<unknown>; close(): Promise<void> };
  let baseUrl: string;
  let sharedCaptureDeps: CaptureDeps;

  /** base プロジェクトの通し合成の成果物。 */
  let outPath: string;
  let manifests: Map<string, RecordedManifest>;
  let cleanups: Array<() => void> = [];
  /** 撮影段の計測（report 用）。 */
  const timings: Record<string, number> = {};

  function makeCaptureDeps(recordInto: Map<string, RecordedManifest>): FastCutCaptureDeps['captureSpecifiedRuns'] {
    return async (req, _deps) => {
      const result = await captureSpecifiedRuns(req, sharedCaptureDeps);
      if (result.ok) recordInto.set(req.layer, result.manifest);
      return result;
    };
  }

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'harness-overlay-e2e-'));
    previousProjectRoot = process.env.SME_PROJECT_ROOT;
    previousNoOpen = process.env.SME_NO_OPEN;
    process.env.SME_PROJECT_ROOT = tmpRoot;
    process.env.SME_NO_OPEN = '1';

    const fixture = resolve(import.meta.dirname, '__fixtures__', 'sample-project');
    const baseDir = join(tmpRoot, 'overlay-project');
    cpSync(fixture, baseDir, { recursive: true });

    // --- videoConfig / cutData ---
    writeFileSync(
      join(baseDir, 'src', 'videoConfig.ts'),
      videoConfigSource({ fps: FPS, duration: DURATION_FRAMES, width: W, height: H, titleStyle: TITLE_STYLE }),
      'utf8',
    );
    // 原本 [0,80) と [120,200) を残す（= カット区間 [80,120)）。再生尺は 160。
    writeFileSync(
      join(baseDir, 'src', 'cutData.ts'),
      `export const cutData: {\n  id: number;\n  originalStart: number;\n  originalEnd: number;\n  playbackStart: number;\n  playbackEnd: number;\n}[] = [\n` +
        `  { id: 1, originalStart: 0, originalEnd: 80, playbackStart: 0, playbackEnd: 80 },\n` +
        `  { id: 2, originalStart: 120, originalEnd: 200, playbackStart: 80, playbackEnd: 160 },\n];\n`,
      'utf8',
    );

    // --- telop（fixture Telop.tsx: opacity = min(1,(frame-startFrame)/8) の線形フェード） ---
    writeFileSync(
      join(baseDir, 'src', 'テロップテンプレート', 'telopData.ts'),
      `import type { TelopSegment } from './telopTypes';\n` +
        `import { FPS as CONFIG_FPS, DURATION_FRAMES } from '../videoConfig';\n\n` +
        `export const FPS = CONFIG_FPS;\nexport const TOTAL_FRAMES = DURATION_FRAMES;\n\n` +
        `export const telopData: TelopSegment[] = [\n` +
        `  { id: 1, startFrame: 10, endFrame: 70, text: "てろっぷあ", style: "warning", template: 1 },\n` +
        `  { id: 2, startFrame: 90, endFrame: 150, text: "かさなり", style: "warning", template: 1 },\n];\n`,
      'utf8',
    );

    // --- title（原本 [140,180) → 再生 [100,140)） ---
    mkdirSync(join(baseDir, 'src', 'Title'), { recursive: true });
    writeFileSync(
      join(baseDir, 'src', 'Title', 'titleData.ts'),
      `export interface TitleSegment { id: number; startFrame: number; endFrame: number; text: string }\n` +
        `export const titleData: TitleSegment[] = [\n` +
        `  { id: 41, startFrame: 100, endFrame: 140, text: "重なり" },\n];\n`,
      'utf8',
    );

    // --- 挿入画像（原本 [10,70)・enter/exit は既定の 8 フレームフェード） ---
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1470x780:rate=1',
      '-frames:v', '1', '-y', join(baseDir, 'public', 'images', REAL_IMAGE_FILE),
    ]);
    writeFileSync(
      join(baseDir, 'src', 'InsertImage', 'insertImageData.ts'),
      `import type { ImageSegment } from './types';\n\n` +
        `export const insertImageData: ImageSegment[] = [\n` +
        `  { id: 1, startFrame: 10, endFrame: 70, file: '${REAL_IMAGE_FILE}', type: 'photo' },\n];\n`,
      'utf8',
    );

    // --- 図形（原本 [130,190) → 再生 [90,150)・矩形の上辺で実測する） ---
    writeFileSync(
      join(baseDir, 'src', 'InsertShape', 'shapeData.ts'),
      `import type { ShapeSegment } from './types';\n\n` +
        `export const shapeData: ShapeSegment[] = [\n` +
        `  { id: 1, startFrame: 90, endFrame: 150, kind: 'rect', x1: 0.2, y1: 0.1, x2: 0.8, y2: 0.35, color: '#FFCC00', thickness: 'thick', opacity: 1 },\n];\n`,
      'utf8',
    );

    // --- SE（原本 130 → 再生 90 = 3.0 秒）。fixture の beep.mp3 は 16 バイトのダミーなので実音を作る ---
    execFileSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=1760:duration=0.5', join(baseDir, 'public', 'se', 'beep.wav')]);
    writeFileSync(
      join(baseDir, 'src', 'SoundEffects', 'seData.ts'),
      `import type { SoundEffect } from './SEPlayer';\n\n` +
        `export const seData: SoundEffect[] = [\n  { id: 1, startFrame: 90, file: 'beep.wav', volume: 1 },\n];\n`,
      'utf8',
    );

    writeBaseVideo(join(baseDir, 'public', 'main.mp4'), DURATION_FRAMES, FPS);

    // --- vite dev サーバ（撮影ページ）と chromium ---
    const port = await new Promise<number>((resolvePort) => {
      const probe = createNetServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const chosen = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolvePort(chosen));
      });
    });
    baseUrl = `http://127.0.0.1:${port}`;
    const { createServer } = await import('vite');
    server = await createServer({
      configFile: resolve(import.meta.dirname, '..', '..', 'vite.config.ts'),
      server: { port, strictPort: true, open: false },
      logLevel: 'silent',
    }).then(async (created) => {
      await created.listen();
      return created;
    });
    // I-1: 共有ブラウザも撮影本番と同じ実体で起動する（@playwright/test の既定 launch だと
    // resolveChromiumBin の解決結果が空振りし、e2e が「別の Chromium」で緑になってしまう）。
    if (!chromiumResolved.ok) throw new Error(chromiumResolved.message);
    // どの実体で走ったかを stdout に1行残す（証跡化）。
    process.stdout.write(`[capture-e2e] chromium source=${chromiumResolved.source} bin=${chromiumResolved.bin}\n`);
    const { chromium } = await import('playwright-core');
    browser = (await chromium.launch({ executablePath: chromiumResolved.bin })) as unknown as typeof browser;
    sharedCaptureDeps = {
      launchChromium: async (opts) => {
        const page = (await browser.newPage({
          viewport: opts.viewport,
          deviceScaleFactor: opts.deviceScaleFactor,
        })) as unknown as CapturePage & { close(): Promise<void> };
        return { page, close: () => page.close() };
      },
    };

    // --- 通し合成1回（base プロジェクト） ---
    manifests = new Map();
    outPath = join(baseDir, 'out', 'overlay-e2e.mp4');
    mkdirSync(join(baseDir, 'out'), { recursive: true });
    const plan = planFastCut(
      baseDir,
      { resolution: 'full', quality: 'high' },
      outPath,
      {
        hardware: false,
        capture: {
          projectId: 'overlay-project',
          serverOrigin: () => baseUrl,
          captureSpecifiedRuns: makeCaptureDeps(manifests),
        },
      },
    );
    expect(plan, 'planFastCut が null（撮影経路に乗っていない）').not.toBeNull();
    expect(plan!.totalFrames).toBe(TOTAL_FRAMES);
    expect(plan!.prepareCapture, 'prepareCapture が無い（オーバーレイ検出に失敗）').toBeDefined();

    const t0 = Date.now();
    let estimate: { distinctFrames: number; estimatedMs: number } | null = null;
    const outcome: FastCutPrepareOutcome = await plan!.prepareCapture!((e) => {
      estimate = e;
    });
    timings.prepareMs = Date.now() - t0;
    if (!outcome.ok) throw new Error(`prepareCapture が失敗しました: ${outcome.reason}`);
    if (outcome.cleanup !== undefined) cleanups.push(outcome.cleanup);
    expect(estimate, '撮影見積が報告されていない').not.toBeNull();
    timings.distinctFrames = (estimate as unknown as { distinctFrames: number }).distinctFrames;

    const t1 = Date.now();
    execFileSync(FFMPEG, outcome.args, { maxBuffer: 64 * 1024 * 1024 });
    timings.ffmpegMs = Date.now() - t1;
    // eslint-disable-next-line no-console
    console.log(
      `[nativeExportOverlay.e2e] base 通し合成: prepare(撮影+リンク)=${timings.prepareMs}ms / ffmpeg=${timings.ffmpegMs}ms / distinct=${timings.distinctFrames}fr`,
    );
  }, 600_000);

  afterAll(async () => {
    for (const c of cleanups) {
      try {
        c();
      } catch {
        /* 後始末の失敗は結果に影響させない */
      }
    }
    cleanups = [];
    await browser?.close();
    await server?.close();
    if (previousProjectRoot === undefined) delete process.env.SME_PROJECT_ROOT;
    else process.env.SME_PROJECT_ROOT = previousProjectRoot;
    if (previousNoOpen === undefined) delete process.env.SME_NO_OPEN;
    else process.env.SME_NO_OPEN = previousNoOpen;
    if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
  }, 60_000);

  // ===========================================================================
  // ケース1: 通し合成（存在検査 → frame-exact → フェード → z 順 → 画像/図形/SE）
  // ===========================================================================

  it('出力の尺・撮影スパン・マニフェストが計画どおり（存在検査）', () => {
    expect(probeFrameCount(outPath)).toBe(TOTAL_FRAMES);
    const tt = manifests.get('telop-title');
    const img = manifests.get('image');
    expect(tt, 'telop+title 統合レイヤが撮影されていない').toBeDefined();
    expect(img, 'image レイヤが撮影されていない').toBeDefined();
    // run は撮影スパンを隙間なく覆う（スパン境界で必ず切れる）。
    for (const span of TELOP_TITLE_SPANS) {
      const inSpan = tt!.runs.filter((r) => r.startFrame >= span.start && r.endFrame <= span.end);
      expect(inSpan.length, `スパン [${span.start},${span.end}) の run`).toBeGreaterThan(0);
      expect(inSpan[0]!.startFrame).toBe(span.start);
      expect(inSpan[inSpan.length - 1]!.endFrame).toBe(span.end);
    }
    expect(img!.runs[0]!.startFrame).toBe(IMAGE.start);
    expect(img!.runs[img!.runs.length - 1]!.endFrame).toBe(IMAGE.end);
    expect(tt!.pngFiles).toHaveLength(tt!.runs.length);
    expect(img!.pngFiles).toHaveLength(img!.runs.length);
  });

  /**
   * ケース1(a) + ケース2（スパンオフセットの frame-exact）。
   *
   * 判定は**許容差を持ち込まない argmin**で行う: 出力フレーム f の画素を、そのスパンの
   * 全代表 PNG と突き合わせ、「最も説明できる PNG」が planCaptureRuns が f に割り当てた
   * run の PNG であることを要求する。1 フレームずれた割り当ては同じ計器で必ず負ける
   * （その差＝比較器が無感でないことの対照 = RED 相当）ので、閾値を新設しなくてよい。
   *
   * スパンは2本とも途中フレームから始まる（[10,70) と [90,150)）ので、`-start_number`／
   * setpts シフト経路のオフセット付き写像がここで実写検証される（T4 レビュー由来の必須受入）。
   */
  it('frame-exact: 各出力フレームを最も説明する撮影 PNG が、その run の PNG である（±1 の対照つき・両スパン）', () => {
    const tt = manifests.get('telop-title')!;
    const check = (span: { start: number; end: number }, window: number[], rect: typeof TELOP_RECT): void => {
      const cands = tt.runs.filter((r) => r.startFrame >= span.start && r.endFrame <= span.end);
      const frames = extractRegionFrames(outPath, window[0]!, window[window.length - 1]!, rect);
      for (const f of window) {
        const buf = frames[f - window[0]!]!;
        const scored = cands.map((r) => ({
          run: r,
          mean: compareRegion(buf, rect, decodeCached(tt.pngFiles[r.pngFileIndex]!)).meanAbs,
        }));
        const best = scored.reduce((a, b) => (b.mean < a.mean ? b : a));
        const expectedRun = cands.find((r) => r.startFrame <= f && f < r.endFrame)!;
        expect(
          best.run.startFrame,
          `f=${f}: 最も一致する PNG は run[${expectedRun.startFrame},${expectedRun.endFrame}) のはず（実測の一致度: ` +
            scored.map((x) => `${x.run.startFrame}=${x.mean.toFixed(3)}`).join(' ') + '）',
        ).toBe(expectedRun.startFrame);
        // ±1 ずれた割り当ては必ず負ける（比較器が無感でないことの対照）。
        for (const neighbour of [expectedRun.startFrame - 1, expectedRun.endFrame]) {
          const off = scored.find((x) => x.run.startFrame === neighbour);
          if (off === undefined) continue;
          expect(
            off.mean,
            `f=${f}: 1フレームずらした割り当て(run開始${neighbour})が正しい割り当てより良く見えてはならない`,
          ).toBeGreaterThan(best.mean);
        }
      }
    };
    // スパン2（telopB のフェードイン窓・毎フレーム別 run）。
    check(TELOP_TITLE_SPANS[1]!, [90, 91, 92, 93, 94, 95, 96, 97], TELOP_RECT);
    // スパン1（telopA のフェードイン窓）。画像レイヤが重なる行を避けて帯の下端だけを見る。
    check(TELOP_TITLE_SPANS[0]!, [10, 11, 12, 13, 14, 15, 16, 17], TELOP_LOWER_RECT);
  }, 120_000);

  it('スパン境界: 直前フレームはベース映像のみ・末尾フレームは可視・end フレームで消える', () => {
    const tt = manifests.get('telop-title')!;
    const frames = extractRegionFrames(outPath, TELOP_B.start - 2, TELOP_B.end + 1, TELOP_RECT);
    const at = (f: number): Buffer => frames[f - (TELOP_B.start - 2)]!;
    // 区間外（88,89 と 150,151）はベース色そのまま。許容 3 は nativeExportShape.e2e と同じ
    // 「平坦色の実測一致」判定（新設ではない）。
    for (const f of [TELOP_B.start - 2, TELOP_B.start - 1, TELOP_B.end, TELOP_B.end + 1]) {
      const st = compareRegion(at(f), TELOP_RECT, null);
      expect(st.maxAbs, `f=${f} は撮影オーバーレイの外＝ベース映像のみのはず`).toBeLessThanOrEqual(3);
    }
    // 末尾フレーム（149）は可視（撮影 PNG に不透明画素がある run が割り当たっている）。
    const lastPng = decodeCached(pngForFrame(tt, TELOP_B.end - 1)!);
    const lastStats = compareRegion(at(TELOP_B.end - 1), TELOP_RECT, lastPng);
    expect(lastStats.opaquePixels, 'f=149 の撮影 PNG に不透明画素が無い（消えている）').toBeGreaterThan(0);
    // その 149 フレーム目が「ベース映像のみ」と比べて確実に違う（可視であることの実写証明）。
    const asBase = compareRegion(at(TELOP_B.end - 1), TELOP_RECT, null);
    expect(asBase.maxAbs).toBeGreaterThan(50);
  }, 120_000);

  it('フェード窓のアルファが出力 mp4 の画素で単調に増える（M2b の流儀・帯の平均で測る）', () => {
    // fixture Telop の opacity = min(1,(frame-startFrame)/8)。telopB は [90,150) なので
    // 90..98 がフェード中（98 で完了）。テロップ色 #E5645C（R=229）はベース（R=0）より
    // 明るいので、帯の平均 R は α とともに単調に増える。
    const frames = extractRegionFrames(outPath, 90, 98, TELOP_RECT);
    const meanR = frames.map((buf) => {
      let sum = 0;
      for (let i = 0; i < buf.length; i += 3) sum += buf[i]!;
      return sum / (TELOP_RECT.w * TELOP_RECT.h);
    });
    for (let i = 1; i < meanR.length; i++) {
      expect(
        meanR[i]!,
        `f=${90 + i} の帯平均R(${meanR[i]!.toFixed(3)}) が f=${89 + i}(${meanR[i - 1]!.toFixed(3)}) 以下`,
      ).toBeGreaterThan(meanR[i - 1]!);
    }
  }, 120_000);

  /**
   * ケース1(c) z 順。telop+title は**1枚の統合レイヤ**として撮られるので、順序は撮影 PNG
   * そのものに焼き込まれている。そこで
   *   (1) 撮影 PNG の重なり点がタイトル由来の色であること（= 統合レイヤ内の z 順）
   *   (2) 出力 mp4 の同じ点がその PNG をベースへ合成した色であること（= 合成が壊していない）
   * の2段で見る。非退化（その点が本当にテロップのインクの上でもある）は、タイトルがまだ
   * 出ていないフレーム（f=95）で同じ点にテロップの画素があることで示す。
   */
  it('z 順: タイトルとテロップが重なる点でタイトルの画素が上に来る（撮影 PNG と mp4 の両方で）', () => {
    const tt = manifests.get('telop-title')!;
    const frame = 120; // title [100,140) の plateau・telopB [90,150) の全開区間
    const pngTitle = decodeCached(pngForFrame(tt, frame)!);
    const pngTelopOnly = decodeCached(pngForFrame(tt, 95)!); // タイトル未登場（[100,140) の外）

    // (非退化) タイトルが無いフレームでは、この点はテロップのインク（#E5645C 系）。
    const telopPx = rgbaAt(pngTelopOnly, OVERLAP.x, OVERLAP.y);
    expect(telopPx.a, 'z 順の観測点がテロップのインクの上にない（重なりが退化している）').toBeGreaterThan(0);
    expect(telopPx.b, `観測点のテロップ色 B=${telopPx.b} が青すぎる（テロップ #E5645C は B≈92）`).toBeLessThan(150);

    // (1) タイトルがある区間では同じ点が不透明なタイトル（金グラデ or 濃緑文字）になる。
    //     逆順（テロップが上）なら rgba(0,0,0,0.55) の帯 or #E5645C がグラデの上へ乗るので
    //     G は最大でも 0.45*171 ≒ 77 にしかならない。実測は G=171。
    //
    //     2026-09-06（B-1）: タイトル帯を紫グラデ(#B20AFD→#087FFF)から Title.tsx 実物と同色の
    //     金グラデ(#E8CE9A→#B8954C)へ直した。旧判定は B チャンネル（紫グラデ B≈253〜255）を
    //     見ていたが、金グラデは B が低く（実測 104）テロップのインク（B≈92）と差が薄く
    //     使えない。G チャンネルなら金グラデ（実測 G=171）とテロップのインク（G≈100）の差が
    //     大きく、判定に使える。
    const titlePx = rgbaAt(pngTitle, OVERLAP.x, OVERLAP.y);
    expect(titlePx.a).toBe(255);
    expect(
      titlePx.g,
      `重なり点の G=${titlePx.g}。テロップが上に来ていると G<=115 相当になる（金グラデ実測 G≈171・テロップ実測 G≈100）`,
    ).toBeGreaterThan(140);

    // (2) 出力 mp4 の同じ点が、その撮影 PNG をベースへ合成した色と一致する。
    const rect = { x: OVERLAP.x - 1, y: OVERLAP.y - 1, w: 4, h: 4 };
    const buf = extractRegionFrames(outPath, frame, frame, rect)[0]!;
    const actual = pixelOf(buf, rect, 1, 1);
    const expected = over(BG, titlePx);
    expectClose(actual.r, expected.r, 5, 'z順 観測点 R');
    expectClose(actual.g, expected.g, 5, 'z順 観測点 G');
    expectClose(actual.b, expected.b, 5, 'z順 観測点 B');
  }, 120_000);

  it('画像レイヤ: 出力の画像領域が撮影 PNG の合成と一致し、frame-exact に割り当たる', () => {
    const img = manifests.get('image')!;
    const cands = img.runs;
    const window = [20, 30, 40];
    const frames = extractRegionFrames(outPath, window[0]!, window[window.length - 1]!, IMAGE_RECT);
    for (const f of window) {
      const buf = frames[f - window[0]!]!;
      const scored = cands.map((r) => ({
        run: r,
        stats: compareRegion(buf, IMAGE_RECT, decodeCached(img.pngFiles[r.pngFileIndex]!)),
      }));
      const best = scored.reduce((a, b) => (b.stats.meanAbs < a.stats.meanAbs ? b : a));
      const expectedRun = cands.find((r) => r.startFrame <= f && f < r.endFrame)!;
      expect(best.run.startFrame, `画像 f=${f} の最良一致 run`).toBe(expectedRun.startFrame);
      // 空フレームを比べて通ったのではない（画像領域に不透明画素がある）。
      expect(best.stats.opaquePixels).toBeGreaterThan(0);
    }
  }, 120_000);

  it('図形レイヤ: 矩形の上辺が #FFCC00 で合成される（撮影オーバーレイと同居しても添字がずれない）', () => {
    // 図形は再生 [90,150)・D=60（fade 対経路）。f=120 は N=30 で α=1 全開。
    // 観測点は上辺の内側（実測: ストロークは y=59..68・y=62..63 は完全に内側）。
    const rect = { x: SHAPE_EDGE.x - 1, y: SHAPE_EDGE.y - 1, w: 4, h: 4 };
    const buf = extractRegionFrames(outPath, 120, 120, rect)[0]!;
    const px = pixelOf(buf, rect, 1, 1);
    // 許容 5 は nativeExportShape.e2e.test.ts の合成点判定と同じ（新設ではない）。
    expectClose(px.r, 255, 5, '図形上辺 R');
    expectClose(px.g, 204, 5, '図形上辺 G');
    expectClose(px.b, 0, 5, '図形上辺 B');
  }, 120_000);

  it('SE: 撮影オーバーレイを4入力積んでも音声添字が動かない（SE 窓の RMS が有意に大きい）', () => {
    const pcm = execFileSync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-i', outPath, '-map', 'a:0', '-f', 's16le', '-ac', '2', '-ar', '48000', '-'],
      { maxBuffer: 512 * 1024 * 1024 },
    );
    // SE は再生フレーム 90 = 3.0 秒から 0.5 秒。既存 SE e2e と同じ 1.15 倍基準。
    const seWindowRms = pcmWindowRms(pcm, 48000, 2, 3.0, 3.5);
    const silentWindowRms = pcmWindowRms(pcm, 48000, 2, 0.5, 1.0);
    expect(seWindowRms).toBeGreaterThan(silentWindowRms * 1.15);
  }, 120_000);

  // ===========================================================================
  // ケース3: 実 prepare の撮影失敗を成功として返さない
  // ===========================================================================

  it('撮影が失敗するプロジェクトでは prepare が ok:false と理由を返す', async () => {
    // 存在しない画像を参照させ、実 prepare が理由付きの失敗を返すことを確かめる。
    // 旧managerのRemotionへの退避経路は撤去済み。この撮影APIの拒否契約は維持する。
    const dir = join(tmpRoot, 'fail-project');
    cpSync(join(tmpRoot, 'overlay-project'), dir, { recursive: true });
    writeFileSync(
      join(dir, 'src', 'InsertImage', 'insertImageData.ts'),
      `import type { ImageSegment } from './types';\n\n` +
        `export const insertImageData: ImageSegment[] = [\n` +
        `  { id: 1, startFrame: 10, endFrame: 70, file: 'no-such-image.png', type: 'photo' },\n];\n`,
      'utf8',
    );
    const plan = planFastCut(
      dir,
      { resolution: 'full', quality: 'high' },
      join(dir, 'out', 'fail.mp4'),
      {
        hardware: false,
        capture: {
          projectId: 'fail-project',
          serverOrigin: () => baseUrl,
          captureSpecifiedRuns: async (req) => captureSpecifiedRuns(req, sharedCaptureDeps),
        },
      },
    );
    expect(plan).not.toBeNull();
    const outcome = await plan!.prepareCapture!(() => {});
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toContain('撮影');
    expect(outcome.reason).toContain('asset-decode-failed');
    outcome.cleanup?.();
  }, 180_000);
});
