import { linkSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ffmpeg image2 連番入力を組み立てる（T1 スパイクで確定した「密連番ハードリンク + image2」方式）。
 *
 * 各 run の代表 PNG（`pngFiles[run.pngFileIndex]`）を run 長（`endFrame - startFrame`）ぶん
 * `link()`（ハードリンク）で連番ファイル化する。連番は **フレーム0起点で作る**（run の絶対
 * startFrame からではない）。呼び出し側（applyOverlays の連番型 layer）はこの連番出力を
 * **`settb=1/fps,setpts=N+startFrame`**（M-1・M2c T6 で確定した現行契約）でタイムライン上の
 * スパン開始位置へシフトする（`nativeExportVideo.ts` の `applyOverlays` 実装参照）。旧 doc は
 * `setpts=PTS-STARTPTS+{スパン開始秒}/TB`（秒・小数）を挙げていたが、これは T1 スパイク時点の
 * 想定であり実装では採らなかった——concat 出力の µs タイムベースのまま秒単位で shift すると
 * framesync が丸めを起こすため（T6 追調査で発見した Critical バグ）、`settb` でタイムベースを
 * 1/fps へ正規化してから **フレーム数の整数** で shift する方式に変わっている。
 * （T1 の実証は f=0 起点の run 列のみだったため、オフセット付きスパンの frame-exact は
 * T6 の e2e が実 ffmpeg で証明した）。
 *
 * ## `link()` は同一ファイルシステム必須（EXDEV）
 * ハードリンクは同一デバイス（同一マウントポイント）内でしか張れない。`opts.dir` は
 * 代表 PNG（`pngFiles` の実体）と同じファイルシステム配下に作る設計にすること
 * （呼び出し側の責務）。それでも別ボリュームを跨いだ場合は `EXDEV`（Node の
 * `NodeJS.ErrnoException.code === 'EXDEV'`）で `link()` が失敗するため、その1ケースだけ
 * `copyFile()`（実体コピー）へフォールバックする（ディスク増と引き換え。他のエラーはそのまま
 * 投げる＝黙って握りつぶさない）。
 *
 * ## 掃除は呼び出し側の責務
 * captureDriver.ts の outDir と同じ規律で、本関数は連番ディレクトリを作るだけで削除しない。
 * 一時ディレクトリとしての寿命管理（最終的な rmdir）は呼び出し側（合成配線）が持つ。
 */

/** captureDriver.CaptureManifestRun と同形（依存を避けるため構造的に受ける）。 */
export interface CaptureSequenceRun {
  /** pngFiles 内のインデックス（このマニフェストで書き出した代表 PNG を指す）。 */
  pngFileIndex: number;
  /** run の開始フレーム番号（inclusive・絶対フレーム番号系）。 */
  startFrame: number;
  /** run の終了フレーム番号（exclusive）。 */
  endFrame: number;
}

export interface BuildCaptureSequenceInputOptions {
  /**
   * 連番ファイルを作る出力先ディレクトリ。代表 PNG（pngFiles）と同一ファイルシステム配下に
   * 置くこと（link() の EXDEV 制約）。存在しなければ作成する（mkdir recursive）。
   */
  dir: string;
  /** image2 入力の `-framerate` に渡すフレームレート。 */
  fps: number;
  /** 連番の開始番号（`-start_number` に渡す値）。既定 0。 */
  startNumber?: number;
  /** DI: ハードリンク（既定は node:fs の linkSync）。EXDEV テスト用に差し替え可能。 */
  link?: (existingPath: string, newPath: string) => void;
  /** DI: EXDEV フォールバックのコピー（既定は node:fs の copyFileSync）。 */
  copyFile?: (existingPath: string, newPath: string) => void;
  /** DI: ディレクトリ作成（既定は node:fs の mkdirSync recursive）。 */
  mkdir?: (dir: string) => void;
  /** DI: 経過時間計測（既定は performance.now）。テストで固定値を注入する用。 */
  now?: () => number;
  /**
   * 連続性検査の基準（先頭 run の startFrame と一致すべき値）。省略時は `runs[0].startFrame`
   * を基準に使う（＝先頭の検査は事実上スキップ）。呼び出し側がスパン開始フレームを
   * 別に持っている場合はここへ渡し、先頭 run が本当にスパン先頭から始まっているかまで検査する。
   */
  spanStart?: number;
}

/** buildCaptureSequenceInput の戻り値。fastCutRender extraInputs の image2 連番指定にそのまま渡せる形。 */
export interface CaptureSequenceInput {
  /** 連番 PNG が置かれたディレクトリ（`-i {dir}/%06d.png` の {dir}）。 */
  dir: string;
  /** `-framerate` に渡す値。 */
  framerate: number;
  /** `-start_number` に渡す値。 */
  startNumber: number;
  /** 生成した連番フレームの総数（run 長の合計）。 */
  frameCount: number;
  /** リンク（またはコピー）作成に要した時間（ms）。呼び出し側の計測ログに使う。 */
  linkMs: number;
}

/** 6桁ゼロ埋けの連番ファイル名（`%06d.png` と同じ書式）。 */
function seqName(n: number): string {
  return `${String(n).padStart(6, '0')}.png`;
}

/**
 * EXDEV（デバイス跨ぎ）かどうかを判定する。unknown を受けるのは throw された値の型が
 * 保証されないため（Node の fs エラーは Error だが、DI された link/copyFile が任意の値を
 * 投げる可能性を排除しない）。
 */
function isExdev(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'EXDEV';
}

/**
 * run 列の連続性を検査する（fail-loud）。ギャップ（run[i].startFrame !== run[i-1].endFrame）を
 * 見逃すと、以降の全フレームが黙って前詰まりになる（連番は run の絶対フレームを見ず run長だけを
 * 積むため、欠けた分だけ後続の全フレームが早いタイミングへずれる）。先頭 run は
 * `spanStart`（未指定なら runs[0].startFrame 自身＝検査スキップ）と一致するかを検査する。
 */
function assertContiguousRuns(runs: readonly CaptureSequenceRun[], spanStart: number): void {
  if (runs.length === 0) return;
  const first = runs[0]!;
  if (first.startFrame !== spanStart) {
    throw new Error(
      `buildCaptureSequenceInput: 先頭 run の startFrame(${first.startFrame}) がスパン開始(${spanStart})と一致しません（ギャップは以降の全フレームを黙って前詰まりさせるため fail-loud）`,
    );
  }
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]!;
    const cur = runs[i]!;
    if (cur.startFrame !== prev.endFrame) {
      throw new Error(
        `buildCaptureSequenceInput: run[${i}].startFrame(${cur.startFrame}) が run[${i - 1}].endFrame(${prev.endFrame}) と一致しません（run 列にギャップがあります。以降の全フレームが黙って前詰まりになるため fail-loud）`,
      );
    }
  }
}

export function buildCaptureSequenceInput(
  runs: readonly CaptureSequenceRun[],
  pngFiles: readonly string[],
  opts: BuildCaptureSequenceInputOptions,
): CaptureSequenceInput {
  const startNumber = opts.startNumber ?? 0;
  const link = opts.link ?? linkSync;
  const copyFile = opts.copyFile ?? copyFileSync;
  const mkdir = opts.mkdir ?? ((dir: string) => mkdirSync(dir, { recursive: true }));
  const now = opts.now ?? (() => performance.now());

  assertContiguousRuns(runs, opts.spanStart ?? runs[0]?.startFrame ?? 0);

  mkdir(opts.dir);

  let seq = startNumber;
  const t0 = now();
  for (const run of runs) {
    const src = pngFiles[run.pngFileIndex];
    if (src === undefined) {
      throw new Error(`buildCaptureSequenceInput: pngFiles[${run.pngFileIndex}] が存在しません（run=${JSON.stringify(run)}）`);
    }
    const runLength = run.endFrame - run.startFrame;
    if (runLength <= 0) {
      throw new Error(`buildCaptureSequenceInput: run 長が0以下です（startFrame=${run.startFrame}, endFrame=${run.endFrame}）`);
    }
    for (let i = 0; i < runLength; i++) {
      const dst = join(opts.dir, seqName(seq));
      try {
        link(src, dst);
      } catch (err) {
        if (!isExdev(err)) throw err;
        copyFile(src, dst);
      }
      seq++;
    }
  }
  const linkMs = now() - t0;
  const frameCount = seq - startNumber;

  // frameCount とスパン長の一致 assert（fail-loud）: 食い違いが黙って通ると、image2 入力の
  // 総フレーム数が overlay 側の enable スパン窓（[startFrame,endFrame)）と噛み合わなくなり、
  // eof_action=pass で末尾のフレーム（テロップ等）が黙って欠落する。
  if (runs.length > 0) {
    const spanLength = runs[runs.length - 1]!.endFrame - runs[0]!.startFrame;
    if (frameCount !== spanLength) {
      throw new Error(
        `buildCaptureSequenceInput: frameCount(${frameCount}) がスパン長(${spanLength} = 最終endFrame ${runs[runs.length - 1]!.endFrame} - 先頭startFrame ${runs[0]!.startFrame})と一致しません（末尾フレームが eof_action=pass で黙って欠落するため fail-loud）`,
      );
    }
  }

  return {
    dir: opts.dir,
    framerate: opts.fps,
    startNumber,
    frameCount,
    linkMs,
  };
}
