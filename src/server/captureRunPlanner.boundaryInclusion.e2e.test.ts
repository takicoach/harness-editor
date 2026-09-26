/**
 * M2c T2・T1 レビュー由来の必須受入①（実 Chromium + 実エディタサーバ）。
 *
 * 「片側保証の検査は run 個数比較ではなく境界集合の包含で行う」: M2b と同じ実撮影
 * （captureDriver.captureOverlaySequence・実 Chromium・ピクセル比較で run を確定する）の
 * manifest.runs から**境界フレーム集合**（各 run の startFrame の集合）を取り出し、
 * 同一データ・同一窓で planCaptureRuns が出したシグネチャ run の境界フレーム集合に
 * **含まれる**ことを確認する（実撮影 run 境界の集合 ⊆ シグネチャ run 境界の集合）。
 *
 * これは転記した定数同士の比較ではない——本ファイル自身が captureOverlaySequence を
 * 呼んで実 Chromium で再観測する（signatureRunSpike.test.tsx の measuredPixelRuns は
 * M2b 実行時に手で転記した定数だったため、そこでは代用できない）。
 *
 * telop（GoldArch・動的）と image（Ken Burns・動的）の両方を検査する
 * （必須受入②: telop のみだったカバレッジの穴を埋める）。
 *
 * GoldArch/Ken Burns は毎フレーム distinct（run 数=フレーム数）で境界包含が自明成立して
 * しまうため、圧縮が効くケース（WhiteBlue・静的+登場フェード窓）も追加し、
 * 「シグネチャ run 数 < フレーム数 かつ 実撮影 run 数 > 1」の非退化条件を機械的に確認した
 * 上で境界包含を検証する（T2 レビュー指摘・粗すぎる分類の取りこぼしを検出できる形にする）。
 *
 * サーバ起動・fixture 複製・共有 browser の流儀は captureSmoke.e2e.test.ts と同じ。
 */
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureFrameProvider } from '../captureRuntime';
import { renderCaptureLayer, type LoadedComponents } from '../capturePage/layers';
import type { CaptureSpec } from '../capturePage/protocol';
import { captureOverlaySequence, captureSpecifiedRuns, type CaptureDeps, type CapturePage } from './captureDriver';
import { installTelopPack } from './installTelopPack';
import { loadOverlayComponentsForPlanner } from './loadOverlayComponents';
import { decodePngRgba } from './pngRgba';
import { resolveChromiumBin } from './resolveChromium';
import { normalizeRgba } from './runCompress';

const { planCaptureRuns } = await import('./captureRunPlanner');
const { Telop } = (await import('./telopPack/Telop')) as {
  Telop: React.ComponentType<{ segment: unknown }>;
};
const fixtureImage = await loadOverlayComponentsForPlanner(
  resolve(import.meta.dirname, '__fixtures__', 'sample-project'),
  { telop: false, image: true },
);
if (!fixtureImage.ok) throw new Error(fixtureImage.message);
const { InsertImage } = fixtureImage.components;

/**
 * signatureAt（captureRunPlanner.ts）と同じ経路だが **quantizePxLiterals を通さない**版。
 * I-1(a) の非退化 assert（量子化ありの run 数 < 量子化なしの distinct 数）専用——
 * 量子化そのものが実際に発火したことを、量子化を経ない生シグネチャとの対比で証明する。
 */
function rawSignatureAt(spec: CaptureSpec, frame: number, loaded: LoadedComponents): string {
  return renderToStaticMarkup(
    React.createElement(
      CaptureFrameProvider,
      { frame, videoConfig: spec.videoConfig },
      renderCaptureLayer(spec, loaded),
    ),
  );
}

/**
 * chromium が使えない環境ではファイルごと skip する（captureSmoke.e2e.test.ts と同じ規律）。
 * M2d T1: 判定の正本を resolveChromiumBin に一本化（captureDriver の実起動経路と同じ関数）。
 */
const chromiumResolved = resolveChromiumBin();
const chromiumUsable = chromiumResolved.ok;

if (!chromiumUsable && process.env['HARNESS_REQUIRE_CAPTURE_E2E'] === '1') {
  throw new Error(
    `HARNESS_REQUIRE_CAPTURE_E2E=1 ですが chromium が使えません（kind: ${chromiumResolved.ok ? '' : chromiumResolved.kind}）。`,
  );
}

const WIDTH = 360;
const HEIGHT = 640;
const FPS = 60;
const DURATION_IN_FRAMES = 4000;
const FRAME_COUNT = 40;

describe.skipIf(!chromiumUsable)('captureRunPlanner — 境界集合の包含（実撮影 ⊆ シグネチャ・実 Chromium）', () => {
  let tmpRoot: string;
  let previousProjectRoot: string | undefined;
  let previousNoOpen: string | undefined;
  let server: { close(): Promise<void> };
  let browser: { newPage(opts: unknown): Promise<unknown>; close(): Promise<void> };
  let baseUrl: string;
  let sharedDeps: CaptureDeps;
  let outSeq = 0;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'harness-planner-boundary-e2e-'));
    const fixture = resolve(import.meta.dirname, '__fixtures__', 'sample-project');
    cpSync(fixture, join(tmpRoot, 'sample-project'), { recursive: true });
    cpSync(fixture, join(tmpRoot, 'pack-project'), { recursive: true });
    installTelopPack(join(tmpRoot, 'pack-project'));
    cpSync(
      resolve(import.meta.dirname, '..', '..', 'docs', 'images', 'mcp-ai-tab.png'),
      join(tmpRoot, 'sample-project', 'public', 'images', 'sample.png'),
    );

    previousProjectRoot = process.env.SME_PROJECT_ROOT;
    previousNoOpen = process.env.SME_NO_OPEN;
    process.env.SME_PROJECT_ROOT = tmpRoot;
    process.env.SME_NO_OPEN = '1';

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
    sharedDeps = {
      launchChromium: async (opts) => {
        const page = (await browser.newPage({
          viewport: opts.viewport,
          deviceScaleFactor: opts.deviceScaleFactor,
        })) as unknown as CapturePage & { close(): Promise<void> };
        return { page, close: () => page.close() };
      },
    };
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (previousProjectRoot === undefined) delete process.env.SME_PROJECT_ROOT;
    else process.env.SME_PROJECT_ROOT = previousProjectRoot;
    if (previousNoOpen === undefined) delete process.env.SME_NO_OPEN;
    else process.env.SME_NO_OPEN = previousNoOpen;
    rmSync(tmpRoot, { recursive: true, force: true });
  }, 60_000);

  function nextOutDir(): string {
    outSeq += 1;
    return join(tmpRoot, `out-${outSeq}`);
  }

  /** manifest.runs の startFrame 集合（= 実撮影の run 境界フレーム集合）。 */
  function realBoundarySet(runs: { startFrame: number }[]): Set<number> {
    return new Set(runs.map((r) => r.startFrame));
  }

  /** planCaptureRuns の runs の startFrame 集合（= シグネチャ run 境界フレーム集合）。 */
  function signatureBoundarySet(runs: { startFrame: number }[]): Set<number> {
    return new Set(runs.map((r) => r.startFrame));
  }

  function assertSubset(real: Set<number>, signature: Set<number>, label: string): void {
    const missing = [...real].filter((f) => !signature.has(f));
    expect(missing, `${label}: 実撮影の run 境界 ${JSON.stringify(missing)} がシグネチャ境界に無い（撮影漏れの疑い）`).toEqual(
      [],
    );
  }

  it(
    'telop（GoldArch・動的）: 実撮影 run 境界 ⊆ シグネチャ run 境界',
    async () => {
      const telops = [
        { id: 1, startFrame: -600, endFrame: 4000, text: 'ゴールドアーチ', style: 'emphasis', template: 35 },
      ];
      const outDir = nextOutDir();
      const captureResult = await captureOverlaySequence(
        {
          serverUrl: baseUrl,
          layer: 'telop',
          projectId: 'pack-project',
          data: { telops },
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationInFrames: DURATION_IN_FRAMES,
          frames: { start: 0, end: FRAME_COUNT - 1 },
          outDir,
        },
        sharedDeps,
      );
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;

      const plan = planCaptureRuns({
        layer: 'telop',
        data: { telops },
        videoConfig: { width: WIDTH, height: HEIGHT, fps: FPS, durationInFrames: DURATION_IN_FRAMES },
        spans: [{ start: 0, end: FRAME_COUNT }],
        loaded: { Telop, InsertImage: null },
      });

      assertSubset(
        realBoundarySet(captureResult.manifest.runs),
        signatureBoundarySet(plan.runs),
        'telop GoldArch',
      );
      // 片側保証の向き自体も再確認（実撮影 run 数を signature が下回らない）。
      expect(plan.runs.length).toBeGreaterThanOrEqual(captureResult.manifest.runs.length);
    },
    60_000,
  );

  it(
    'image（Ken Burns・zoomIn）: 実撮影 run 境界 ⊆ シグネチャ run 境界（必須受入②）',
    async () => {
      const images = [
        {
          id: 1,
          startFrame: 0,
          endFrame: FRAME_COUNT,
          file: 'sample.png',
          type: 'photo',
          motion: { preset: 'zoomIn', intensity: 0.6 },
        },
      ];
      const outDir = nextOutDir();
      const captureResult = await captureOverlaySequence(
        {
          serverUrl: baseUrl,
          layer: 'image',
          projectId: 'sample-project',
          data: { images },
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationInFrames: DURATION_IN_FRAMES,
          frames: { start: 0, end: FRAME_COUNT - 1 },
          outDir,
        },
        sharedDeps,
      );
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;

      // 分類器（Node 側）は staticFile リゾルバを設定していないため、imageUrl を直接渡して
      // staticFile() 経由の解決を避ける（src の実体は分類に無関係——リゾルバの有無で
      // signature の可否を左右しないための回避）。src は全フレーム一定なので境界には無関係。
      const plan = planCaptureRuns({
        layer: 'image',
        data: { images: images.map((i) => ({ ...i, imageUrl: 'data:planner-boundary-check' })) },
        videoConfig: { width: WIDTH, height: HEIGHT, fps: FPS, durationInFrames: DURATION_IN_FRAMES },
        spans: [{ start: 0, end: FRAME_COUNT }],
        loaded: { Telop: null, InsertImage },
      });

      assertSubset(
        realBoundarySet(captureResult.manifest.runs),
        signatureBoundarySet(plan.runs),
        'image Ken Burns',
      );
      expect(plan.runs.length).toBeGreaterThanOrEqual(captureResult.manifest.runs.length);
    },
    60_000,
  );

  it(
    'telop（WhiteBlue・静的+登場フェード窓）: 圧縮が効くケースでも境界包含が成立する（レビュー推奨②）',
    async () => {
      // GoldArch/Ken Burns は毎フレーム distinct（run 数=フレーム数）なので、境界包含が
      // 自明に成立してしまい「分類が粗すぎて run を取りこぼす」regression を検出できない
      // （レビュー指摘）。WhiteBlue（template19）は登場フェード（3fr・WhiteBlue.tsx の
      // fadeInDuration=min(3,floor(duration/3))）の後は定常状態が続くため、窓の先頭で
      // 実撮影 run が複数本（登場フェード3fr＋定常1本）に圧縮される——
      // 「シグネチャ run 数 < フレーム数 かつ 実撮影 run 数 > 1」の非退化条件を満たす。
      const telops = [
        { id: 1, startFrame: 0, endFrame: 4000, text: 'ホワイトブルー静的', style: 'emphasis', template: 19 },
      ];
      const outDir = nextOutDir();
      const captureResult = await captureOverlaySequence(
        {
          serverUrl: baseUrl,
          layer: 'telop',
          projectId: 'pack-project',
          data: { telops },
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationInFrames: DURATION_IN_FRAMES,
          frames: { start: 0, end: FRAME_COUNT - 1 },
          outDir,
        },
        sharedDeps,
      );
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;

      const plan = planCaptureRuns({
        layer: 'telop',
        data: { telops },
        videoConfig: { width: WIDTH, height: HEIGHT, fps: FPS, durationInFrames: DURATION_IN_FRAMES },
        spans: [{ start: 0, end: FRAME_COUNT }],
        loaded: { Telop, InsertImage: null },
      });

      // 非退化条件そのものを機械的に検証する（この主張が成り立たなければ他アサーションの
      // 「境界包含」は粗すぎる分類でも自明成立してしまい証拠能力が無い）。
      expect(
        captureResult.manifest.runs.length,
        '実撮影 run 数が1本しかない（圧縮が効かないケースのままで非退化条件を満たしていない）',
      ).toBeGreaterThan(1);
      expect(
        plan.runs.length,
        'シグネチャ run 数がフレーム数と同じ（圧縮が効いていない）',
      ).toBeLessThan(FRAME_COUNT);

      assertSubset(
        realBoundarySet(captureResult.manifest.runs),
        signatureBoundarySet(plan.runs),
        'telop WhiteBlue',
      );
      expect(plan.runs.length).toBeGreaterThanOrEqual(captureResult.manifest.runs.length);
    },
    60_000,
  );

  it(
    'telop-title（統合レイヤ・WhiteBlue静的+登場フェード窓のtelop + title）: 実撮影 run 境界 ⊆ シグネチャ run 境界（T2 レビュー必須受入②）',
    async () => {
      // title の spring 収束は浮動小数の減衰（bit-exact 収束）に時間が掛かる（実測: fps=60・
      // damping20/stiffness100/mass0.5 で frame≈168 以降は完全に定常値へ収束する）。
      // 窓を frame 0 から取ると title の収束尾部だけで毎フレーム distinct になり、
      // 「圧縮が効くケース」の非退化条件（実撮影 run>1 かつ シグネチャ run<フレーム数）を
      // 検証できない。1本目の title は startFrame:0 のまま（窓に到達する頃には既に収束済み）
      // にし、telop（WhiteBlue・静的+登場フェード窓）の startFrame を窓の先頭に合わせることで、
      // 「1本目の title は定常・telop だけが窓内でフェードする」構成にする。
      // T3 追補（レビュー Minor②）: それだけだと窓内の境界が telop 由来のものしか無く、
      // 「title 自体が境界を作る」ことを検証できていない。2本目の title を窓の途中（+20）で
      // 開始させ、その登場（Sequence from=WINDOW_START+20 の DOM 出現）自体が signature
      // 境界を作ることを、下の明示アサーションで pin する。
      const WINDOW_START = 500;
      const SECOND_TITLE_START = WINDOW_START + 20;
      const telops = [
        {
          id: 1,
          startFrame: WINDOW_START,
          endFrame: 4000,
          text: 'ホワイトブルー統合',
          style: 'emphasis',
          template: 19,
        },
      ];
      const titles = [
        { id: 2, startFrame: 0, endFrame: 4000, text: 'たいとる統合' },
        { id: 3, startFrame: SECOND_TITLE_START, endFrame: 4000, text: 'たいとる2本目' },
      ];
      const outDir = nextOutDir();
      const captureResult = await captureOverlaySequence(
        {
          serverUrl: baseUrl,
          layer: 'telop-title',
          projectId: 'pack-project',
          data: { telops, titles },
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationInFrames: DURATION_IN_FRAMES,
          frames: { start: WINDOW_START, end: WINDOW_START + FRAME_COUNT - 1 },
          outDir,
        },
        sharedDeps,
      );
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;

      const plan = planCaptureRuns({
        layer: 'telop-title',
        data: { telops, titles },
        videoConfig: { width: WIDTH, height: HEIGHT, fps: FPS, durationInFrames: DURATION_IN_FRAMES },
        spans: [{ start: WINDOW_START, end: WINDOW_START + FRAME_COUNT }],
        loaded: { Telop, InsertImage: null },
      });

      expect(
        captureResult.manifest.runs.length,
        '実撮影 run 数が1本しかない（圧縮が効かないケースのままで非退化条件を満たしていない）',
      ).toBeGreaterThan(1);
      expect(
        plan.runs.length,
        'シグネチャ run 数がフレーム数と同じ（圧縮が効いていない）',
      ).toBeLessThan(FRAME_COUNT);

      assertSubset(
        realBoundarySet(captureResult.manifest.runs),
        signatureBoundarySet(plan.runs),
        'telop-title WhiteBlue+title',
      );
      expect(plan.runs.length).toBeGreaterThanOrEqual(captureResult.manifest.runs.length);

      // レビュー Minor②: telop 由来の境界だけで検証が成立してしまっていないことの証拠。
      // 2本目の title の**登場フレーム自体**（opacity=0 の瞬間でも DOM は変わる）が
      // シグネチャ run 境界になっていることを明示 pin する。実撮影（画素比較）は
      // opacity=0 の1フレーム目は前フレームと画素同一（見えない）ため境界にならず、
      // 実際に画素が変わるのは登場フレームの**次**（interpolate が opacity>0 を返す最初の
      // フレーム）——これは「シグネチャ run はより細かくなることはあっても粗くならない」
      // （片側保証）の実例そのものであり、既に subset 検査で保証されている。
      expect(
        plan.runs.map((r) => r.startFrame),
        'シグネチャ側に 2本目 title の登場フレームが境界として現れていない',
      ).toContain(SECOND_TITLE_START);
      expect(
        captureResult.manifest.runs.map((r) => r.startFrame),
        '実撮影側にも 2本目 title の登場直後（画素が変わる最初のフレーム）が境界として現れていない（title 追加が画素に効いていない）',
      ).toContain(SECOND_TITLE_START + 1);
    },
    60_000,
  );

  it(
    'title（spring→interpolate の px 収束尾）: 量子化が実際に発火し、' +
      '併合された run の両端は実撮影で画素同一（I-1 必須受入）',
    async () => {
      // ブリーフ原文は「WhiteRed（template 17）」を挙げるが、実装調査の結果 WhiteRed は
      // charByChar 入場も含め transform に一切 px 単位の値を持たない（SVG transform 属性は
      // 単位無しのユーザー座標・scale/opacity も単位無し）。quantizePxLiterals は文字列中の
      // 「px が付いた数値」だけを対象にするため、WhiteRed では量子化が構造的に一度も発火しない
      // ——I-1(a) の検査対象として空虚になる。代わりに、同じ「spring→interpolate の px 収束尾」
      // 現象を**実際に px 単位で持つ** title レイヤ（capturePage/layers.tsx の
      // CaptureTitleClip・`transform:translateX(${translateX}px)`・
      // spring({damping:20,stiffness:100,mass:0.5})）を使う（このファイルの他ケースで既に
      // title の同スプリングを収束済み区間で使っている実績がある）。
      //
      // WINDOW_START/FRAME_COUNT(=40) はスクリプトで事前に数値探索した窓
      // （src/captureRuntime/spring.ts の spring() を frame=61..100 で直接評価）:
      // translateX は frame 61 で -0.000438px、frame 100 で -7.1e-8px まで単調減衰し、
      // どのフレームも直前フレームと bit-exact には一致しない（frame 169 で初めて完全停止する
      // ことを確認済み）。かつ全フレームで |translateX| < 0.0004px ≪ PX_QUANTUM/2
      // (0.001953125px) なので、量子化後は全フレームが同一シグネチャへ潰れるはず
      // ——「量子化なしなら distinct、量子化ありなら1本」を保証する窓として選定した。
      const WINDOW_START = 61;
      const titles = [{ id: 1, startFrame: 0, endFrame: 4000, text: 'たいとる収束尾' }];
      const spec: CaptureSpec = {
        layer: 'title',
        projectId: 'capture-run-planner-boundary-raw',
        videoConfig: { width: WIDTH, height: HEIGHT, fps: FPS, durationInFrames: DURATION_IN_FRAMES },
        data: { titles },
      };
      const loaded: LoadedComponents = { Telop: null, InsertImage: null };

      // (a) 非退化 assert: 量子化なしの生シグネチャの distinct 数 > 量子化ありの run 数。
      // これが成り立たなければ、この fixture では量子化そのものが一度も発火していない
      // （＝この it が量子化の検査として空虚）ことになる。
      const rawSignatures = new Set<string>();
      for (let frame = WINDOW_START; frame < WINDOW_START + FRAME_COUNT; frame++) {
        rawSignatures.add(rawSignatureAt(spec, frame, loaded));
      }

      const plan = planCaptureRuns({
        layer: 'title',
        data: { titles },
        videoConfig: spec.videoConfig,
        spans: [{ start: WINDOW_START, end: WINDOW_START + FRAME_COUNT }],
        loaded,
      });

      expect(
        rawSignatures.size,
        '量子化なしの生シグネチャが全フレーム同一（＝この fixture では spring 収束尾が px 文字列に' +
          '現れていない・量子化発火の証拠にならない）',
      ).toBeGreaterThan(1);
      expect(
        plan.runs.length,
        `量子化ありの run 数(${plan.runs.length})が量子化なしの distinct 数(${rawSignatures.size})を` +
          '下回っていない＝この fixture では量子化が run 分割を一切減らしていない（発火していない）',
      ).toBeLessThan(rawSignatures.size);

      // (b) 境界包含（他ケースと同じ片側保証の検査）。
      const outDir = nextOutDir();
      const captureResult = await captureOverlaySequence(
        {
          serverUrl: baseUrl,
          layer: 'title',
          projectId: 'pack-project',
          data: { titles },
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationInFrames: DURATION_IN_FRAMES,
          frames: { start: WINDOW_START, end: WINDOW_START + FRAME_COUNT - 1 },
          outDir,
        },
        sharedDeps,
      );
      expect(captureResult.ok).toBe(true);
      if (!captureResult.ok) return;

      assertSubset(
        realBoundarySet(captureResult.manifest.runs),
        signatureBoundarySet(plan.runs),
        'title spring 収束尾',
      );
      expect(plan.runs.length).toBeGreaterThanOrEqual(captureResult.manifest.runs.length);

      // (c) 併合された run の恒久化: 実撮影 run のうち startFrame/endFrame が2フレーム以上に
      // またがる（＝量子化により複数フレームが1本へ併合された）ものを取り、その代表フレームと
      // 末尾フレーム（endFrame-1）を**単独で再撮影**し、decode した画素が完全同一であることを
      // 独立に検算する（run 数だけだとドライバ内部の隣接比較を信じることになるため・T6 追調査の恒久化）。
      const mergedRun = captureResult.manifest.runs.find((r) => r.endFrame - r.startFrame > 1);
      expect(
        mergedRun,
        `実撮影側に2フレーム以上の併合 run が1本も無い（この窓では画素同一の併合が起きていない・` +
          `runs=${JSON.stringify(captureResult.manifest.runs)}）`,
      ).toBeDefined();
      if (!mergedRun) return;

      const repFrame = mergedRun.startFrame;
      const tailFrame = mergedRun.endFrame - 1;
      expect(tailFrame).toBeGreaterThan(repFrame);

      // captureOverlaySequence を2回（＝2つの Chromium ページ）で撮り直すと、同一フレームでも
      // 新規ページのフォントヒンティング初期化差で数バイトの反アンチエイリアス差が出うる
      // （実測で確認済み・ページをまたぐ差でありフレーム自体の差ではない）。
      // captureSpecifiedRuns なら**同一ページ・同一セッション**で2フレームを順に撮れるため、
      // その混入を避けつつ「driver 内部の隣接比較を信じない独立再検算」を保つ
      // （比較コード自体は決定的比較を行わず代表フレームをそのまま書き出す関数なので、
      // ここでの画素比較は本テストの decodePngRgba/normalizeRgba で独立に行う）。
      const mergedOutDir = nextOutDir();
      const mergedCapture = await captureSpecifiedRuns(
        {
          serverUrl: baseUrl,
          layer: 'title',
          projectId: 'pack-project',
          data: { titles },
          width: WIDTH,
          height: HEIGHT,
          fps: FPS,
          durationInFrames: DURATION_IN_FRAMES,
          runs: [
            { representativeFrame: repFrame, startFrame: repFrame, endFrame: repFrame + 1 },
            { representativeFrame: tailFrame, startFrame: tailFrame, endFrame: tailFrame + 1 },
          ],
          outDir: mergedOutDir,
        },
        sharedDeps,
      );
      expect(mergedCapture.ok).toBe(true);
      if (!mergedCapture.ok) return;
      expect(mergedCapture.manifest.pngFiles).toHaveLength(2);

      const repPixels = normalizeRgba(
        decodePngRgba(readFileSync(mergedCapture.manifest.pngFiles[0] as string)),
      );
      const tailPixels = normalizeRgba(
        decodePngRgba(readFileSync(mergedCapture.manifest.pngFiles[1] as string)),
      );
      expect(tailPixels.length).toBe(repPixels.length);
      let differing = 0;
      for (let i = 0; i < repPixels.length; i++) if (repPixels[i] !== tailPixels[i]) differing += 1;
      expect(
        differing,
        `併合 run [${repFrame},${mergedRun.endFrame}) の代表フレーム(${repFrame})と末尾フレーム` +
          `(${tailFrame})の画素が ${differing} 箇所異なる（併合が過剰＝絵の欠落）`,
      ).toBe(0);
    },
    120_000,
  );
});
