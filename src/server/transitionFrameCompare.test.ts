/**
 * M3 T1 — 全フレーム比較の小道具のテスト。
 *
 * 純関数部（splitRgbFrames / diffFrames / ssimFrame / compareFrameSequences /
 * boundaryAlongRow / boundaryAlongColumn）は合成バッファで、復号部（decodeRgbFrames）は
 * 実 ffmpeg で検証する。
 *
 * 受入 A のハーネス（T5）がこのモジュールをそのまま使うため、
 * 「恒等（同一動画→差ゼロ）」だけで終わらせず（#194）、
 *   - 1 フレーム欠落 → フレーム数不一致で **throw**（fail-loud）
 *   - 1 画素だけ変えた動画 → maxAbs が**当該フレームでのみ**非ゼロ
 * の非恒等 fixture を必ず通す。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFfmpegBin } from './resolveFfmpeg';
import {
  boundaryAlongColumn,
  boundaryAlongRow,
  compareFrameSequences,
  countPixelsExceeding,
  decodeRgbFrames,
  diffFrames,
  highContrastEdgeMask,
  measurePhaseAxis,
  pixelAt,
  progressFrom,
  splitRgbFrames,
  ssimFrame,
} from './transitionFrameCompare';

const ffmpeg = resolveFfmpegBin();

function solid(width: number, height: number, r: number, g: number, b: number): Buffer {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

describe('transitionFrameCompare（純関数）', () => {
  it('splitRgbFrames は連結 rawvideo をフレーム単位へ切る（端数は throw）', () => {
    const w = 4;
    const h = 2;
    const a = solid(w, h, 1, 2, 3);
    const b = solid(w, h, 4, 5, 6);
    const frames = splitRgbFrames(Buffer.concat([a, b]), w, h);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.equals(a)).toBe(true);
    expect(frames[1]!.equals(b)).toBe(true);
    expect(() => splitRgbFrames(Buffer.concat([a, b.subarray(0, 5)]), w, h)).toThrow(/端数/);
  });

  it('diffFrames は同一で全ゼロ・1 画素差で maxAbs=差分値/diffPixels=1', () => {
    const w = 4;
    const h = 2;
    const a = solid(w, h, 10, 20, 30);
    expect(diffFrames(a, a)).toEqual({ maxAbs: 0, meanAbs: 0, diffPixels: 0 });

    const b = Buffer.from(a);
    b[3 * 3 + 1] = 27; // 画素3の G を +7
    const d = diffFrames(a, b);
    expect(d.maxAbs).toBe(7);
    expect(d.diffPixels).toBe(1);
    // meanAbs は全チャンネル平均（7 / (4*2*3)）
    expect(d.meanAbs).toBeCloseTo(7 / 24, 10);
  });

  it('countPixelsExceeding は閾値超えの画素だけを数える（定数オフセットと幾何ずれの切り分け）', () => {
    const w = 4;
    const h = 2;
    const a = solid(w, h, 100, 100, 100);
    // 全画素に +10 の定数オフセット + 1 画素だけ +80 の「幾何ずれ」
    const b = Buffer.from(a);
    for (let i = 0; i < b.length; i++) b[i] = 110;
    b[2 * 3] = 180;
    expect(countPixelsExceeding(a, b, 0)).toBe(8); // 全画素が差あり
    expect(countPixelsExceeding(a, b, 32)).toBe(1); // 床の上に出るのは 1 画素だけ
    expect(countPixelsExceeding(a, a, 0)).toBe(0);
    expect(() => countPixelsExceeding(a, solid(w, h + 1, 0, 0, 0), 0)).toThrow(/長さ/);
  });

  it('diffFrames は長さ不一致を throw する（黙って短い方で走査しない）', () => {
    expect(() => diffFrames(solid(4, 2, 0, 0, 0), solid(4, 3, 0, 0, 0))).toThrow(/長さ/);
  });

  it('ssimFrame は同一フレームで 1・差が大きいほど下がる', () => {
    const w = 32;
    const h = 32;
    const a = solid(w, h, 100, 100, 100);
    expect(ssimFrame(a, a, w, h)).toBeCloseTo(1, 12);

    const near = Buffer.from(a);
    for (let i = 0; i < 16 * 3; i++) near[i] = 110;
    const far = solid(w, h, 250, 10, 10);
    const sNear = ssimFrame(a, near, w, h);
    const sFar = ssimFrame(a, far, w, h);
    expect(sNear).toBeLessThan(1);
    expect(sFar).toBeLessThan(sNear);
  });

  it('compareFrameSequences はフレーム数不一致で throw（fail-loud）', () => {
    const w = 4;
    const h = 2;
    const a = [solid(w, h, 1, 1, 1), solid(w, h, 2, 2, 2)];
    const b = [solid(w, h, 1, 1, 1)];
    expect(() => compareFrameSequences(a, b, w, h)).toThrow(/フレーム数/);
  });

  it('compareFrameSequences は差のあるフレームだけを非ゼロで返す', () => {
    const w = 8;
    const h = 4;
    const base = [solid(w, h, 30, 30, 30), solid(w, h, 30, 30, 30), solid(w, h, 30, 30, 30)];
    const test = base.map((f) => Buffer.from(f));
    test[1]![5] = 42; // フレーム1の1画素だけ変える
    const rep = compareFrameSequences(base, test, w, h);
    expect(rep.frameCount).toBe(3);
    expect(rep.frames.map((f) => f.maxAbs)).toEqual([0, 12, 0]);
    expect(rep.maxAbsOverall).toBe(12);
    expect(rep.worstFrame).toBe(1);
    expect(rep.minSsim).toBeLessThan(1);
    expect(rep.frames[0]!.ssim).toBeCloseTo(1, 12);
    expect(rep.frames[2]!.ssim).toBeCloseTo(1, 12);
  });

  it('pixelAt / boundaryAlongRow / boundaryAlongColumn は境界位置を返す', () => {
    const w = 10;
    const h = 6;
    const f = Buffer.alloc(w * h * 3);
    // x < 4 は赤、x >= 4 は青
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3;
        if (x < 4) f[o] = 255;
        else f[o + 2] = 255;
      }
    }
    expect(pixelAt(f, w, 0, 0)).toEqual({ r: 255, g: 0, b: 0 });
    expect(pixelAt(f, w, 9, 5)).toEqual({ r: 0, g: 0, b: 255 });
    expect(boundaryAlongRow(f, w, 2, (p) => p.b > p.r)).toBe(4);
    // 述語が最後まで真にならないなら null
    expect(boundaryAlongRow(f, w, 2, (p) => p.g > 200)).toBeNull();

    // y < 3 は緑、y >= 3 は黒
    const g = Buffer.alloc(w * h * 3);
    for (let y = 0; y < 3; y++) for (let x = 0; x < w; x++) g[(y * w + x) * 3 + 1] = 255;
    expect(boundaryAlongColumn(g, w, h, 5, (p) => p.g < 100)).toBe(3);
  });
});

describe('countPixelsExceeding（領域マスク・I-8）', () => {
  it('マスクを渡すと 1 の画素だけを数える（0 の画素は免除）', () => {
    const w = 4;
    const h = 1;
    const a = solid(w, h, 100, 100, 100);
    const b = Buffer.from(a);
    b[0] = 200; // 画素0
    b[2 * 3] = 200; // 画素2
    expect(countPixelsExceeding(a, b, 32)).toBe(2);

    const mask = Uint8Array.from([0, 1, 1, 1]); // 画素0 を免除
    expect(countPixelsExceeding(a, b, 32, mask)).toBe(1);
    expect(countPixelsExceeding(a, b, 32, Uint8Array.from([0, 0, 0, 0]))).toBe(0);
    expect(() => countPixelsExceeding(a, b, 32, Uint8Array.from([1, 1]))).toThrow(/マスク/);
  });
});

describe('highContrastEdgeMask（I-8: 高コントラスト縁の近傍だけを免除する）', () => {
  it('縁から radius 画素以内だけが 1 になる（平坦部は 0）', () => {
    const w = 10;
    const h = 1;
    // x<5 は黒、x>=5 は白（x=4/5 の間が高コントラスト縁）
    const f = Buffer.alloc(w * h * 3);
    for (let x = 5; x < w; x++) {
      const o = x * 3;
      f[o] = 255;
      f[o + 1] = 255;
      f[o + 2] = 255;
    }
    const mask = highContrastEdgeMask(f, w, h, { gradientThreshold: 64, radius: 2 });
    expect(Array.from(mask)).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 0, 0]);

    // includeFrameBorder: 画面の外周も縁に数える（平行移動する転換で端の 1 列を免除するため）。
    // 4x3 の平坦なフレームなら外周 10 画素が 1・内側 2 画素（(1,1)/(2,1)）が 0。
    const flat43 = solid(4, 3, 100, 100, 100);
    expect(
      Array.from(highContrastEdgeMask(flat43, 4, 3, { gradientThreshold: 64, radius: 0, includeFrameBorder: true })),
    ).toEqual([1, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1]);

    // 平坦なフレームには縁が無い
    const flat = solid(w, h, 100, 100, 100);
    expect(Array.from(highContrastEdgeMask(flat, w, h, { gradientThreshold: 64, radius: 2 }))).toEqual(
      new Array(w).fill(0),
    );
  });
});

describe('measurePhaseAxis（C-2: 位相を判定軸へ昇格）', () => {
  const W = 4;
  const H = 1;
  const A = { r: 255, g: 0, b: 0 };
  const B = { r: 0, g: 0, b: 255 };
  // D=16 は実測ケース（crossfade-d16）と同じ。A→B の距離 255 に対し 1 フレームの位相ずれは
  // 255/16 ≒ 16 しか出ない＝床（32）を超えないので、画素の閾値判定では捕まらない。
  const D = 16;
  const LEN = 32;

  const mix = (p: number): Buffer =>
    solid(W, H, Math.round(A.r + (B.r - A.r) * p), 0, Math.round(A.b + (B.b - A.b) * p));

  /** 窓 [LEN-D, LEN) に P=k/D の crossfade を置いた列（全 2*LEN-D フレーム）。 */
  const sequence = (shift = 0): Buffer[] => {
    const total = LEN * 2 - D;
    const out: Buffer[] = [];
    for (let i = 0; i < total; i++) {
      const k = i - (LEN - D) - shift;
      out.push(k < 0 ? mix(0) : k >= D ? mix(1) : mix(k / D));
    }
    return out;
  };

  const params = {
    windowStart: LEN - D,
    windowLength: D,
    width: W,
    probe: { x: 0, y: 0 },
    modelAAt: () => mix(0),
    modelBAt: () => mix(1),
  };

  it('progressFrom は A→B 直線への射影で progress を返す', () => {
    expect(progressFrom({ r: 128, g: 0, b: 127 }, A, B)).toBeCloseTo(0.4980, 4);
    expect(progressFrom(A, A, B)).toBe(0);
    expect(progressFrom(B, A, B)).toBe(1);
    expect(Number.isNaN(progressFrom(A, A, A))).toBe(true);
  });

  it('位相が合っていれば P=k/D・窓直前は純 A・窓直後は純 B（ok）', () => {
    const r = measurePhaseAxis({ ...params, frames: sequence(0) });
    expect(r.progress).toHaveLength(D);
    expect(r.progress.slice(0, 3).map((p) => Number(p.toFixed(3)))).toEqual([0, 0.063, 0.125]);
    expect(r.expected.slice(0, 3)).toEqual([0, 1 / 16, 2 / 16]);
    expect(r.maxPhaseError).toBeLessThan(0.005);
    expect(r.pureBefore).toBe(true);
    expect(r.pureAfter).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('陰性対照: offset を +1 フレームずらすと位相軸が赤になる（画素差は小さいまま）', () => {
    const ref = sequence(0);
    const shifted = sequence(1);
    const r = measurePhaseAxis({ ...params, frames: shifted });
    expect(r.ok).toBe(false);
    // 1 フレームぶんの位相ずれ = 1/D（窓の後半では 15/16 と 14/16 の差として現れる）
    expect(r.maxPhaseError).toBeGreaterThanOrEqual(1 / D - 0.01);
    expect(r.pureAfter).toBe(false); // 窓の次のフレームが純 B にならない

    // 画素の絶対差は「A→B の距離 / D」しかない＝床（32）を超えない。
    // 位相軸を持たない判定（床超え画素の計数）ではこの壊れ方を捕まえられない。
    const seam = ref.map((f, i) => countPixelsExceeding(f, shifted[i]!, 32));
    expect(Math.max(...seam)).toBe(0);
    expect(Math.max(...ref.map((f, i) => diffFrames(f, shifted[i]!).maxAbs))).toBeLessThanOrEqual(Math.ceil(255 / D));
  });

  it('陰性対照: offset を −1 フレームずらしても位相軸が赤になる（純度判定だけでは足りない）', () => {
    const r = measurePhaseAxis({ ...params, frames: sequence(-1) });
    expect(r.ok).toBe(false);
    // −1 ずれでは窓の直前が純 A・直後が純 B のままになる（純度だけを見る判定は緑になる）。
    // 赤にできるのは progress の逆算＝位相軸だけ。
    expect(r.pureBefore).toBe(true);
    expect(r.pureAfter).toBe(true);
    expect(r.maxPhaseError).toBeGreaterThanOrEqual(1 / D - 0.01);
  });
});

/**
 * C-1: 位相の許容は **D に依存する**（既定 `0.5 / D` = 半フレーム）。
 *
 * 固定値 0.02 だと D が大きいほど「1 フレームずれ = 1/D」が許容の下に潜る。
 * 製品の転換長の上限は **60 フレーム**（`src/app/panels/inspector/JoinSettings.tsx:124` の
 * `max={60}`）なので、上限側の D=60 では 1/60 = 0.0167 < 0.02 となり、
 * **固定 0.02 の判定は 1 フレームの位相ずれを緑で通す**。ここはその陰性対照。
 */
describe('measurePhaseAxis の許容は D 依存（C-1: 既定 0.5/D）', () => {
  const W = 4;
  const H = 1;
  const A = { r: 255, g: 0, b: 0 };
  const B = { r: 0, g: 0, b: 255 };

  const mix = (p: number): Buffer =>
    solid(W, H, Math.round(A.r + (B.r - A.r) * p), 0, Math.round(A.b + (B.b - A.b) * p));

  /** 窓 [len−D, len) に P=k/D を置いた列（全 2*len−D フレーム）。shift で位相をずらす。 */
  const sequenceOf = (d: number, shift: number): { frames: Buffer[]; windowStart: number } => {
    const len = Math.max(2 * d, 12);
    const total = len * 2 - d;
    const frames: Buffer[] = [];
    for (let i = 0; i < total; i++) {
      const k = i - (len - d) - shift;
      frames.push(k < 0 ? mix(0) : k >= d ? mix(1) : mix(k / d));
    }
    return { frames, windowStart: len - d };
  };

  const axis = (d: number, shift: number, extra: Record<string, unknown> = {}) => {
    const { frames, windowStart } = sequenceOf(d, shift);
    return measurePhaseAxis({
      frames, windowStart, windowLength: d, width: W, probe: { x: 0, y: 0 },
      modelAAt: () => mix(0), modelBAt: () => mix(1), ...extra,
    });
  };

  it('D=2: 位相が合っていれば緑・±1 フレームで赤（許容 0.5/2 = 0.25）', () => {
    expect(axis(2, 0).ok).toBe(true);
    expect(axis(2, 0).maxPhaseError).toBeLessThan(0.25);
    for (const shift of [1, -1]) {
      const r = axis(2, shift);
      expect(r.ok).toBe(false);
      expect(r.maxPhaseError).toBeGreaterThanOrEqual(1 / 2 - 0.01);
    }
  });

  it('D=60（製品上限）: ±1 フレームで赤（固定 0.02 なら 1/60=0.0167 で緑になってしまう）', () => {
    expect(axis(60, 0).ok).toBe(true);
    for (const shift of [1, -1]) {
      const r = axis(60, shift);
      expect(r.ok).toBe(false);
      // 1 フレームずれの位相誤差は 1/60 ≒ 0.0167 で **旧既定 0.02 の下**。
      expect(r.maxPhaseError).toBeGreaterThanOrEqual(1 / 60 - 0.002);
      expect(r.maxPhaseError).toBeLessThan(0.02);
    }
    // −1 ずれは純度（前純 A・後純 B）も緑のままなので、赤にできるのは D 依存の許容だけ。
    expect(axis(60, -1).pureBefore).toBe(true);
    expect(axis(60, -1).pureAfter).toBe(true);
  });

  it('既定の許容は 0.5/D（明示指定があればそちらが優先）', () => {
    // D=60 の −1 ずれ（誤差 0.0167）は既定 0.5/60=0.00833 で赤・明示 0.02 なら緑。
    expect(axis(60, -1, { phaseTolerance: 0.02 }).ok).toBe(true);
    expect(axis(60, -1).ok).toBe(false);
  });
});

/**
 * I-6: 窓が接するケース（`abc-touch-d16` の 2 本目）では、1 本目の窓の最終フレームが
 * 混色なので「窓の直前は純 A」は**構造的に成り立たない**。種別ではなく窓の隣接関係で
 * 免除するためのスイッチ。
 */
describe('measurePhaseAxis の requirePureBefore（I-6）', () => {
  const W = 4;
  const H = 1;
  const D = 8;
  const mix = (p: number): Buffer => solid(W, H, Math.round(255 * (1 - p)), 0, Math.round(255 * p));

  /** 窓 [4, 12) の直前フレーム（index 3）だけが混色（前の窓の最終フレーム相当）の列。 */
  const frames: Buffer[] = [];
  for (let i = 0; i < 20; i++) {
    const k = i - 4;
    frames.push(k < 0 ? (i === 3 ? mix(0.5) : mix(0)) : k >= D ? mix(1) : mix(k / D));
  }
  const base = {
    frames, windowStart: 4, windowLength: D, width: W, probe: { x: 0, y: 0 },
    modelAAt: () => mix(0), modelBAt: () => mix(1),
  };

  it('既定（true）では窓直前が純 A でないと赤', () => {
    const r = measurePhaseAxis(base);
    expect(r.pureBefore).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('requirePureBefore=false で免除できる（位相と窓直後の純 B は判定に残る）', () => {
    const r = measurePhaseAxis({ ...base, requirePureBefore: false });
    expect(r.pureBefore).toBe(false); // 観測値は落とさない（記録として残す）
    expect(r.ok).toBe(true);
    // 免除しても位相そのものは判定に残る: 1 フレームずらした列は赤のまま。
    const shifted = frames.map((_, i) => {
      const k = i - 4 - 1;
      return k < 0 ? mix(0) : k >= D ? mix(1) : mix(k / D);
    });
    expect(measurePhaseAxis({ ...base, frames: shifted, requirePureBefore: false }).ok).toBe(false);
  });
});

describe.skipIf(!ffmpeg.ok)('transitionFrameCompare（実 ffmpeg 復号）', () => {
  const bin = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';
  const W = 64;
  const H = 32;
  const FPS = 10;
  const FRAMES = 5;
  let dir = '';

  const run = (args: string[]): void => {
    execFileSync(bin, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sme-tfc-'));
    // 無損失（ffv1）で作る。画素を厳密に読み出すため符号化の丸めを排する。
    run([
      '-f', 'lavfi', '-i', `color=c=0x203040:s=${W}x${H}:r=${FPS}:d=${FRAMES / FPS}`,
      '-vf', `drawbox=x=0:y=0:w=8:h=8:color=0xFFCC00@1:t=fill`,
      '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', '-frames:v', String(FRAMES),
      '-y', join(dir, 'a.mkv'),
    ]);
    // b.mkv: a と同一内容（同じコマンド）
    run([
      '-f', 'lavfi', '-i', `color=c=0x203040:s=${W}x${H}:r=${FPS}:d=${FRAMES / FPS}`,
      '-vf', `drawbox=x=0:y=0:w=8:h=8:color=0xFFCC00@1:t=fill`,
      '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', '-frames:v', String(FRAMES),
      '-y', join(dir, 'b.mkv'),
    ]);
    // short.mkv: 1 フレーム欠落
    run([
      '-i', join(dir, 'a.mkv'), '-frames:v', String(FRAMES - 1),
      '-c:v', 'ffv1', '-y', join(dir, 'short.mkv'),
    ]);
    // pixel.mkv: フレーム2（0 起点）だけ右下に別色の点を置く
    run([
      '-i', join(dir, 'a.mkv'),
      '-vf', `drawbox=x=${W - 2}:y=${H - 2}:w=2:h=2:color=0xFF00FF@1:t=fill:enable='eq(n,2)'`,
      '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', '-y', join(dir, 'pixel.mkv'),
    ]);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('同一動画は全フレーム差ゼロ・SSIM=1', () => {
    const a = decodeRgbFrames(join(dir, 'a.mkv'), W, H);
    const b = decodeRgbFrames(join(dir, 'b.mkv'), W, H);
    expect(a).toHaveLength(FRAMES);
    const rep = compareFrameSequences(a, b, W, H);
    expect(rep.maxAbsOverall).toBe(0);
    expect(rep.minSsim).toBeCloseTo(1, 12);
  });

  it('実寸と違う width/height で呼ぶと throw する（I-4: 端数が出ない偽寸法を黙って通さない）', () => {
    // a.mkv の実寸は 64x32。32x16 と偽ると 1 フレーム分のバイト数がちょうど 1/4 になり
    // splitRgbFrames の端数チェックを素通りして「4 倍のフレーム数」が返ってしまう。
    expect(() => decodeRgbFrames(join(dir, 'a.mkv'), 32, 16)).toThrow(/実寸/);
    expect(() => decodeRgbFrames(join(dir, 'a.mkv'), 64, 8)).toThrow(/実寸/);
    expect(decodeRgbFrames(join(dir, 'a.mkv'), W, H)).toHaveLength(FRAMES);
  });

  it('1 フレーム欠落はフレーム数不一致で throw する', () => {
    const a = decodeRgbFrames(join(dir, 'a.mkv'), W, H);
    const s = decodeRgbFrames(join(dir, 'short.mkv'), W, H);
    expect(s).toHaveLength(FRAMES - 1);
    expect(() => compareFrameSequences(a, s, W, H)).toThrow(/フレーム数/);
  });

  it('1 か所だけ変えた動画は当該フレームでのみ maxAbs が非ゼロ', () => {
    const a = decodeRgbFrames(join(dir, 'a.mkv'), W, H);
    const p = decodeRgbFrames(join(dir, 'pixel.mkv'), W, H);
    const rep = compareFrameSequences(a, p, W, H);
    expect(rep.worstFrame).toBe(2);
    expect(rep.frames.map((f) => f.maxAbs > 0)).toEqual([false, false, true, false, false]);
    expect(rep.frames[2]!.diffPixels).toBeGreaterThan(0);
    expect(rep.frames[2]!.ssim).toBeLessThan(1);
  });
});
