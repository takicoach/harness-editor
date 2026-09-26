/**
 * Playwright 撮影ドライバ。
 *
 * 流れ: chromium 起動 → `/capture` を開く → `window.__capture.init(spec)`（T2 プロトコル）→
 * フレームループ（`setFrame(n)` → `page.screenshot({omitBackground:true})` → decodePngRgba →
 * normalizeRgba）→ 隣接フレーム比較で run を確定 → 代表フレームの PNG を outDir に連番書き出し
 * + manifest 返却。
 *
 * 実体解決は resolveChromium.ts の `resolveChromiumBin`（resolveFfmpeg と同型・M2d T1）に
 * 一本化されている: 開発機では playwright-core の既定キャッシュ、配布先では
 * `tools/chrome-headless-shell/` 配下の版固定実体（setup が取得）を同じ関数で見つける。
 * 撮影エンジンは runtime dependency の `playwright-core` を使い（@playwright/test は UI e2e
 * 用の devDependency のまま）、起動は常に `executablePath` 明示（環境変数
 * `PLAYWRIGHT_BROWSERS_PATH` 依存にしない）。#193: 起動パスで playwright-core を static
 * import しない — captureDriver は将来的に書き出し経路から呼ばれうるため、playwright-core が
 * 不在の環境でも import 自体は失敗しないようにし、実際の起動失敗のみ 'launch-failed' に落とす。
 * resolveChromiumBin が fail した場合は起動を試みず 'chromium-missing' として区別する
 * （「実体が無い」と「起動を試みたが失敗した」は別の事前分岐対象のため）。
 *
 * clip 省略について: `page.screenshot` に `clip` は渡さない。viewport を出力解像度
 * （width/height）ちょうどに設定しているため、clip 省略時の「ビューポート全体」撮影は
 * フルフレーム撮影と実効同値（設計判断4のフルフレーム要件を満たす）。
 *
 * メモリ設計（#182・レビュー指摘対応で導入）: 全フレームの PNG/正規化バッファを配列に
 * 溜め込まない。保持するのは「直前フレームの正規化 RGBA（比較用）」と「現在の run の代表
 * フレームの元 PNG（書き出し用）」の2つだけ。フレームが直前と同一なら代表 PNG も正規化
 * バッファも即座に破棄でき、run が切り替わった時点で直前 run の代表 PNG を即書き出して手放す。
 * これにより 1080x1920×数百フレームでも保持量はフレーム1枚分程度に収まる（旧実装は
 * normalizeRgba 済みバッファを全フレーム保持しており、300フレームで数GB規模になり得た）。
 *
 * T2 実シグネチャとの整合（設計判断・ブリーフからの調整）:
 * - `window.__capture` は `init`/`setFrame` のみを公開する（`prepare` は init 内部で自動的に
 *   走る隠れステップであり、ドライバから個別に呼ぶ API ではない）。ブリーフの
 *   「__capture.prepare/init」は T2 の実配線に合わせて init 単体呼び出しに修正した。
 * - 失敗種別は T2 の `CaptureErrorKind`（protocol.ts）をそのまま re-export して使う。
 *   ブリーフ案にあった 'init-failed' は T2 に存在せず、init/setFrame の evaluate() 自体が
 *   例外を投げた場合（プロトコルの通常の失敗経路ではなく、トランスポート層の異常）は
 *   'render-error' に分類する。書き出し（mkdir/writeFile）の失敗は 'write-failed' に分類する。
 *
 * durationInFrames について（レビュー指摘対応）: `CaptureRequest.durationInFrames` は
 * **合成全体の尺**であり、撮影する部分範囲（frames.start/end）から推定しない。
 * captureRuntime の Sequence 実装（src/captureRuntime/components.tsx）は
 * `useVideoConfig().durationInFrames` をフェード等の尺計算に伝播させるため、部分範囲撮影で
 * `frames.end + 1` のような推定値を渡すと、フェードの分母が変わって別の絵になってしまう。
 */
import { join } from 'node:path';
import { decodePngRgba } from './pngRgba';
import { resolveChromiumBin } from './resolveChromium';
import type { ResolveChromiumResult } from './resolveChromium';
import { normalizeRgba } from './runCompress';
import type { CaptureErrorKind, CaptureLayerKind, CaptureSpec } from '../capturePage/protocol';

export type { CaptureLayerKind } from '../capturePage/protocol';

/** 撮影要求。layer/projectId/data は T2 の CaptureSpec を組み立てるための最小集合。 */
export interface CaptureRequest {
  serverUrl: string;
  layer: CaptureLayerKind;
  projectId: string;
  /** レイヤ種別ごとの描画データ。正本は layers.tsx の TelopLayerData/TitleLayerData/ImageLayerData。 */
  data: unknown;
  width: number;
  height: number;
  fps: number;
  /**
   * 合成全体の尺（フレーム数）。videoConfig.durationInFrames にそのまま渡す。
   * frames.end から推定しない（部分範囲撮影でもフェード等の尺は合成全長基準のため）。
   */
  durationInFrames: number;
  /** 撮影するフレーム範囲（両端 inclusive）。 */
  frames: { start: number; end: number };
  /**
   * 代表 PNG の書き出し先。
   * M-3（寿命の所在）: 作成（mkdir・recursive）は本ドライバが行う（flushRun 初回のみ・
   * 1件も run が確定しなければ作成されない）。削除は本ドライバの責務**外**——
   * 失敗時のベストエフォート後始末（cleanupWritten）は書き出し済み PNG ファイルの unlink
   * のみで、outDir 自体の rmdir はしない。outDir の一時ディレクトリとしての寿命管理
   * （最終的な削除）は呼び出し側の責務であり、captureDriver.ts 単体では完結しない
   * （M2c: 合成配線側で outDir を一時ディレクトリとして作り、使い終わったら消す）。
   */
  outDir: string;
}

export interface CaptureManifestRun {
  /**
   * manifest.pngFiles 内のインデックス（このマニフェストで書き出した代表 PNG を指す）。
   * I-1: 撮影フレームの index（startFrame/endFrame と同じ絶対フレーム番号系）と紛らわしい
   * ため pngIndex から改名した — こちらは「pngFiles 配列の何番目か」という別の軸。
   */
  pngFileIndex: number;
  /** run の開始フレーム番号（inclusive・req.frames と同じ絶対フレーム番号）。 */
  startFrame: number;
  /** run の終了フレーム番号（exclusive）。 */
  endFrame: number;
}

/**
 * ドライバ自身が付け足す失敗種別（起動・スクリーンショット・decode・書き出し）+ T2 プロトコルの
 * 失敗種別をそのまま。M-1: 'decode-failed' は screenshot 自体の失敗（Chromium 側）と、
 * その PNG を自前デコーダで decode/正規化する段の失敗（decodePngRgba/normalizeRgba の throw）
 * を区別するために screenshot-failed から分離した。
 */
export type CaptureFailureKind =
  | CaptureErrorKind
  | 'launch-failed'
  | 'screenshot-failed'
  | 'decode-failed'
  | 'write-failed'
  /** resolveChromiumBin が実体を見つけられなかった（起動自体を試みていない・M2d T1）。 */
  | 'chromium-missing';

export type CaptureResult =
  | { ok: true; manifest: { runs: CaptureManifestRun[]; pngFiles: string[] } }
  | { ok: false; kind: CaptureFailureKind; message: string; frame?: number };

/** ドライバから見た Playwright page の面（差し替え可能）。 */
export interface CapturePage {
  goto(url: string): Promise<void>;
  evaluate<T>(fn: (arg: unknown) => T | Promise<T>, arg: unknown): Promise<T>;
  screenshot(opts: { omitBackground: boolean }): Promise<Buffer>;
}

/** 1フレーム分の内訳分解（M2b T5・分離計測用の観測フック）。任意購読で製品動作は変えない。 */
export interface CaptureFrameTiming {
  frame: number;
  /** setFrame(n) の evaluate 呼び出し（React commit ACK + rAF×2 待ちを含む）。 */
  setFrameMs: number;
  /** page.screenshot({omitBackground:true}) 呼び出し（Chromium 側の PNG 符号化を含む）。 */
  screenshotMs: number;
  /** decodePngRgba + normalizeRgba + 直前フレームとの逐次比較。 */
  decodeNormalizeCompareMs: number;
}

export interface CaptureDeps {
  /**
   * chromium 起動 + newPage までを済ませた page を返す。
   * M-1: 既定は **playwright-core** の chromium（遅延 import・実体は resolveChromiumBin が解決）。
   * @playwright/test は UI e2e 用の devDependency であり、撮影の起動経路では使わない。
   */
  launchChromium?(opts: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<{ page: CapturePage; close(): Promise<void> }>;
  mkdir?(dir: string): Promise<void>;
  writeFile?(path: string, data: Buffer): Promise<void>;
  /** 書き出し失敗時、既に書いた分の後始末に使う（ベストエフォート・失敗は握りつぶす）。 */
  unlink?(path: string): Promise<void>;
  /**
   * フレームごとの内訳分解を報告する観測フック（T5 分離計測専用）。
   * 未指定時は分岐が false 側に倒れタイマー呼び出し自体を行わない（コスト増ゼロ）。
   * 指定時は performance.now() を1フレームあたり最大3回追加で呼ぶ（無視できるオーバーヘッド）。
   * 製品の撮影結果（manifest/PNG）には一切影響しない。
   */
  onFrameTiming?(timing: CaptureFrameTiming): void;
  /**
   * run 撮影の途中経過報告（M2d T3・撮影枚数進捗）。1 run（PNG 書き出し）が成功する
   * たびに (captured, total) を呼ぶ（captureSpecifiedRuns のみ・onFrameTiming と同型で
   * 未指定なら呼び出し自体を行わない＝コストゼロ）。書き出し失敗後の run では呼ばれない。
   */
  onProgress?(captured: number, total: number): void;
  /**
   * 撮影エンジン実体の解決関数（M-3/M-5・既定は resolveChromiumBin）。
   * chromium-missing 分岐を `process.env` を壊さずに pin するための注入口。
   * `launchChromium` を注入した場合は使われない（そちらが起動一式を差し替えるため）。
   */
  resolveChromium?(): ResolveChromiumResult;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(n: number): string {
  return String(n).padStart(6, '0');
}

/**
 * resolveChromiumBin が実体を見つけられなかったことを示すマーカー。
 * launchChromium の catch で 'launch-failed'（起動を試みて失敗）と区別するために使う。
 */
class ChromiumMissingError extends Error {}

async function defaultLaunchChromium(
  opts: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  },
  resolveChromium: () => ResolveChromiumResult = resolveChromiumBin,
): Promise<{ page: CapturePage; close(): Promise<void> }> {
  const resolved = resolveChromium();
  if (!resolved.ok) {
    throw new ChromiumMissingError(resolved.message);
  }
  // #193: static import しない。playwright-core 不在の環境でも本モジュール自体は import 可能に保つ。
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: resolved.bin });
  const page = await browser.newPage({ viewport: opts.viewport, deviceScaleFactor: opts.deviceScaleFactor });
  return {
    page: page as unknown as CapturePage,
    close: () => browser.close(),
  };
}

async function defaultMkdir(dir: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
}

async function defaultWriteFile(path: string, data: Buffer): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, data);
}

async function defaultUnlink(path: string): Promise<void> {
  const { unlink } = await import('node:fs/promises');
  await unlink(path);
}

function fail(kind: CaptureFailureKind, message: string, frame?: number): CaptureResult {
  return frame === undefined ? { ok: false, kind, message } : { ok: false, kind, message, frame };
}

interface ProtocolResult {
  ok: boolean;
  kind?: CaptureErrorKind;
  message?: string;
}

/** 正規化済み RGBA バッファ同士のバイト完全一致比較（runCompress.ts の契約と同じ意味）。 */
function normalizedEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** close() 自体の失敗で、既に確定した結果を握り潰さないためのベストエフォート close。 */
async function safeClose(close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch {
    // close 失敗は無視する（呼び出し元が確定した result を返す）。
  }
}

interface WriteDeps {
  mkdir(dir: string): Promise<void>;
  writeFile(path: string, data: Buffer): Promise<void>;
  unlink(path: string): Promise<void>;
}

async function cleanupWritten(paths: string[], unlink: WriteDeps['unlink']): Promise<void> {
  for (const p of paths) {
    try {
      await unlink(p);
    } catch {
      // ベストエフォート。後始末の失敗で元の失敗理由を上書きしない。
    }
  }
}

async function runCapture(
  req: CaptureRequest,
  page: CapturePage,
  writeDeps: WriteDeps,
  onFrameTiming?: (timing: CaptureFrameTiming) => void,
): Promise<CaptureResult> {
  const start = req.frames.start;
  const end = req.frames.end;
  const frameNumbers: number[] = [];
  for (let f = start; f <= end; f++) frameNumbers.push(f);

  const spec: CaptureSpec = {
    layer: req.layer,
    projectId: req.projectId,
    videoConfig: { width: req.width, height: req.height, fps: req.fps, durationInFrames: req.durationInFrames },
    data: req.data,
    initialFrame: start,
  };

  let initResult: ProtocolResult;
  try {
    initResult = await page.evaluate(
      (s) => (window as unknown as { __capture: { init(spec: unknown): Promise<ProtocolResult> } }).__capture.init(s),
      spec,
    );
  } catch (err) {
    return fail('render-error', messageOf(err));
  }
  if (!initResult.ok) {
    return fail(initResult.kind ?? 'render-error', initResult.message ?? '初期化に失敗しました');
  }

  let mkdirDone = false;
  const writtenPaths: string[] = [];
  const manifestRuns: CaptureManifestRun[] = [];
  let pngIndex = 0;

  let runStartFrame: number | null = null;
  let runRepBuffer: Buffer | null = null;
  let prevNormalized: Uint8Array | null = null;

  async function failWithCleanup(kind: CaptureFailureKind, message: string, frame?: number): Promise<CaptureResult> {
    await cleanupWritten(writtenPaths, writeDeps.unlink);
    return fail(kind, message, frame);
  }

  /** 直前 run を endFrame で締めて書き出す（run が無ければ何もしない）。 */
  async function flushRun(endFrame: number): Promise<{ message: string } | null> {
    if (runStartFrame === null || runRepBuffer === null) return null;
    if (!mkdirDone) {
      try {
        await writeDeps.mkdir(req.outDir);
        mkdirDone = true;
      } catch (err) {
        return { message: messageOf(err) };
      }
    }
    // I-6: 生の `/` 連結だとプラットフォーム依存のパス区切りを無視してしまう。
    const path = join(req.outDir, `${pad(pngIndex)}.png`);
    try {
      await writeDeps.writeFile(path, runRepBuffer);
    } catch (err) {
      return { message: messageOf(err) };
    }
    writtenPaths.push(path);
    manifestRuns.push({ pngFileIndex: pngIndex, startFrame: runStartFrame, endFrame });
    pngIndex += 1;
    runStartFrame = null;
    runRepBuffer = null;
    return null;
  }

  for (const frame of frameNumbers) {
    const setFrameStart = onFrameTiming ? performance.now() : 0;
    let setFrameResult: ProtocolResult;
    try {
      setFrameResult = await page.evaluate(
        (f) => (window as unknown as { __capture: { setFrame(frame: number): Promise<ProtocolResult> } }).__capture.setFrame(f as number),
        frame,
      );
    } catch (err) {
      return failWithCleanup('render-error', messageOf(err), frame);
    }
    if (!setFrameResult.ok) {
      return failWithCleanup(setFrameResult.kind ?? 'render-error', setFrameResult.message ?? 'フレーム描画に失敗しました', frame);
    }
    const setFrameMs = onFrameTiming ? performance.now() - setFrameStart : 0;

    const screenshotStart = onFrameTiming ? performance.now() : 0;
    let png: Buffer;
    try {
      png = await page.screenshot({ omitBackground: true });
    } catch (err) {
      return failWithCleanup('screenshot-failed', messageOf(err), frame);
    }
    const screenshotMs = onFrameTiming ? performance.now() - screenshotStart : 0;

    const decodeStart = onFrameTiming ? performance.now() : 0;
    let normalizedFrame: Uint8Array;
    let isNewRun: boolean;
    try {
      normalizedFrame = normalizeRgba(decodePngRgba(png));
      isNewRun = prevNormalized === null || !normalizedEqual(normalizedFrame, prevNormalized);
    } catch (err) {
      // M-1: screenshot() 自体（Chromium 側）の失敗と区別する。ここは自前 PNG デコーダ/
      // 正規化段の失敗であり、原因の所在が異なる。
      return failWithCleanup('decode-failed', messageOf(err), frame);
    }
    if (onFrameTiming) {
      onFrameTiming({
        frame,
        setFrameMs,
        screenshotMs,
        decodeNormalizeCompareMs: performance.now() - decodeStart,
      });
    }

    if (isNewRun) {
      const flushErr = await flushRun(frame);
      if (flushErr) return await failWithCleanup('write-failed', flushErr.message);
      runStartFrame = frame;
      runRepBuffer = png;
    }
    prevNormalized = normalizedFrame;
  }

  const finalFlushErr = await flushRun(end + 1);
  if (finalFlushErr) return await failWithCleanup('write-failed', finalFlushErr.message);

  return { ok: true, manifest: { runs: manifestRuns, pngFiles: writtenPaths } };
}

// ---------------------------------------------------------------------------
// run 指定撮影モード（M2c T3・設計判断1の完成形）
//
// captureRunPlanner.planCaptureRuns が撮影前に確定した run 列（代表フレームの集合）だけを
// 撮影する。captureOverlaySequence の隣接フレーム比較による run 検出・decodePngRgba/
// normalizeRgba による decode/正規化/比較は一切行わない（M2b 広域 I-4 の支配項をここで消す）。
// 既存の captureOverlaySequence は無変更で温存する（既存 e2e/テストへの影響を最小にするため、
// 明示的な置換ではなく並存とする。判断は report に記載）。
//
// #199 は無変更: 撮影対象フレームへの setFrame は依然 T2 プロトコル（React コミット ACK +
// rAF×2 + decodeImages 待ち）を通す。プロトコル自体は変えない。
// ---------------------------------------------------------------------------

/** 撮影すべき1本の run（captureRunPlanner.PlannedCaptureRun と同形）。 */
export interface CapturePlannedRun {
  /** 撮影する代表フレーム。 */
  representativeFrame: number;
  /** run の開始フレーム（inclusive）。manifest にそのまま写す。 */
  startFrame: number;
  /** run の終了フレーム（exclusive）。manifest にそのまま写す。 */
  endFrame: number;
}

/** run 指定撮影の要求。事前計算済み run 列だけを撮影する。 */
export interface CaptureRunsRequest {
  serverUrl: string;
  layer: CaptureLayerKind;
  projectId: string;
  /** レイヤ種別ごとの描画データ。正本は layers.tsx の各 LayerData。 */
  data: unknown;
  width: number;
  height: number;
  /** CSS合成座標を保持したまま最終画素数で撮る縮小率。省略は等倍。 */
  pixelRatio?: number;
  fps: number;
  /** 合成全体の尺（フレーム数）。videoConfig.durationInFrames にそのまま渡す。 */
  durationInFrames: number;
  /** 撮影する run 列（呼び出し順に setFrame(representativeFrame) する）。 */
  runs: CapturePlannedRun[];
  /** 代表 PNG の書き出し先（寿命管理は captureOverlaySequence と同じ契約）。 */
  outDir: string;
}

export type CaptureRunsResult =
  | { ok: true; manifest: { runs: CaptureManifestRun[]; pngFiles: string[] } }
  | { ok: false; kind: CaptureFailureKind; message: string; frame?: number };

/**
 * run 指定撮影モードの入力検証（fail-loud・T3 追補・レビュー Minor①）。
 * captureRunPlanner.assertValidSpans/assertNonOverlappingSpans と同じ一貫性で、未整列・重複・
 * endFrame<=startFrame・非整数フレームを黙って通さない（呼び出し側のバグを撮影開始前に弾く）。
 * chromium 起動より前に呼ぶ——不正な run 列で無駄に Chromium を起動させないため。
 */
function assertValidRuns(runs: CapturePlannedRun[]): void {
  let prevEnd = -Infinity;
  for (const run of runs) {
    if (
      !Number.isInteger(run.representativeFrame) ||
      !Number.isInteger(run.startFrame) ||
      !Number.isInteger(run.endFrame)
    ) {
      throw new Error(`captureDriver: runs は整数フレームのみです（受け取った値: ${JSON.stringify(run)}）`);
    }
    if (run.startFrame < 0) {
      throw new Error(`captureDriver: runs.startFrame は0以上のみです（受け取った値: ${run.startFrame}）`);
    }
    if (run.endFrame <= run.startFrame) {
      throw new Error(
        `captureDriver: runs.endFrame は startFrame より大きい必要があります（受け取った値: [${run.startFrame},${run.endFrame})）`,
      );
    }
    if (run.representativeFrame < run.startFrame || run.representativeFrame >= run.endFrame) {
      throw new Error(
        `captureDriver: runs.representativeFrame は [startFrame,endFrame) の範囲内である必要があります（受け取った値: ${JSON.stringify(run)}）`,
      );
    }
    if (run.startFrame < prevEnd) {
      throw new Error(
        'captureDriver: runs は startFrame の昇順・非重複で渡してください（密連番生成が順序前提のため）: ' +
          `${JSON.stringify(runs)}`,
      );
    }
    prevEnd = run.endFrame;
  }
}

async function runCaptureRuns(
  req: CaptureRunsRequest,
  page: CapturePage,
  writeDeps: WriteDeps,
  onProgress?: (captured: number, total: number) => void,
): Promise<CaptureRunsResult> {
  const spec: CaptureSpec = {
    layer: req.layer,
    projectId: req.projectId,
    videoConfig: { width: req.width, height: req.height, fps: req.fps, durationInFrames: req.durationInFrames },
    data: req.data,
    initialFrame: req.runs[0]?.representativeFrame ?? 0,
  };

  let initResult: ProtocolResult;
  try {
    initResult = await page.evaluate(
      (s) => (window as unknown as { __capture: { init(spec: unknown): Promise<ProtocolResult> } }).__capture.init(s),
      spec,
    );
  } catch (err) {
    return fail('render-error', messageOf(err));
  }
  if (!initResult.ok) {
    return fail(initResult.kind ?? 'render-error', initResult.message ?? '初期化に失敗しました');
  }

  let mkdirDone = false;
  const writtenPaths: string[] = [];
  const manifestRuns: CaptureManifestRun[] = [];

  async function failWithCleanup(
    kind: CaptureFailureKind,
    message: string,
    frame?: number,
  ): Promise<CaptureRunsResult> {
    await cleanupWritten(writtenPaths, writeDeps.unlink);
    return fail(kind, message, frame);
  }

  for (let i = 0; i < req.runs.length; i++) {
    const run = req.runs[i]!;

    let setFrameResult: ProtocolResult;
    try {
      setFrameResult = await page.evaluate(
        (f) => (window as unknown as { __capture: { setFrame(frame: number): Promise<ProtocolResult> } }).__capture.setFrame(f as number),
        run.representativeFrame,
      );
    } catch (err) {
      return failWithCleanup('render-error', messageOf(err), run.representativeFrame);
    }
    if (!setFrameResult.ok) {
      return failWithCleanup(
        setFrameResult.kind ?? 'render-error',
        setFrameResult.message ?? 'フレーム描画に失敗しました',
        run.representativeFrame,
      );
    }

    // 決定的比較は行わない: 代表フレームだけを撮り、そのまま書き出す
    // （decodePngRgba/normalizeRgba は呼ばない）。
    let png: Buffer;
    try {
      png = await page.screenshot({ omitBackground: true });
    } catch (err) {
      return failWithCleanup('screenshot-failed', messageOf(err), run.representativeFrame);
    }

    // 縮小撮影はPNGヘッダの画素数も照合する。DPRを無視した出力を後段へ渡さない。
    // 全PNGの展開・比較は不要で、既存の代表フレーム撮影の負荷を維持する。
    if (req.pixelRatio !== undefined && (png.length < 33
      || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR'
      || png.readUInt32BE(16) !== Math.round(req.width * req.pixelRatio)
      || png.readUInt32BE(20) !== Math.round(req.height * req.pixelRatio))) {
      return failWithCleanup('decode-failed', '縮小撮影のPNG画素数が指定と一致しません', run.representativeFrame);
    }

    if (!mkdirDone) {
      try {
        await writeDeps.mkdir(req.outDir);
        mkdirDone = true;
      } catch (err) {
        return failWithCleanup('write-failed', messageOf(err));
      }
    }
    // I-6 と同じ理由（captureOverlaySequence 参照）で join() を使う。
    const path = join(req.outDir, `${pad(i)}.png`);
    try {
      await writeDeps.writeFile(path, png);
    } catch (err) {
      return failWithCleanup('write-failed', messageOf(err));
    }
    writtenPaths.push(path);
    manifestRuns.push({ pngFileIndex: i, startFrame: run.startFrame, endFrame: run.endFrame });
    onProgress?.(i + 1, req.runs.length);
  }

  return { ok: true, manifest: { runs: manifestRuns, pngFiles: writtenPaths } };
}

/**
 * 事前計算済み run 列（captureRunPlanner.planCaptureRuns の出力）だけを撮影する。
 * captureOverlaySequence と起動・close・書き出し失敗時の後始末の規律は同一
 * （launchChromium → goto → 撮影 → 必ず close）。
 */
export async function captureSpecifiedRuns(
  req: CaptureRunsRequest,
  deps: CaptureDeps = {},
): Promise<CaptureRunsResult> {
  assertValidRuns(req.runs);
  const pixelRatio = req.pixelRatio ?? 1;
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 1
    || [req.width * pixelRatio, req.height * pixelRatio].some(size =>
      !Number.isFinite(size) || Math.round(size) < 1 || Math.abs(size - Math.round(size)) > 1e-6)) {
    throw new Error('captureDriver: pixelRatio は0超〜1以下で、整数の出力画素数になる値を指定してください');
  }
  const launchChromium =
    deps.launchChromium ?? ((opts) => defaultLaunchChromium(opts, deps.resolveChromium ?? resolveChromiumBin));
  const writeDeps: WriteDeps = {
    mkdir: deps.mkdir ?? defaultMkdir,
    writeFile: deps.writeFile ?? defaultWriteFile,
    unlink: deps.unlink ?? defaultUnlink,
  };

  let session: { page: CapturePage; close(): Promise<void> } | null = null;
  try {
    session = await launchChromium({
      viewport: { width: req.width, height: req.height },
      deviceScaleFactor: pixelRatio,
    });
  } catch (err) {
    return fail(err instanceof ChromiumMissingError ? 'chromium-missing' : 'launch-failed', messageOf(err));
  }
  const { page, close } = session;

  try {
    await page.goto(new URL('/capture', req.serverUrl).toString());
  } catch (err) {
    const result = fail('launch-failed', messageOf(err));
    await safeClose(close);
    return result;
  }

  let result: CaptureRunsResult;
  try {
    result = await runCaptureRuns(req, page, writeDeps, deps.onProgress);
  } catch (err) {
    result = fail('render-error', messageOf(err));
  }
  await safeClose(close);
  return result;
}

export async function captureOverlaySequence(req: CaptureRequest, deps: CaptureDeps = {}): Promise<CaptureResult> {
  const launchChromium =
    deps.launchChromium ?? ((opts) => defaultLaunchChromium(opts, deps.resolveChromium ?? resolveChromiumBin));
  const writeDeps: WriteDeps = {
    mkdir: deps.mkdir ?? defaultMkdir,
    writeFile: deps.writeFile ?? defaultWriteFile,
    unlink: deps.unlink ?? defaultUnlink,
  };

  let session: { page: CapturePage; close(): Promise<void> } | null = null;
  try {
    session = await launchChromium({
      viewport: { width: req.width, height: req.height },
      deviceScaleFactor: 1,
    });
  } catch (err) {
    return fail(err instanceof ChromiumMissingError ? 'chromium-missing' : 'launch-failed', messageOf(err));
  }
  const { page, close } = session;

  // goto 以降は必ず close() する（レビュー指摘: goto 失敗経路で close されず Chromium が残留していた）。
  try {
    await page.goto(new URL('/capture', req.serverUrl).toString());
  } catch (err) {
    const result = fail('launch-failed', messageOf(err));
    await safeClose(close);
    return result;
  }

  let result: CaptureResult;
  try {
    result = await runCapture(req, page, writeDeps, deps.onFrameTiming);
  } catch (err) {
    // runCapture は内部で失敗を全て捕捉して返す設計だが、想定外の throw に備えた最後の網。
    result = fail('render-error', messageOf(err));
  }
  // close() 自体が throw しても、既に確定した result は捨てない（レビュー指摘）。
  await safeClose(close);
  return result;
}
