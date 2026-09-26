/**
 * M2c T1 (a) — concat デマルチプレクサのフレーム精度スパイク（実 ffmpeg）。
 *
 * ## 何を決めるためのテストか
 * M2c 設計判断4: 可変長 run の静止画列を **1レイヤ=1入力** にする手段として
 * `-f concat -safe 0`（file/duration 行）を第一候補にしている。リポジトリに前例がゼロで、
 * concat デマルチプレクサには「duration の丸め」「最終エントリの複製要否」「fps フィルタ
 * 併用時の写像」という既知の罠があるため、**実データ規模で frame-exact を実測**してから
 * 採否を決める（不成立なら退避案＝代表 PNG を run 長ぶん複製した密連番 + image2）。
 *
 * ## 測り方（写像を直接読む）
 * run r の PNG に「r を画素値へ符号化した」16x16 の不透明ブロックを描き、それ以外は完全透明に
 * する（R = r & 0xFF / G = r >> 8 / B = 0x40 固定）。これをベース映像へ overlay し、
 * **出力の全フレームからブロック内の画素を読み出して run 番号を復号**する。
 * 「frame f にどの run の絵が出たか」という写像そのものが観測できるので、
 * 境界フレーム ±1 は特別扱いせず **3,000 フレーム全部**を期待写像と突き合わせる。
 *
 * 画素は無損失で読む必要があるため:
 *   - overlay は `format=rgb`（既定の yuv420 は RGB↔YUV 丸めで値が数単位ずれる。
 *     nativeExportShape.e2e.test.ts が実測済みの既知事象）
 *   - 出力は `-f rawvideo -pix_fmt rgb24`（コーデック非経由）
 *   - ただし全フレームを raw で出すと巨大なので、**観測点だけを crop して hstack** し
 *     1フレーム 16x8 に落とす（3,000fr で 1.15MB）
 * ここで測っているのは「concat 入力のフレーム写像」であって符号化画質ではないため、
 * 無損失経路で測るのが正しい（写像はコーデックに依存しない）。
 *
 * ## 実測結論（2026-09-02・このリポジトリの ffmpeg で実行）
 * **concat デマルチプレクサは frame-exact にならない → 不採用。退避案（密連番 + image2）を採る。**
 * 根因は duration の書式でも最終エントリの複製でもなく、**concat デマルチプレクサが画像
 * ストリームに与える timebase が 1/25 固定**であること（本ファイルが ffprobe で直接観測して
 * pin する）。書いた duration は 40ms 刻みへ量子化されるため、fps=30 の合成では run 境界が
 * 最大 ±0.5 フレームずれる。実測でも 186 本の run 境界のうち 34 フレームが取り違えになった。
 * duration の桁数（6桁/9桁）・累積補正 µs・最終エントリ複製・fps の round・半フレーム前進・
 * 入力側 `-r 30` の 11 通りを試して**一つも frame-exact にならなかった**（下の表）。
 *
 * ## 実データ規模（#182）
 * run 数 186（LCG 実生成値）/ 総フレーム 3,000 / run 長 1..30 フレームの可変長（決定的 LCG）。
 * M2b の実測（GoldArch=120run/120fr 等）から、実プロジェクトのテロップ層は
 * 「短い run が数百本」という形になるため、この分布を模す。
 */
import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFfmpegBin } from './resolveFfmpeg';

const ffmpeg = resolveFfmpegBin();

const WIDTH = 160;
const HEIGHT = 90;
const FPS = 30;
const TOTAL_FRAMES = 3000;
/** run 番号ブロック（左上）。 */
const BLOCK = 16;
/**
 * ベース映像の色（lavfi color=0x102030）。透過が保たれていることの対照点に使う。
 * 実測: rgb24 で読み出すと (16,32,47) になる（color ソースが内部 YUV で生成され、
 * rgba へ変換する際に B が 1 だけ落ちる。nativeExportShape.e2e.test.ts が記録している
 * RGB↔YUV 丸めと同種の事象で、本スパイクの対象＝フレーム写像とは無関係）。
 * よって対照点はチャンネルごと ±2 の許容で判定する（run ブロックの読み出しは
 * overlay format=rgb 経由で完全一致なので許容は入れない）。
 */
const BASE_RGB = { r: 0x10, g: 0x20, b: 0x30 };
const BASE_TOLERANCE = 2;
/** 透明域の観測点（PNG のブロック外＝ベースがそのまま見えるべき位置）。 */
const CLEAR_POINT = { x: 120, y: 60 };

// ---------------------------------------------------------------------------
// 最小 PNG エンコーダ（RGBA・colorType 6・filter 0）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** run 番号 r を符号化した透過 PNG（左上 16x16 だけ不透明）。 */
function encodeRunPng(runIndex: number): Buffer {
  const raw = Buffer.alloc(HEIGHT * (1 + WIDTH * 4)); // 各行の先頭に filter byte 0
  const r = runIndex & 0xff;
  const g = (runIndex >> 8) & 0xff;
  const b = 0x40;
  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = y * (1 + WIDTH * 4);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < WIDTH; x++) {
      const p = rowStart + 1 + x * 4;
      const inBlock = x < BLOCK && y < BLOCK;
      raw[p] = inBlock ? r : 0;
      raw[p + 1] = inBlock ? g : 0;
      raw[p + 2] = inBlock ? b : 0;
      raw[p + 3] = inBlock ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colorType RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// run 列（実データ規模・決定的）
// ---------------------------------------------------------------------------

interface Run {
  index: number;
  startFrame: number;
  /** exclusive */
  endFrame: number;
}

/** 決定的 LCG（seed 固定）で run 長 1..30 を振り、合計がちょうど TOTAL_FRAMES になるよう作る。 */
function buildRuns(): Run[] {
  let state = 20260902;
  const next = (): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state / 0x100000000;
  };
  const runs: Run[] = [];
  let frame = 0;
  while (frame < TOTAL_FRAMES) {
    const len = Math.min(1 + Math.floor(next() * 30), TOTAL_FRAMES - frame);
    runs.push({ index: runs.length, startFrame: frame, endFrame: frame + len });
    frame += len;
  }
  return runs;
}

/** frame -> run index の期待写像。 */
function expectedMapping(runs: Run[]): Int32Array {
  const map = new Int32Array(TOTAL_FRAMES).fill(-1);
  for (const run of runs) {
    for (let f = run.startFrame; f < run.endFrame; f++) map[f] = run.index;
  }
  return map;
}

// ---------------------------------------------------------------------------
// 観測（rawvideo の読み出し）
// ---------------------------------------------------------------------------

/** 出力 1 フレーム = 16x8 rgb24（左 8x8 = run ブロック / 右 8x8 = 透明域）。 */
const PROBE_W = 16;
const PROBE_H = 8;
const FRAME_BYTES = PROBE_W * PROBE_H * 3;

interface Observed {
  /** 復号した run 番号（-1 = ブロック色が読めない） */
  runIndex: number;
  clear: { r: number; g: number; b: number };
}

function readFrame(raw: Buffer, frame: number): Observed {
  const base = frame * FRAME_BYTES;
  const at = (x: number, y: number): { r: number; g: number; b: number } => {
    const p = base + (y * PROBE_W + x) * 3;
    return { r: raw[p]!, g: raw[p + 1]!, b: raw[p + 2]! };
  };
  const block = at(2, 2);
  const clear = at(10, 2);
  const runIndex = block.b === 0x40 ? block.r + (block.g << 8) : -1;
  return { runIndex, clear };
}

/** 観測 raw を期待写像と突き合わせ、不一致フレームを返す。 */
function diffMapping(raw: Buffer, expected: Int32Array): { frame: number; got: number; want: number }[] {
  const out: { frame: number; got: number; want: number }[] = [];
  const frames = Math.floor(raw.length / FRAME_BYTES);
  for (let f = 0; f < TOTAL_FRAMES; f++) {
    const got = f < frames ? readFrame(raw, f).runIndex : -2;
    if (got !== expected[f]) out.push({ frame: f, got, want: expected[f]! });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ffmpeg 実行
// ---------------------------------------------------------------------------

/**
 * 観測点だけを切り出す filter_complex。
 * 入力1（オーバーレイ列）の扱いだけが variant ごとに変わる。
 */
function filterFor(overlayChain: string): string {
  return (
    `[0:v]format=rgba[base];` +
    `[1:v]${overlayChain}[ov];` +
    `[base][ov]overlay=x=0:y=0:format=rgb:eof_action=pass[o];` +
    `[o]split=2[a][b];` +
    `[a]crop=8:8:2:2[c1];` +
    `[b]crop=8:8:${CLEAR_POINT.x}:${CLEAR_POINT.y}[c2];` +
    `[c1][c2]hstack=inputs=2[outv]`
  );
}

function runFfmpeg(bin: string, inputArgs: string[], filter: string, outPath: string): number {
  const t0 = performance.now();
  execFileSync(
    bin,
    [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x102030:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${TOTAL_FRAMES / FPS}`,
      ...inputArgs,
      '-filter_complex', filter,
      '-map', '[outv]',
      '-frames:v', String(TOTAL_FRAMES),
      '-f', 'rawvideo', '-pix_fmt', 'rgb24',
      '-y', outPath,
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return performance.now() - t0;
}

interface VariantResult {
  label: string;
  mismatches: number;
  firstMismatch?: { frame: number; got: number; want: number };
  framesProduced: number;
  elapsedMs: number;
  inputBytes: number;
}

const RESULTS: VariantResult[] = [];

describe.skipIf(!ffmpeg.ok)('M2c T1(a) concat デマルチプレクサのフレーム精度（実 ffmpeg）', () => {
  it('可変長 run 186本 / 3,000フレームの写像を実測し、方式を確定する', () => {
    const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
    const dir = mkdtempSync(join(tmpdir(), 'm2c-concat-spike-'));
    try {
      const runs = buildRuns();
      const expected = expectedMapping(runs);

      // 実データ規模の確認（恒等 fixture・過小規模の排除）
      expect(runs.length).toBeGreaterThanOrEqual(150);
      expect(runs[runs.length - 1]!.endFrame).toBe(TOTAL_FRAMES);
      const lengths = new Set(runs.map((r) => r.endFrame - r.startFrame));
      expect(lengths.size, 'run 長が可変であること').toBeGreaterThan(10);

      // --- 代表 PNG（run 数ぶん）を書き出す ---
      const pngPaths: string[] = [];
      let concatPngBytes = 0;
      for (const run of runs) {
        const p = join(dir, `run-${String(run.index).padStart(6, '0')}.png`);
        const buf = encodeRunPng(run.index);
        writeFileSync(p, buf);
        concatPngBytes += buf.length;
        pngPaths.push(p);
      }

      // --- concat リスト（3 variant） ---
      /**
       * duration の書式が写像に効くため3通り作る。
       *  - 'naive6': 各 run 長を素直に秒へ直して小数6桁（= 実装が一番書きそうな形）
       *  - 'naive9': 小数9桁（丸め桁を増やすだけで直るのかの切り分け）
       *  - 'cumulative': **累積が絶対フレーム境界に一致する**よう µs 単位で差分を取る
       *    （dur_i = round(end_i/fps*1e6) - round(start_i/fps*1e6)）。concat デマルチプレクサは
       *    duration を µs 精度で読んで加算していくので、素直な等分割だと 1/30s=33333.33µs の
       *    切り捨て分が累積してフレームが遅れる。これがこの罠の本体。
       */
      type DurationMode = 'naive6' | 'naive9' | 'cumulative';
      function durationOf(run: Run, mode: DurationMode): string {
        if (mode === 'naive6') return ((run.endFrame - run.startFrame) / FPS).toFixed(6);
        if (mode === 'naive9') return ((run.endFrame - run.startFrame) / FPS).toFixed(9);
        const us =
          Math.round((run.endFrame / FPS) * 1e6) - Math.round((run.startFrame / FPS) * 1e6);
        return (us / 1e6).toFixed(6);
      }

      function listFor(mode: DurationMode, duplicateLast: boolean): string {
        const lines = ['ffconcat version 1.0'];
        runs.forEach((run, i) => {
          lines.push(`file '${pngPaths[i]!.replace(/'/g, "'\\''")}'`);
          lines.push(`duration ${durationOf(run, mode)}`);
        });
        if (duplicateLast) {
          // 既知の罠: 最終エントリの duration は「次のエントリ」が無いと反映されない実装が
          // あるため、最後のファイルをもう一度（duration 無しで）並べる回避策が広く使われる。
          lines.push(`file '${pngPaths[pngPaths.length - 1]!.replace(/'/g, "'\\''")}'`);
        }
        return lines.join('\n') + '\n';
      }

      const listPlain = join(dir, 'list-plain.txt');
      const listDup = join(dir, 'list-dup.txt');
      const listNaive9 = join(dir, 'list-naive9.txt');
      const listCumulative = join(dir, 'list-cumulative.txt');
      const listCumulativeDup = join(dir, 'list-cumulative-dup.txt');
      writeFileSync(listPlain, listFor('naive6', false));
      writeFileSync(listDup, listFor('naive6', true));
      writeFileSync(listNaive9, listFor('naive9', false));
      writeFileSync(listCumulative, listFor('cumulative', false));
      writeFileSync(listCumulativeDup, listFor('cumulative', true));

      const variants: { label: string; inputArgs: string[]; chain: string; inputBytes: number }[] = [
        {
          label: 'concat + fps フィルタ（最終複製なし）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listPlain],
          chain: `format=rgba,fps=${FPS}`,
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat + fps フィルタ（最終エントリ複製）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listDup],
          chain: `format=rgba,fps=${FPS}`,
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat・fps フィルタ無し（overlay の PTS 追従のみ）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listPlain],
          chain: 'format=rgba',
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat + fps フィルタ（duration 小数9桁）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listNaive9],
          chain: `format=rgba,fps=${FPS}`,
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat + fps フィルタ（duration 累積補正 µs）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listCumulative],
          chain: `format=rgba,fps=${FPS}`,
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat + fps フィルタ（累積補正 + 最終エントリ複製）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listCumulativeDup],
          chain: `format=rgba,fps=${FPS}`,
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat・fps フィルタ無し（累積補正）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listCumulative],
          chain: 'format=rgba',
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat + 半フレーム前進 + fps（累積補正）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listCumulative],
          chain: `format=rgba,setpts=PTS+${(0.5 / FPS).toFixed(9)}/TB,fps=${FPS}`,
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat + fps round=up（累積補正）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listCumulative],
          chain: `format=rgba,fps=${FPS}:round=up`,
          inputBytes: concatPngBytes,
        },
        {
          label: 'concat + fps round=down（累積補正）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-i', listCumulative],
          chain: `format=rgba,fps=${FPS}:round=down`,
          inputBytes: concatPngBytes,
        },
        {
          // 根因（下の doc 参照）= concat デマルチプレクサが画像ストリームに 1/25 の
          // timebase を与えること。入力側 `-r 30` で timebase を上書きできるかの切り分け。
          label: 'concat + 入力 -r 30（累積補正）',
          inputArgs: ['-f', 'concat', '-safe', '0', '-r', String(FPS), '-i', listCumulative],
          chain: `format=rgba,fps=${FPS}`,
          inputBytes: concatPngBytes,
        },
      ];

      for (const v of variants) {
        const outPath = join(dir, `out-${RESULTS.length}.raw`);
        const elapsedMs = runFfmpeg(bin, v.inputArgs, filterFor(v.chain), outPath);
        const raw = readFileSync(outPath);
        const mismatches = diffMapping(raw, expected);
        RESULTS.push({
          label: v.label,
          mismatches: mismatches.length,
          ...(mismatches[0] ? { firstMismatch: mismatches[0] } : {}),
          framesProduced: Math.floor(raw.length / FRAME_BYTES),
          elapsedMs,
          inputBytes: v.inputBytes,
        });
        rmSync(outPath, { force: true });
      }

      // --- 退避案: 代表 PNG を run 長ぶん複製した密連番 + image2 ---
      const denseDir = join(dir, 'dense');
      mkdirSync(denseDir, { recursive: true });
      let denseBytes = 0;
      const t0 = performance.now();
      for (const run of runs) {
        const buf = readFileSync(pngPaths[run.index]!);
        for (let f = run.startFrame; f < run.endFrame; f++) {
          writeFileSync(join(denseDir, `${String(f).padStart(6, '0')}.png`), buf);
          denseBytes += buf.length;
        }
      }
      const denseWriteMs = performance.now() - t0;
      const denseOut = join(dir, 'out-dense.raw');
      const denseElapsed = runFfmpeg(
        bin,
        ['-framerate', String(FPS), '-i', join(denseDir, '%06d.png')],
        filterFor('format=rgba'),
        denseOut,
      );
      const denseRaw = readFileSync(denseOut);
      const denseMismatches = diffMapping(denseRaw, expected);
      RESULTS.push({
        label: `退避案: 密連番 + image2（PNG書き出し ${denseWriteMs.toFixed(0)}ms 込み）`,
        mismatches: denseMismatches.length,
        ...(denseMismatches[0] ? { firstMismatch: denseMismatches[0] } : {}),
        framesProduced: Math.floor(denseRaw.length / FRAME_BYTES),
        elapsedMs: denseElapsed + denseWriteMs,
        inputBytes: denseBytes,
      });

      // --- 退避案の実運用コスト対策: 複製をハードリンクにしても frame-exact か ---
      // 実スケール（1080x1920 の実テロップ PNG ≈ 60KB・14,000fr）だと素朴な複製は
      // 1レイヤ 840MB になる。ハードリンクなら実バイトは run 数ぶんで済む。
      const linkDir = join(dir, 'dense-link');
      mkdirSync(linkDir, { recursive: true });
      const tLink = performance.now();
      for (const run of runs) {
        for (let f = run.startFrame; f < run.endFrame; f++) {
          linkSync(pngPaths[run.index]!, join(linkDir, `${String(f).padStart(6, '0')}.png`));
        }
      }
      const linkMs = performance.now() - tLink;
      const linkOut = join(dir, 'out-link.raw');
      const linkElapsed = runFfmpeg(
        bin,
        ['-framerate', String(FPS), '-i', join(linkDir, '%06d.png')],
        filterFor('format=rgba'),
        linkOut,
      );
      const linkRaw = readFileSync(linkOut);
      const linkMismatches = diffMapping(linkRaw, expected);
      RESULTS.push({
        label: `退避案(ハードリンク版): 密連番 + image2（リンク作成 ${linkMs.toFixed(0)}ms 込み）`,
        mismatches: linkMismatches.length,
        ...(linkMismatches[0] ? { firstMismatch: linkMismatches[0] } : {}),
        framesProduced: Math.floor(linkRaw.length / FRAME_BYTES),
        elapsedMs: linkElapsed + linkMs,
        // 実バイトは代表 PNG のぶんだけ（リンクは inode 共有）
        inputBytes: concatPngBytes,
      });
      rmSync(linkOut, { force: true });

      // --- 対照（RED）: 期待写像を +1 フレームずらすと必ず不一致になること ---
      // 「一致した」が比較器の無感によるものでないことの直接証明。
      const shifted = new Int32Array(TOTAL_FRAMES);
      for (let f = 0; f < TOTAL_FRAMES; f++) shifted[f] = expected[Math.min(f + 1, TOTAL_FRAMES - 1)]!;
      const shiftedDiff = diffMapping(denseRaw, shifted);
      expect(
        shiftedDiff.length,
        '期待写像を1フレームずらしても不一致が出ない = 観測が写像を見ていない',
      ).toBeGreaterThan(100);

      // --- 透過が保たれていること（全フレームでブロック外はベース色のまま） ---
      let clearViolations = 0;
      for (let f = 0; f < TOTAL_FRAMES; f++) {
        const o = readFrame(denseRaw, f);
        if (
          Math.abs(o.clear.r - BASE_RGB.r) > BASE_TOLERANCE ||
          Math.abs(o.clear.g - BASE_RGB.g) > BASE_TOLERANCE ||
          Math.abs(o.clear.b - BASE_RGB.b) > BASE_TOLERANCE ||
          o.clear.b === 0x40
        ) {
          clearViolations += 1;
        }
      }
      expect(clearViolations, '透明域がベース色でないフレームがある').toBe(0);

      // --- 結果表 ---
      const table = RESULTS.map(
        (r) =>
          `  ${r.mismatches === 0 ? 'frame-exact' : `不一致 ${r.mismatches}/${TOTAL_FRAMES}`} | ${r.label} | ` +
          `frames=${r.framesProduced} | ${r.elapsedMs.toFixed(0)}ms | 入力PNG合計 ${(r.inputBytes / 1024).toFixed(0)}KB` +
          (r.firstMismatch
            ? ` | 初回不一致 frame=${r.firstMismatch.frame} got=${r.firstMismatch.got} want=${r.firstMismatch.want}`
            : ''),
      ).join('\n');
      // eslint-disable-next-line no-console
      console.log(
        `\n[M2c T1(a) concat デマルチプレクサ実測]\n  run=${runs.length} / 総フレーム=${TOTAL_FRAMES} / fps=${FPS} / ${WIDTH}x${HEIGHT}\n${table}\n`,
      );

      // --- 根因の直接観測: concat デマルチプレクサの timebase を ffprobe で読む ---
      // 「duration の書き方が悪い」のではなく「1/25 に量子化される」ことの直接証拠。
      const probe = execFileSync(
        ffmpeg.ok ? ffmpeg.bin.replace(/ffmpeg$/, 'ffprobe') : 'ffprobe',
        [
          '-hide_banner', '-v', 'error',
          '-f', 'concat', '-safe', '0', '-i', listCumulative,
          '-select_streams', 'v', '-show_entries', 'stream=time_base',
          '-of', 'default=noprint_wrappers=1:nokey=1',
        ],
        { encoding: 'utf8' },
      ).trim();
      // eslint-disable-next-line no-console
      console.log(`  concat 入力の time_base 実測: ${probe}（fps=${FPS} の合成に対して 1/25 は量子化誤差になる）`);
      expect(probe, 'concat 入力の time_base').toBe('1/25');

      // --- 判定 ---
      // 退避案は必ず成立していること（= M2c が採れる入力方式が存在する）。複製版・
      // ハードリンク版の両方が frame-exact であること。
      const fallbacks = RESULTS.filter((r) => r.label.startsWith('退避案'));
      expect(fallbacks.length).toBe(2);
      for (const f of fallbacks) {
        expect(f.mismatches, `${f.label} が frame-exact でない`).toBe(0);
        expect(f.framesProduced).toBe(TOTAL_FRAMES);
      }

      // concat 系は**ひとつも** frame-exact でないこと（実測結論の pin）。
      // この行が落ちたら朗報（ffmpeg 側の改善）なので、方式判断（設計判断4）をやり直すこと。
      const concatExact = RESULTS.filter((r) => !r.label.startsWith('退避案') && r.mismatches === 0);
      expect(
        concatExact.map((r) => r.label),
        'concat デマルチプレクサが frame-exact になった。設計判断4の再検討を行うこと',
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
