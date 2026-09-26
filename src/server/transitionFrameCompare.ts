import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveFfmpegBin, resolveFfprobeBin } from './resolveFfmpeg';
import { parseVideoSize, videoSizeProbeArgs } from './probeFrames';

/**
 * 子プロセスの**非同期**実行（C-2）。
 *
 * 重い e2e（`transitionCorpus.e2e.test.ts`）は 1 ケースあたり数秒の ffmpeg を数百回起動する。
 * これを `execFileSync` で回すとワーカーのイベントループが塞がり、vitest のワーカー RPC
 * （`onTaskUpdate`）がタイムアウトして **100/100 緑でも exit 1**（Unhandled Error）になる
 * ——静かな環境でも再現する（2026-09-03 実測: 100 passed / Errors 1 / exit 1）。
 * 非同期版を使うと待ち時間の間にイベントループが回るのでこれが消える。
 */
const execFileAsync = promisify(execFile);

/**
 * 全フレーム比較の小道具（M3 T1 スパイク → T5 の受入 A ハーネスが再利用する）。
 *
 * `renderCompare.compareVideos` は「ssim の平均 1 個 + PCM」までしか出さないため、
 * 「窓内のどのフレームで何画素ずれたか」「位相が 1 フレームずれていないか」を測れない。
 * ここは **rgb24 で全フレームを復号し、フレームごとの maxAbs/meanAbs/SSIM を返す**。
 *
 * 設計:
 * - 復号は無損失（`-f rawvideo -pix_fmt rgb24`）。符号化の丸めを混ぜない。
 * - **フレーム数が一致しないことは黙って許さない**（`compareFrameSequences` が throw）。
 *   転換の位相ずれ・重なり量の取り違えはまずフレーム数の差として出るので、
 *   短い方に合わせて走査する実装は「緑だが誤り」を作る。
 * - SSIM は輝度平面（BT.601）の 8x8 ブロック平均。**ffmpeg の ssim フィルタとは窓サイズが
 *   同じだけで、値は一致しない**（ffmpeg は符号化された YUV の Y 平面をそのまま使い、
 *   こちらは rgb24 から BT.601 で作り直した輝度を使う。重み付けも異なる）。
 *   本モジュールの値は**本モジュール内での相対比較**（種別ごとの最小 SSIM の桁）にだけ使い、
 *   ffmpeg の ssim 値と直接比較しない。突き合わせたい場合は
 *   `renderCompare.compareVideos` の ssimAll を別に取る。
 */

/** 1 フレーム分の画素差。 */
export interface FrameDiff {
  /** チャンネル値の最大絶対差（0..255）。 */
  maxAbs: number;
  /** 全チャンネルの平均絶対差。 */
  meanAbs: number;
  /** 1 チャンネルでも差がある画素の数。 */
  diffPixels: number;
}

/** フレームごとの比較結果。 */
export interface FrameCompare extends FrameDiff {
  index: number;
  ssim: number;
}

/** 列全体の比較結果。 */
export interface SequenceCompare {
  frameCount: number;
  frames: FrameCompare[];
  minSsim: number;
  maxAbsOverall: number;
  /** maxAbs が最大だったフレーム番号（全一致なら 0）。 */
  worstFrame: number;
  /** SSIM が最小だったフレーム番号（全一致なら 0）。 */
  worstSsimFrame: number;
}

const CHANNELS = 3;

/** 連結された rgb24 バッファをフレーム単位へ切る。端数が出たら throw。 */
export function splitRgbFrames(buf: Buffer, width: number, height: number): Buffer[] {
  const frameBytes = width * height * CHANNELS;
  if (frameBytes <= 0) throw new Error('splitRgbFrames: width/height が不正です');
  if (buf.length % frameBytes !== 0) {
    throw new Error(
      `splitRgbFrames: フレーム長の端数があります（全 ${buf.length} バイト / 1 フレーム ${frameBytes} バイト）`,
    );
  }
  const out: Buffer[] = [];
  for (let off = 0; off < buf.length; off += frameBytes) {
    out.push(buf.subarray(off, off + frameBytes));
  }
  return out;
}

/** 2 フレームの画素差。長さが違えば throw（短い方で走査しない）。 */
export function diffFrames(a: Buffer, b: Buffer): FrameDiff {
  if (a.length !== b.length) {
    throw new Error(`diffFrames: フレームの長さが違います（${a.length} vs ${b.length}）`);
  }
  let maxAbs = 0;
  let sum = 0;
  let diffPixels = 0;
  for (let i = 0; i < a.length; i += CHANNELS) {
    let pixelDiffers = false;
    for (let c = 0; c < CHANNELS; c++) {
      const d = Math.abs(a[i + c]! - b[i + c]!);
      if (d > 0) pixelDiffers = true;
      if (d > maxAbs) maxAbs = d;
      sum += d;
    }
    if (pixelDiffers) diffPixels++;
  }
  return { maxAbs, meanAbs: sum / a.length, diffPixels };
}

/**
 * どれか 1 チャンネルの絶対差が `threshold` を**超える**画素の本数。
 *
 * 全画素に乗る定数オフセット（Remotion の compositor と ffmpeg の YUV→RGB の差）と、
 * 幾何のずれ（境界 1 列の取り違え・アンチエイリアス）を分けて数えるための道具。
 * 床（定数オフセットの maxAbs）より十分上に threshold を置けば、返り値はほぼ「幾何が
 * 食い違った画素の本数」になる。
 */
export function countPixelsExceeding(
  a: Buffer,
  b: Buffer,
  threshold: number,
  mask?: Uint8Array,
): number {
  if (a.length !== b.length) {
    throw new Error(`countPixelsExceeding: フレームの長さが違います（${a.length} vs ${b.length}）`);
  }
  const pixels = a.length / CHANNELS;
  if (mask !== undefined && mask.length !== pixels) {
    throw new Error(`countPixelsExceeding: マスクの長さが画素数と違います（${mask.length} vs ${pixels}）`);
  }
  let n = 0;
  for (let p = 0; p < pixels; p++) {
    if (mask !== undefined && mask[p] === 0) continue;
    const i = p * CHANNELS;
    for (let c = 0; c < CHANNELS; c++) {
      if (Math.abs(a[i + c]! - b[i + c]!) > threshold) {
        n++;
        break;
      }
    }
  }
  return n;
}

/**
 * 高コントラストな縁から `radius` 画素以内の画素に 1 を立てたマスク（I-8）。
 *
 * slide の 0.01% 重ね代のようなサブピクセルのずれは、**輝度が急に変わる縁の周りにしか**
 * 現れない。免除する領域をこのマスクに限れば、「窓外は床のみ」という期待を
 * 平坦部については厳密に保てる（緩和を無制限にしない）。
 * 判定は 4 近傍の輝度差の最大値 > `gradientThreshold`。半径はチェビシェフ距離。
 */
export function highContrastEdgeMask(
  frame: Buffer,
  width: number,
  height: number,
  opts: { gradientThreshold: number; radius: number; includeFrameBorder?: boolean },
): Uint8Array {
  const luma = lumaPlane(frame, width, height);
  const edge = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      // 画面の外周も「縁」に数える（`includeFrameBorder`）。
      // slide のように画を平行移動する転換では、画面の端が**画の外**との不連続になるので、
      // 内側の 4 近傍だけを見る勾配では拾えない（実測: slide-right の x=1279 列が
      // Remotion 側だけ暗くなる）。この 1 列を免除しないと「窓外は床のみ」が成り立たない。
      if (opts.includeFrameBorder === true && (x === 0 || y === 0 || x === width - 1 || y === height - 1)) {
        edge[i] = 1;
        continue;
      }
      const v = luma[i]!;
      let g = 0;
      if (x > 0) g = Math.max(g, Math.abs(v - luma[i - 1]!));
      if (x + 1 < width) g = Math.max(g, Math.abs(v - luma[i + 1]!));
      if (y > 0) g = Math.max(g, Math.abs(v - luma[i - width]!));
      if (y + 1 < height) g = Math.max(g, Math.abs(v - luma[i + width]!));
      if (g > opts.gradientThreshold) edge[i] = 1;
    }
  }
  if (opts.radius <= 0) return edge;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edge[y * width + x] === 0) continue;
      const y0 = Math.max(0, y - opts.radius);
      const y1 = Math.min(height - 1, y + opts.radius);
      const x0 = Math.max(0, x - opts.radius);
      const x1 = Math.min(width - 1, x + opts.radius);
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) out[yy * width + xx] = 1;
      }
    }
  }
  return out;
}

/** rgb24 フレームの輝度平面（BT.601）。 */
function lumaPlane(frame: Buffer, width: number, height: number): Float64Array {
  const out = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * CHANNELS;
    out[i] = 0.299 * frame[o]! + 0.587 * frame[o + 1]! + 0.114 * frame[o + 2]!;
  }
  return out;
}

const SSIM_BLOCK = 8;
const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/**
 * 輝度平面 8x8 ブロック平均の SSIM（0..1）。同一フレームで厳密に 1。
 * **ffmpeg の ssim フィルタとは値が一致しない**（窓サイズが同じだけ・冒頭コメント参照）。
 * 端の余りブロック（幅/高さが 8 の倍数でない場合）は切り詰めた矩形で評価する。
 */
export function ssimFrame(a: Buffer, b: Buffer, width: number, height: number): number {
  if (a.length !== b.length) {
    throw new Error(`ssimFrame: フレームの長さが違います（${a.length} vs ${b.length}）`);
  }
  const la = lumaPlane(a, width, height);
  const lb = lumaPlane(b, width, height);
  let total = 0;
  let blocks = 0;
  for (let by = 0; by < height; by += SSIM_BLOCK) {
    for (let bx = 0; bx < width; bx += SSIM_BLOCK) {
      const bh = Math.min(SSIM_BLOCK, height - by);
      const bw = Math.min(SSIM_BLOCK, width - bx);
      const n = bw * bh;
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = 0; y < bh; y++) {
        const row = (by + y) * width + bx;
        for (let x = 0; x < bw; x++) {
          const va = la[row + x]!;
          const vb = lb[row + x]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / n;
      const mb = sb / n;
      const va = saa / n - ma * ma;
      const vb = sbb / n - mb * mb;
      const cov = sab / n - ma * mb;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      total += s;
      blocks++;
    }
  }
  return blocks === 0 ? 1 : total / blocks;
}

/**
 * 2 本のフレーム列を全フレーム比較する。
 * **フレーム数が違えば throw**（受入 A の「フレーム数厳密」はここで担保する）。
 */
export function compareFrameSequences(
  ref: readonly Buffer[],
  test: readonly Buffer[],
  width: number,
  height: number,
): SequenceCompare {
  if (ref.length !== test.length) {
    throw new Error(`compareFrameSequences: フレーム数が一致しません（ref ${ref.length} / test ${test.length}）`);
  }
  const frames: FrameCompare[] = [];
  let maxAbsOverall = 0;
  let worstFrame = 0;
  let minSsim = 1;
  let worstSsimFrame = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = diffFrames(ref[i]!, test[i]!);
    const ssim = d.maxAbs === 0 ? 1 : ssimFrame(ref[i]!, test[i]!, width, height);
    frames.push({ index: i, ...d, ssim });
    if (d.maxAbs > maxAbsOverall) {
      maxAbsOverall = d.maxAbs;
      worstFrame = i;
    }
    if (ssim < minSsim) {
      minSsim = ssim;
      worstSsimFrame = i;
    }
  }
  return { frameCount: ref.length, frames, minSsim, maxAbsOverall, worstFrame, worstSsimFrame };
}

/** rgb24 フレームの 1 画素。 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** rgb24 フレームの (x,y) の画素。 */
export function pixelAt(frame: Buffer, width: number, x: number, y: number): Rgb {
  const o = (y * width + x) * CHANNELS;
  return { r: frame[o]!, g: frame[o + 1]!, b: frame[o + 2]! };
}

/**
 * 行 y を左から走査し、述語が最初に真になる x を返す（無ければ null）。
 * wipe/slide の境界列を測るのに使う。
 */
export function boundaryAlongRow(
  frame: Buffer,
  width: number,
  y: number,
  predicate: (px: Rgb) => boolean,
): number | null {
  for (let x = 0; x < width; x++) {
    if (predicate(pixelAt(frame, width, x, y))) return x;
  }
  return null;
}

/** 列 x を上から走査し、述語が最初に真になる y を返す（無ければ null）。 */
export function boundaryAlongColumn(
  frame: Buffer,
  width: number,
  height: number,
  x: number,
  predicate: (px: Rgb) => boolean,
): number | null {
  for (let y = 0; y < height; y++) {
    if (predicate(pixelAt(frame, width, x, y))) return y;
  }
  return null;
}

/**
 * ffprobe で映像 1 本目の実寸を引く（解決は `resolveFfprobeBin` に一本化・M-4）。
 *
 * **引数と parse は製品と同じ 1 箇所**（`probeFrames.videoSizeProbeArgs` / `parseVideoSize`・C-7 M-8）。
 * 兄弟実装（別の正規表現）を持たない——同じ入力で違う答えを返す組が作れなくなる。
 * 製品版と違うのは失敗時の扱いだけ（e2e は計測不能を throw・製品は null で Remotion 退避）。
 */
export function probeVideoSize(path: string): { width: number; height: number } {
  const probe = resolveFfprobeBin();
  if (!probe.ok) throw new Error('probeVideoSize: ffprobe が見つかりません');
  const out = execFileSync(probe.bin, videoSizeProbeArgs(path), { encoding: 'utf8' }).trim();
  return parseProbedSize(out, path);
}

/** `probeVideoSize` の非同期版（C-2）。 */
export async function probeVideoSizeAsync(path: string): Promise<{ width: number; height: number }> {
  const probe = resolveFfprobeBin();
  if (!probe.ok) throw new Error('probeVideoSize: ffprobe が見つかりません');
  const { stdout } = await execFileAsync(probe.bin, videoSizeProbeArgs(path), { encoding: 'utf8' });
  return parseProbedSize(stdout.trim(), path);
}

function parseProbedSize(out: string, path: string): { width: number; height: number } {
  const size = parseVideoSize(out);
  if (size === null) throw new Error(`probeVideoSize: 実寸を読めません（${path}: "${out}"）`);
  return { width: size.width, height: size.height };
}

/**
 * 動画を rgb24 の全フレームへ復号する（実 ffmpeg）。
 * ffmpeg が使えなければ throw（計測不能を無言で空配列に畳まない）。
 *
 * **実寸を ffprobe で引いて引数と突き合わせる**（I-4）。偽の寸法でも
 * 1 フレーム分のバイト数が全長を割り切ってしまう組み合わせ（例: 実寸 64x32 を 32x16 と偽る）が
 * あり、`splitRgbFrames` の端数チェックだけでは「4 倍のフレーム数」が黙って返る。
 *
 * **メモリ方針（M-1）**: 現状は全フレームを 1 本の Buffer へ受ける（`execFileSync`）ため、
 * `maxBytes`（既定 2GiB）= 1280x720 で約 776 フレーム（26 秒）が上限。
 * 上限を超える入力は**黙って切り詰めず throw** する。長尺を扱う必要が出たら
 * `spawn` + `stdout` の `data` を frameBytes 単位で切って逐次コールバックへ渡す
 * ストリーミング復号（`decodeRgbFramesStreaming(path, w, h, onFrame)`）へ差し替える
 * — 判定側（compare / phase）はフレーム単位で畳み込めるので全フレーム保持は本来不要。
 */
export function decodeRgbFrames(path: string, width: number, height: number, maxBytes = 2 * 1024 * 1024 * 1024): Buffer[] {
  const ffmpeg = decodeBin();
  assertDecodeSize(probeVideoSize(path), path, width, height);
  const out = execFileSync(ffmpeg, rawvideoArgs(path), { maxBuffer: maxBytes });
  return splitRgbFrames(out, width, height);
}

/**
 * `decodeRgbFrames` の**非同期版**（C-2）。重い e2e はこちらを使う
 * ——同期版だとワーカーのイベントループが塞がり vitest の RPC がタイムアウトする。
 */
export async function decodeRgbFramesAsync(
  path: string,
  width: number,
  height: number,
  maxBytes = 2 * 1024 * 1024 * 1024,
): Promise<Buffer[]> {
  const ffmpeg = decodeBin();
  assertDecodeSize(await probeVideoSizeAsync(path), path, width, height);
  const { stdout } = await execFileAsync(ffmpeg, rawvideoArgs(path), { maxBuffer: maxBytes, encoding: 'buffer' });
  return splitRgbFrames(stdout, width, height);
}

function decodeBin(): string {
  const ffmpeg = resolveFfmpegBin();
  if (!ffmpeg.ok) throw new Error('decodeRgbFrames: ffmpeg が見つかりません');
  return ffmpeg.bin;
}

/** -map 0:v:0 = 映像 1 本目だけを取る（M-2。音声つき入力で rawvideo に他ストリームが混ざらないように）。 */
function rawvideoArgs(path: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
}

function assertDecodeSize(
  actual: { width: number; height: number },
  path: string,
  width: number,
  height: number,
): void {
  if (actual.width !== width || actual.height !== height) {
    throw new Error(
      `decodeRgbFrames: 実寸と引数が違います（実寸 ${actual.width}x${actual.height} / 引数 ${width}x${height}: ${path}）`,
    );
  }
}

/**
 * 観測画素 v を A→B の直線へ射影して progress を逆算する。
 * A/B は**その系統自身の**モデルレンダ（転換なし）から取るので、系統ごとの色写像は両辺から落ちる。
 * A と B が同色（射影不能）なら NaN。
 */
export function progressFrom(v: Rgb, a: Rgb, b: Rgb): number {
  const abr = b.r - a.r;
  const abg = b.g - a.g;
  const abb = b.b - a.b;
  const den = abr * abr + abg * abg + abb * abb;
  if (den === 0) return NaN;
  return ((v.r - a.r) * abr + (v.g - a.g) * abg + (v.b - a.b) * abb) / den;
}

/** 位相軸の計測結果（C-2: 受入 A の判定軸）。 */
export interface PhaseAxis {
  /** 窓内フレーム k（0..D-1）の実測 progress。 */
  progress: number[];
  /** 期待値 k/D。 */
  expected: number[];
  /** max |progress[k] − k/D|。 */
  maxPhaseError: number;
  /** 窓の直前フレームが純 A か。 */
  pureBefore: boolean;
  /** 窓の直後フレーム（k=D）が純 B か。 */
  pureAfter: boolean;
  /** 純度判定に使った実測のチャンネル差。 */
  beforeMaxAbs: number;
  afterMaxAbs: number;
  /** 位相軸の合否（純 A・純 B・位相誤差が許容内）。 */
  ok: boolean;
}

export interface PhaseAxisParams {
  frames: readonly Buffer[];
  /** 窓の開始フレーム（最終座標）。 */
  windowStart: number;
  /** 窓のフレーム数 D。 */
  windowLength: number;
  width: number;
  /** 背景を測る観測点（オーバーレイ・マーカーに当たらない点）。 */
  probe: { x: number; y: number };
  /** 窓内 k（-1..D）に対応する純 A のフレーム。 */
  modelAAt: (k: number) => Buffer;
  /** 窓内 k（-1..D）に対応する純 B のフレーム。 */
  modelBAt: (k: number) => Buffer;
  /** 純 A / 純 B 判定の許容差（チャンネル値・既定 1＝8bit 量子化ぶん）。 */
  purityTolerance?: number;
  /**
   * 位相誤差の許容（**既定は `0.5 / windowLength`＝半フレーム**・C-1）。
   *
   * 固定値（旧既定 0.02）にすると **D が大きいほど 1 フレームの位相ずれが許容の下に潜る**。
   * 1 フレームずれの位相誤差は 1/D なので、許容が 1/D 以上だと陰性対照が緑で通る。
   * 製品の転換長の上限は **60 フレーム**（`src/app/panels/inspector/JoinSettings.tsx:124` の
   * `max={60}`）で、D=60 では 1/60 ≒ 0.0167 < 0.02 ＝ 旧既定は上限側で機能しない。
   * 半フレーム（0.5/D）なら D に依らず「1 フレームずれは赤・半フレーム未満は緑」になる。
   */
  phaseTolerance?: number;
  /**
   * 「窓の直前フレームが純 A」を合否に含めるか（既定 true・I-6）。
   *
   * 窓が接するケース（`D_left + D_right = L`。スパイクの `abc-touch-d16` の 2 本目）では、
   * 直前フレーム＝1 本目の窓の最終フレーム＝**混色**なので、この条件は構造的に成り立たない。
   * 種別ではなく**窓の隣接関係**で外すためのスイッチ。false でも `pureBefore` の観測値は返す
   * （記録は落とさない）し、位相そのもの・窓直後の純 B は判定に残る。
   */
  requirePureBefore?: boolean;
}

/**
 * 転換窓の**位相**を判定軸として測る（C-2）。
 *
 * 画素の閾値判定（`countPixelsExceeding`）は、A→B の距離が短い / D が大きいときに
 * **1 フレームの位相ずれを床の下に隠してしまう**（例: D=16 で A→B の距離 255 なら
 * 1 フレームずれても差は 255/16 ≒ 16 で、床 32 を超えない）。
 * 位相ずれは転換の**致命的な壊れ方**なので、画素軸とは独立にこの軸で判定する。
 *
 * 判定は 3 つ:
 *   1. 窓の直前フレームが純 A（転換が早く始まっていない）
 *   2. 窓の次のフレーム（k=D）が純 B（転換が遅れて終わっていない）
 *   3. 窓内 k の実測 progress が k/D（`phaseTolerance` 内）
 * 3 は 1・2 が真でも壊れ得る（窓の内側だけ 1 フレームずれる場合）ので必ず併記する。
 *
 * ## この軸で分からないこと（I-5）
 * **単色 probe は「クリップ内のどのフレームが出たか」の同定に無力**。`probe` は背景の 1 点で、
 * 素材の区間内では色が一定なので、A（または B）の**別フレーム**が出ても観測値は変わらない
 * ——progress は「A と B がどの比で混ざったか」しか測れない。
 * 「A の 1 フレーム前の内容が出た」（正典表 ⑦）のような**クリップ内フレームの取り違え**は、
 * フレーム番号を焼き込んだ目印（fixture の ID パッチ）か、その期待ブレンド
 * `(1−p)·id(nA) + p·id(nB)` との突合でしか捕まえられない。
 */
export function measurePhaseAxis(params: PhaseAxisParams): PhaseAxis {
  const {
    frames, windowStart, windowLength: d, width, probe,
    modelAAt, modelBAt, purityTolerance = 1, requirePureBefore = true,
  } = params;
  if (d <= 0) throw new Error('measurePhaseAxis: windowLength は 1 以上が必要です');
  // 既定は半フレーム（C-1）。D に依らず「1 フレームずれ（誤差 1/D）は必ず赤」になる。
  const phaseTolerance = params.phaseTolerance ?? 0.5 / d;
  if (windowStart < 0 || windowStart + d > frames.length) {
    throw new Error(`measurePhaseAxis: 窓がフレーム列の外です（start ${windowStart} / D ${d} / frames ${frames.length}）`);
  }
  const progress: number[] = [];
  const expected: number[] = [];
  let maxPhaseError = 0;
  for (let k = 0; k < d; k++) {
    const v = pixelAt(frames[windowStart + k]!, width, probe.x, probe.y);
    const p = progressFrom(v, pixelAt(modelAAt(k), width, probe.x, probe.y), pixelAt(modelBAt(k), width, probe.x, probe.y));
    progress.push(p);
    expected.push(k / d);
    const err = Math.abs(p - k / d);
    if (Number.isFinite(err) && err > maxPhaseError) maxPhaseError = err;
    if (!Number.isFinite(p)) maxPhaseError = Number.POSITIVE_INFINITY;
  }
  const channelMaxAbs = (a: Rgb, b: Rgb): number =>
    Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

  let beforeMaxAbs = Number.NaN;
  let pureBefore = false;
  if (windowStart - 1 >= 0) {
    beforeMaxAbs = channelMaxAbs(
      pixelAt(frames[windowStart - 1]!, width, probe.x, probe.y),
      pixelAt(modelAAt(-1), width, probe.x, probe.y),
    );
    pureBefore = beforeMaxAbs <= purityTolerance;
  }
  let afterMaxAbs = Number.NaN;
  let pureAfter = false;
  if (windowStart + d < frames.length) {
    afterMaxAbs = channelMaxAbs(
      pixelAt(frames[windowStart + d]!, width, probe.x, probe.y),
      pixelAt(modelBAt(d), width, probe.x, probe.y),
    );
    pureAfter = afterMaxAbs <= purityTolerance;
  }
  return {
    progress, expected, maxPhaseError, pureBefore, pureAfter, beforeMaxAbs, afterMaxAbs,
    ok: (pureBefore || !requirePureBefore) && pureAfter && maxPhaseError <= phaseTolerance,
  };
}
