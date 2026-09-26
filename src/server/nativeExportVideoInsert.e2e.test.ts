/**
 * サブ動画インサート（videoInserts）の実 ffmpeg 統合テスト（M4 T2）。
 *
 * 実測で確定した M4 の正典（一覧は nativeExportVideo.test.ts）に対して、
 * **合成結果の画素**で次の4軸を同時に測る（フィルタ文字列の pin は
 * nativeExportVideo.test.ts 側・ここは「その文字列が実 ffmpeg で正典どおりに動くか」）:
 *
 *  1. **正典①② 時間軸**: 窓内の各フレームに出るソースフレームが
 *     「t=(S+rate×k)/合成fps に**最も近い実在フレーム**（タイは後ろ）」であること。
 *     `playbackRate=0.7`（非整数比）を混ぜているので、**直前フレーム規則（floor）との弁別が効く**
 *     ——T1 で踏んだ「floor と round が同値で規則を弁別できていなかった」罠を繰り返さない。
 *  2. **正典④ 窓**: `[startFrame,endFrame)` 排他。境界の ±1 フレームを直接見る。
 *  3. **正典⑤ 幾何**: 内側 contain（**素材 320×120 を 320×180 へ内接**＝上下に余白が出る形）→
 *     外側 scale（中心基準）→ translate。余白が**透明**であること（黒帯で塗り潰さない）も見る。
 *  4. **正典⑦ z 順**: 窓が重なる2本は配列順で後の層が上。
 *
 * ## 物差しの検算を先に通す（T1/T2 スパイクと同じ規律）
 * サブ動画の各フレームは「左半分＝下位3bit×32・右半分＝上位3bit×32」の2ブロックで
 * **自分のフレーム番号**を持つ。合成前に素の状態で復号して全フレームの読み値が index と
 * 一致することを先に確かめる（ここが緑でなければ以降の観測は壊れた物差しの数字）。
 *
 * ## レンダ回数
 * ffmpeg 実行は **素材生成2回 + 物差し検算1回 + 合成1回**（合成レンダは1回だけ）。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { applyOverlays, videoInsertPlacement, type OverlayLayer } from './nativeExportVideo';
import { videoInsertAnimSteps } from './videoInsertAnim';
import { buildCutFilterScript, buildFastCutArgs } from './fastCutRender';
import { probeFrameCount } from './probeFrames';
import { ffprobeFromFfmpeg, resolveFfmpegBin } from './resolveFfmpeg';

const ffmpeg = resolveFfmpegBin();
if (!ffmpeg.ok && process.env['HARNESS_REQUIRE_CAPTURE_E2E'] === '1') {
  throw new Error('HARNESS_REQUIRE_CAPTURE_E2E=1 ですが ffmpeg が見つかりません（サブ動画 e2e が黙って skip されるのを防ぎます）。');
}
const FFMPEG = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';

// ---------------------------------------------------------------------------
// fixture 諸元
// ---------------------------------------------------------------------------
/** 合成解像度（= composition）。 */
const W = 320;
const H = 180;
/** 合成 fps。 */
const FPS = 30;
/** 合成の総フレーム数。 */
const TOTAL = 60;
/** ベース映像の色（0x000080）。グレーの ID ブロックと r/g で必ず区別できる。 */
const BASE_RGB = { r: 0, g: 0, b: 128 };

/**
 * サブ動画: **合成と別のアスペクト**（320×122）で contain の余白を作る。
 * 高さを 122 にしてあるのは、V2（scale=0.5）で内接後の高さが **61（奇数）** になり、
 * 余白の中心寄せが **14.5 画素**＝ちょうど半画素の割れ方になるため——`pad` の丸め方
 * （round か切り捨てか）をこの fixture が弁別する。
 */
const SUB_W = 320;
const SUB_H = 122;
/** サブ動画の fps（合成 fps と別・正典①「サブ動画自身の fps は時間軸に無関与」の形）。 */
const SUB_FPS = 60;
const SUB_FRAMES = 48;

/** サブ動画 1 本目: 窓 [10,30)・S=3・rate=0.7（非整数比＝最近傍/直前の弁別が効く）。 */
const V1 = { startFrame: 10, endFrame: 30, sourceInFrame: 3, playbackRate: 0.7 };
/** サブ動画 2 本目: 窓 [20,40)（V1 と重なる）・S=0・rate=1・scale=0.5。 */
const V2 = { startFrame: 20, endFrame: 40, sourceInFrame: 0, playbackRate: 1 };

/** ID ブロックの読み取り点（出力座標）。V1 は全画面配置・V2 は中央 50% 配置。 */
// V1: contain で素材は y=29..150 に載る（320×122 が 320×180 の中央）。
const V1_LOW = { x: 20, y: 40 };
const V1_HIGH = { x: 300, y: 40 };
/** V1 の**余白**（contain の上帯）。透明であること＝ベース色が見えること。 */
const V1_LETTERBOX = { x: 20, y: 10 };
// V2: 配置は 160×90 の矩形 (80,45)。その中に 160×61 の素材が y=60..120 で載る
// （余白 (90-61)/2=14.5 → round で 15）。
const V2_LOW = { x: 110, y: 80 };
const V2_HIGH = { x: 210, y: 80 };
/** V2 の矩形の外（左に4px）と、矩形内だが素材の外（上帯）。 */
const V2_OUTSIDE = { x: 76, y: 80 };
const V2_LETTERBOX = { x: 110, y: 55 };

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 4×4 ブロックの平均 RGB（yuv420 のクロマ半解像度・圧縮ノイズを均す）。 */
function blockAt(frames: Buffer, frame: number, x: number, y: number, size = 4): Rgb {
  const stride = W * 3;
  const frameSize = stride * H;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      const o = frame * frameSize + (y + dy) * stride + (x + dx) * 3;
      r += frames[o]!;
      g += frames[o + 1]!;
      b += frames[o + 2]!;
    }
  }
  const n = size * size;
  return { r: r / n, g: g / n, b: b / n };
}

/** ベース色（サブ動画が乗っていない）か。 */
function isBase(px: Rgb): boolean {
  return Math.abs(px.r - BASE_RGB.r) < 12 && Math.abs(px.g - BASE_RGB.g) < 12 && Math.abs(px.b - BASE_RGB.b) < 16;
}

/** ID ブロック（グレー段階 0..7 × 32）の読み値。グレーでなければ null。 */
function digitOf(px: Rgb): number | null {
  const avg = (px.r + px.g + px.b) / 3;
  if (Math.abs(px.r - avg) > 10 || Math.abs(px.g - avg) > 10 || Math.abs(px.b - avg) > 10) return null;
  const d = Math.round(avg / 32);
  if (d < 0 || d > 7) return null;
  return d;
}

/** サブ動画のソースフレーム番号（左=下位3bit・右=上位3bit）。 */
function sourceIndexOf(low: Rgb, high: Rgb): number | null {
  const l = digitOf(low);
  const h = digitOf(high);
  if (l === null || h === null) return null;
  return h * 8 + l;
}

/** 正典②: 時刻 t に最も近い実在フレーム。同値タイは後ろ（時間的に後）。 */
function canonPick(pts: readonly number[], t: number): number {
  let best = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (Math.abs(pts[i]! - t) <= Math.abs(pts[best]! - t) + 1e-9) best = i;
  }
  return best;
}

/** 正典①: t = (S + rate×k)/合成fps。**掛けてから割る**（T1 申し送り3）。 */
function expectedSource(pts: readonly number[], layer: { sourceInFrame: number; playbackRate: number }, k: number): number {
  return canonPick(pts, (layer.sourceInFrame + layer.playbackRate * k) / FPS);
}

/** **直前フレーム規則**（誤った規則）。弁別性の対照に使う。 */
function floorPick(pts: readonly number[], t: number): number {
  let best = 0;
  for (let i = 0; i < pts.length; i += 1) if (pts[i]! <= t + 1e-9) best = i;
  return best;
}

function run(args: string[]): Buffer {
  return execFileSync(FFMPEG, args, { maxBuffer: 512 * 1024 * 1024 });
}

/** 素材の実在フレームの pts（整数 pts × time_base・T2 実測1 の「物差しの訂正」に従う）。 */
function readPts(path: string): number[] {
  const probe = ffprobeFromFfmpeg(FFMPEG);
  const tbRaw = execFileSync(probe, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'csv=p=0', path,
  ]).toString().trim().split(',')[0]!;
  const [num, den] = tbRaw.split('/').map(Number);
  const out = execFileSync(probe, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts', '-of', 'csv=p=0', path,
  ]).toString().trim().split('\n');
  return out.map((line) => (Number(line.split(',')[0]) * num!) / den!);
}

describe.skipIf(!ffmpeg.ok)('nativeExport サブ動画インサート（実 ffmpeg 統合・M4 T2）', () => {
  let dir = '';
  let subPath = '';
  let outPath = '';
  let subPts: number[] = [];
  let frames: Buffer = Buffer.alloc(0);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'native-export-video-insert-e2e-'));
    subPath = join(dir, 'sub.mp4');
    outPath = join(dir, 'out.mp4');
    const mainPath = join(dir, 'main.mp4');
    const scriptPath = join(dir, 'filter.txt');

    // 1) サブ動画（各フレームに自分の番号を焼いた 320×120・60fps・48 枚）
    const raw = Buffer.alloc(SUB_W * SUB_H * 3 * SUB_FRAMES);
    for (let n = 0; n < SUB_FRAMES; n += 1) {
      const low = (n % 8) * 32;
      const high = Math.floor(n / 8) * 32;
      for (let y = 0; y < SUB_H; y += 1) {
        for (let x = 0; x < SUB_W; x += 1) {
          const v = x < SUB_W / 2 ? low : high;
          const o = n * SUB_W * SUB_H * 3 + (y * SUB_W + x) * 3;
          raw[o] = v;
          raw[o + 1] = v;
          raw[o + 2] = v;
        }
      }
    }
    const rawPath = join(dir, 'sub.rgb');
    writeFileSync(rawPath, raw);
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SUB_W}x${SUB_H}`, '-r', String(SUB_FPS), '-i', rawPath,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', subPath,
    ]);

    // 2) ベース映像（単色 + 無音）
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x000080:size=${W}x${H}:rate=${FPS}:duration=${TOTAL / FPS}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-shortest', '-pix_fmt', 'yuv420p', mainPath,
    ]);

    subPts = readPts(subPath);

    // 3) 合成（サブ動画2本・入力 index は inputIndexBase + 配列順）
    const layers: OverlayLayer[] = [
      { kind: 'video', ...V1, placement: videoInsertPlacement({ width: W, height: H }, undefined, 1) },
      { kind: 'video', ...V2, placement: videoInsertPlacement({ width: W, height: H }, undefined, 0.5) },
    ];
    const script = applyOverlays(buildCutFilterScript([{ start: 0, end: TOTAL }], FPS), layers, FPS, 1);
    writeFileSync(scriptPath, script);
    run(buildFastCutArgs({
      input: mainPath,
      filterScript: scriptPath,
      output: outPath,
      options: { resolution: 'full', quality: 'high' },
      target: { width: W, height: H },
      hardware: false,
      extraInputs: [{ path: subPath }, { path: subPath }],
    }));

    frames = run([
      '-hide_banner', '-loglevel', 'error', '-i', outPath,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
  }, 300_000);

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('物差しの検算: サブ動画を素で復号すると全 48 枚の ID ブロックが自分の index を返す', () => {
    const buf = run([
      '-hide_banner', '-loglevel', 'error', '-i', subPath,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
    const frameSize = SUB_W * SUB_H * 3;
    expect(buf.length / frameSize).toBe(SUB_FRAMES);
    const readAt = (n: number, x: number): Rgb => {
      const o = n * frameSize + (SUB_H / 2) * SUB_W * 3 + x * 3;
      return { r: buf[o]!, g: buf[o + 1]!, b: buf[o + 2]! };
    };
    const bad: number[] = [];
    for (let n = 0; n < SUB_FRAMES; n += 1) {
      if (sourceIndexOf(readAt(n, 40), readAt(n, SUB_W - 40)) !== n) bad.push(n);
    }
    expect(bad).toEqual([]);
    expect(subPts).toHaveLength(SUB_FRAMES);
  });

  it('総フレーム数が合成尺と厳密一致（サブ動画の無限クローンで尺が伸びない）', () => {
    expect(probeFrameCount(outPath)).toBe(TOTAL);
    expect(frames.length).toBe(TOTAL * W * H * 3);
  });

  it('正典④ 窓 [start,end) 排他: 境界の ±1 フレームで在席が切り替わる', () => {
    // V1 の直前/頭
    expect(isBase(blockAt(frames, V1.startFrame - 1, V1_LOW.x, V1_LOW.y))).toBe(true);
    expect(isBase(blockAt(frames, V1.startFrame, V1_LOW.x, V1_LOW.y))).toBe(false);
    // V1 の尻/直後（V2 は V1_LOW を覆わない位置なのでベースへ戻る）
    expect(isBase(blockAt(frames, V1.endFrame - 1, V1_LOW.x, V1_LOW.y))).toBe(false);
    expect(isBase(blockAt(frames, V1.endFrame, V1_LOW.x, V1_LOW.y))).toBe(true);
    // V2 の直前/頭・尻/直後
    expect(isBase(blockAt(frames, V2.startFrame - 1, V2_LOW.x, V2_LOW.y))).toBe(false); // V1 が下に居る
    expect(isBase(blockAt(frames, V2.endFrame - 1, V2_LOW.x, V2_LOW.y))).toBe(false);
    expect(isBase(blockAt(frames, V2.endFrame, V2_LOW.x, V2_LOW.y))).toBe(true);
    // 窓の外（先頭と末尾）は全てベース
    for (const f of [0, 5, 9, 45, TOTAL - 1]) {
      expect(isBase(blockAt(frames, f, V1_LOW.x, V1_LOW.y)), `frame ${f}`).toBe(true);
      expect(isBase(blockAt(frames, f, V2_LOW.x, V2_LOW.y)), `frame ${f}`).toBe(true);
    }
  });

  it('正典①② 時間軸: 窓内の全フレームで「最近傍の実在フレーム」が出る（直前規則との弁別つき）', () => {
    const observedV1: number[] = [];
    const observedV2: number[] = [];
    for (let f = V1.startFrame; f < V1.endFrame; f += 1) {
      observedV1.push(sourceIndexOf(blockAt(frames, f, V1_LOW.x, V1_LOW.y), blockAt(frames, f, V1_HIGH.x, V1_HIGH.y))!);
    }
    for (let f = V2.startFrame; f < V2.endFrame; f += 1) {
      observedV2.push(sourceIndexOf(blockAt(frames, f, V2_LOW.x, V2_LOW.y), blockAt(frames, f, V2_HIGH.x, V2_HIGH.y))!);
    }
    const canonV1 = observedV1.map((_, k) => expectedSource(subPts, V1, k));
    const canonV2 = observedV2.map((_, k) => expectedSource(subPts, V2, k));
    expect(observedV1).toEqual(canonV1);
    expect(observedV2).toEqual(canonV2);

    // 弁別性の実証: V1（rate=0.7）は最近傍と直前で**必ず食い違うフレームがある**。
    const floorV1 = canonV1.map((_, k) => floorPick(subPts, (V1.sourceInFrame + V1.playbackRate * k) / FPS));
    const discriminating = canonV1.filter((v, i) => v !== floorV1[i]).length;
    expect(discriminating).toBeGreaterThan(0);
    expect(observedV1).not.toEqual(floorV1);
  });

  /** 1画素単位の bbox（サブ動画が載っている領域）。中心の行/列を走査する。 */
  function contentBbox(frame: number): { top: number; bottom: number; left: number; right: number } {
    const stride = W * 3;
    const frameSize = stride * H;
    /**
     * 「サブ動画の画素」の判定は**グレーであること**で行う（ベース色との単純比較にしない）。
     * 境界の1行は圧縮とクロマ半解像度でベースとサブが混ざった色になり、「ベースでない」だけの
     * 判定だと bbox が1画素太る（実測: 期待 60..120 に対し 60..121）。混色は無彩色にならないので
     * グレー判定で落ちる。
     */
    const isSub = (x: number, y: number): boolean => {
      const o = frame * frameSize + y * stride + x * 3;
      const px = { r: frames[o]!, g: frames[o + 1]!, b: frames[o + 2]! };
      return !isBase(px) && digitOf(px) !== null;
    };
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < H; y += 1) {
      if (isSub(W / 2 - 30, y)) {
        if (top < 0) top = y;
        bottom = y;
      }
    }
    let left = -1;
    let right = -1;
    const midY = top < 0 ? Math.floor(H / 2) : Math.floor((top + bottom) / 2);
    for (let x = 0; x < W; x += 1) {
      if (isSub(x, midY)) {
        if (left < 0) left = x;
        right = x;
      }
    }
    return { top, bottom, left, right };
  }

  it('正典⑤ 幾何: 配置矩形と contain の余白が**画素単位**で予測どおり（scale=0.5 中央・1画素ずれたら赤）', () => {
    // V2: placement = 160×90 @ (80,45)。素材 320×122 を内接させると 160×61 が
    // 矩形の中央（余白 14.5 → y=45+15=60）に載る。左右は矩形いっぱい。
    // bottom は素材末端の1行（y=120）が境界の混色でグレー判定から外れるため 119 まで。
    //
    // **M-2（中間レビュー）による訂正**: ここには「切り捨て（14）にすると y=59 になり赤」と
    // 書いていたが**実測と一致しない**——`pad` の `round()` を外しても（`(oh-ih)/2` の素の式）
    // この幾何 e2e は緑のままで、赤になるのは `nativeExportVideo.test.ts` の**文字列全文 pin**
    // だけだった（ffmpeg 側の式評価が同じ側へ倒すため）。
    // **半画素の正典タイブレークは現状「文字列 pin のみ」で守られている**。実際の丸め方は
    // 受入 A（Remotion 基準線との突合・半画素になる配置を複数入れる）で測る
    // （計画書 T2 コントローラ裁定2 と同じ申し送り）。
    expect(contentBbox(35)).toEqual({ top: 60, bottom: 119, left: 80, right: 239 });
    // V1（全画面配置）: 320×122 を 320×180 へ内接 → 幾何は y=29..150。上下端の各1行は
    // 余白との混色でグレー判定から外れるため、観測 bbox は 30..149（左右は端まで残る）。
    expect(contentBbox(15)).toEqual({ top: 30, bottom: 149, left: 0, right: 319 });
    // 余白はベースが透けて見える（黒帯で塗り潰していない）
    expect(isBase(blockAt(frames, 35, V2_LETTERBOX.x, V2_LETTERBOX.y))).toBe(true);
    expect(isBase(blockAt(frames, 35, V2_OUTSIDE.x, V2_OUTSIDE.y))).toBe(true);
    expect(isBase(blockAt(frames, 15, V1_LETTERBOX.x, V1_LETTERBOX.y))).toBe(true);
  });

  it('正典⑦ z 順: 窓が重なる区間で後の層（V2）が上・下の層（V1）は矩形の外に残る', () => {
    for (let f = V2.startFrame; f < V1.endFrame; f += 1) {
      const v2 = sourceIndexOf(blockAt(frames, f, V2_LOW.x, V2_LOW.y), blockAt(frames, f, V2_HIGH.x, V2_HIGH.y));
      const v1 = sourceIndexOf(blockAt(frames, f, V1_LOW.x, V1_LOW.y), blockAt(frames, f, V1_HIGH.x, V1_HIGH.y));
      expect(v2, `frame ${f} の V2`).toBe(expectedSource(subPts, V2, f - V2.startFrame));
      expect(v1, `frame ${f} の V1`).toBe(expectedSource(subPts, V1, f - V1.startFrame));
      // 重なり区間では2本のソースフレームが実際に違う（同値なら z 順を弁別できていない）
      expect(v1).not.toBe(v2);
    }
  });

  /**
   * 正典② の**同値タイ（タイは後ろ）**を測る VFR ケース。
   *
   * CFR の等間隔サブ動画では中点がスロット境界にちょうど載らないため、canon 写像の
   * `-1e-6`（倍精度で中点が `20.000000000000004` になり ceil が跳ねるのを防ぐ項）が
   * **一度も効かない**——実測でそれを確認したので、フレームを間引いた VFR 素材で
   * 「厳密な同値タイ」を作り、この軸を発火させる（#200: 緩和・補正項は発火 fixture とセット）。
   */
  it('正典② 同値タイは後ろ（フレームを間引いた VFR 素材・タイが実在することも同時に検算）', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'native-export-video-insert-vfr-'));
    try {
      const vfrPath = join(dir2, 'sub-vfr.mp4');
      const mainPath = join(dir2, 'main.mp4');
      const out2 = join(dir2, 'out.mp4');
      const scriptPath = join(dir2, 'filter.txt');
      // n%7==3 と n%5==2 のフレームを落とし、**残ったフレームの PTS は 1/60 グリッドのまま**にする
      // （実データの画面収録と同じ壊れ方・T1(b) の fixture 流儀）。
      run([
        '-y', '-hide_banner', '-loglevel', 'error', '-i', subPath,
        '-vf', "select='not(eq(mod(n\\,7)\\,3)+eq(mod(n\\,5)\\,2))',setpts=PTS",
        '-fps_mode', 'passthrough', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', vfrPath,
      ]);
      const vfrPts = readPts(vfrPath);
      expect(vfrPts.length).toBeLessThan(SUB_FRAMES); // 間引きが効いている

      // S=1: この素材の刻みだと **中点がスロット境界に厳密に載る組が2つ**でき、canon 写像の
      // `-1e-6` 項が無ければ ceil が跳ねて別のフレームが出る（＝この軸が発火する S を選んでいる）。
      const window = { startFrame: 0, endFrame: 30, sourceInFrame: 1, playbackRate: 1 };
      // **タイが実在すること**を先に検算する（タイが1つも無ければこのテストは
      // 「タイは後ろ」を弁別しておらず、-1e-6 の軸も発火しない）。
      let ties = 0;
      for (let k = 0; k < window.endFrame - window.startFrame; k += 1) {
        const t = (window.sourceInFrame + window.playbackRate * k) / FPS;
        const d = vfrPts.map((p) => Math.abs(p - t)).sort((a, b) => a - b);
        if (Math.abs(d[0]! - d[1]!) < 1e-9) ties += 1;
      }
      expect(ties).toBeGreaterThan(0);

      run([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x000080:size=${W}x${H}:rate=${FPS}:duration=${30 / FPS}`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-shortest', '-pix_fmt', 'yuv420p', mainPath,
      ]);
      const layer: OverlayLayer = {
        kind: 'video',
        ...window,
        placement: videoInsertPlacement({ width: W, height: H }, undefined, 1),
      };
      writeFileSync(scriptPath, applyOverlays(buildCutFilterScript([{ start: 0, end: 30 }], FPS), [layer], FPS, 1));
      run(buildFastCutArgs({
        input: mainPath,
        filterScript: scriptPath,
        output: out2,
        options: { resolution: 'full', quality: 'high' },
        target: { width: W, height: H },
        hardware: false,
        extraInputs: [{ path: vfrPath }],
      }));
      const buf = run(['-hide_banner', '-loglevel', 'error', '-i', out2, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      expect(probeFrameCount(out2)).toBe(30);

      // ID ブロックは元のフレーム番号を保つので、VFR でも「どのソースフレームが出たか」が読める。
      // 期待値は**実在フレームの pts**（間引き後）に対する正典②（最近傍・タイは後ろ）。
      const observed: Array<number | null> = [];
      const canon: number[] = [];
      for (let k = 0; k < 30; k += 1) {
        observed.push(sourceIndexOf(blockAt(buf, k, V1_LOW.x, V1_LOW.y), blockAt(buf, k, V1_HIGH.x, V1_HIGH.y)));
        const t = (window.sourceInFrame + window.playbackRate * k) / FPS;
        // canonPick は「実在フレームの並び順」を返すので、元のフレーム番号へ引き直す。
        canon.push(canonPick(vfrPts, t));
      }
      // 間引き後の並び順 → 元のフレーム番号（ID ブロックの値）へ写す表。
      const originalOf: number[] = [];
      for (let n = 0; n < SUB_FRAMES; n += 1) {
        if (!(n % 7 === 3 || n % 5 === 2)) originalOf.push(n);
      }
      expect(originalOf).toHaveLength(vfrPts.length);
      expect(observed).toEqual(canon.map((i) => originalOf[i]!));
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 300_000);

  /**
   * **I-1 の crop が「幾何を1画素も変えない」ことを実 ffmpeg で実証する。**
   *
   * crop は純粋な省コスト（overlay が捨てる画素を作らない）なので、**crop 有り／無しで
   * 出力が 1 バイトも変わらない**のが正しい。文字列 pin だけだと「crop の切り出し位置と
   * overlay の座標付け替えが噛み合っているか」を自分の実装と突き合わせているに過ぎず、
   * 両方を同じ方向に間違えると緑のまま通る——そこでここでは**同じレイヤを crop 有り／無しで
   * 2 回焼いて画素を突合**する（オフセットを 1 でも間違えれば必ず割れる）。
   *
   * 2 種類の crop を同時に掛ける: ①`scale=2`（合成解像度を超える中間フレーム）
   * ②画面外へはみ出す配置（部分的な crop）。
   */
  it('I-1 crop: 可視領域の切り出しは crop 無しの出力と**バイト完全一致**（scale>1 と画面外はみ出しの2種）', () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'native-export-video-insert-crop-'));
    try {
      const mainPath = join(dir2, 'main.mp4');
      const N = 20;
      run([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x000080:size=${W}x${H}:rate=${FPS}:duration=${N / FPS}`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-shortest', '-pix_fmt', 'yuv420p', mainPath,
      ]);
      // ① scale=2 → 640×360 @ (-160,-90)：可視は中央 320×180
      const big = videoInsertPlacement({ width: W, height: H }, undefined, 2);
      // ② pos(0.5,-0.5) scale=1 → 320×180 @ (80,-45)：右と上へはみ出す
      const off = videoInsertPlacement({ width: W, height: H }, { x: 0.5, y: -0.5 }, 1);
      // 前提の検算: そもそも crop が付いていなければこのテストは何も弁別していない。
      expect(big.crop).toEqual({ x: 160, y: 90, width: W, height: H });
      expect(off.crop).toEqual({ x: 0, y: 45, width: 240, height: 135 });

      let tag = 0;
      const render = (placements: readonly (typeof big)[]): Buffer => {
        tag += 1;
        const out2 = join(dir2, `out-${tag}.mp4`);
        const scriptPath = join(dir2, `filter-${tag}.txt`);
        const layers: OverlayLayer[] = placements.map((placement) => ({
          kind: 'video',
          startFrame: 0,
          endFrame: N,
          sourceInFrame: 0,
          playbackRate: 1,
          placement,
        }));
        writeFileSync(scriptPath, applyOverlays(buildCutFilterScript([{ start: 0, end: N }], FPS), layers, FPS, 1));
        run(buildFastCutArgs({
          input: mainPath,
          filterScript: scriptPath,
          output: out2,
          options: { resolution: 'full', quality: 'high' },
          target: { width: W, height: H },
          hardware: false,
          extraInputs: [{ path: subPath }, { path: subPath }],
        }));
        return run(['-hide_banner', '-loglevel', 'error', '-i', out2, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      };

      const withCrop = render([big, off]);
      const noCrop = render([
        { width: big.width, height: big.height, x: big.x, y: big.y },
        { width: off.width, height: off.height, x: off.x, y: off.y },
      ]);
      expect(withCrop.length).toBe(N * W * H * 3);
      expect(noCrop.length).toBe(withCrop.length);
      // 空比較封じ: サブ動画が実際に載っている（全面ベース色ではない）ことを先に検算。
      let nonBase = 0;
      for (let f = 0; f < N; f += 1) if (!isBase(blockAt(withCrop, f, 40, 40))) nonBase += 1;
      expect(nonBase).toBe(N);
      expect(withCrop.equals(noCrop)).toBe(true);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 300_000);

  it('正典③ ソース末尾超過は最終フレームへクランプ（尺の足りないサブ動画で消えない）', () => {
    // 窓 [0,20)・rate=8 → k=12 で t=3.2s（サブ動画の実尺 0.8s）を超える。
    const dir2 = mkdtempSync(join(tmpdir(), 'native-export-video-insert-clamp-'));
    try {
      const mainPath = join(dir2, 'main.mp4');
      const out2 = join(dir2, 'out.mp4');
      const scriptPath = join(dir2, 'filter.txt');
      run([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=0x000080:size=${W}x${H}:rate=${FPS}:duration=${20 / FPS}`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-shortest', '-pix_fmt', 'yuv420p', mainPath,
      ]);
      const layer: OverlayLayer = {
        kind: 'video',
        startFrame: 0,
        endFrame: 20,
        sourceInFrame: 0,
        playbackRate: 8,
        placement: videoInsertPlacement({ width: W, height: H }, undefined, 1),
      };
      writeFileSync(scriptPath, applyOverlays(buildCutFilterScript([{ start: 0, end: 20 }], FPS), [layer], FPS, 1));
      run(buildFastCutArgs({
        input: mainPath,
        filterScript: scriptPath,
        output: out2,
        options: { resolution: 'full', quality: 'high' },
        target: { width: W, height: H },
        hardware: false,
        extraInputs: [{ path: subPath }],
      }));
      const buf = run(['-hide_banner', '-loglevel', 'error', '-i', out2, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      expect(probeFrameCount(out2)).toBe(20);
      const readIdx = (f: number): number | null =>
        sourceIndexOf(blockAt(buf, f, V1_LOW.x, V1_LOW.y), blockAt(buf, f, V1_HIGH.x, V1_HIGH.y));
      // 尺内（k=0..5 は t=0..1.6s のうち 0.8s 未満の範囲）は最近傍、尺を超えたら最終フレーム 47 に固定
      expect(readIdx(0)).toBe(0);
      for (let f = 15; f < 20; f += 1) {
        expect(readIdx(f), `frame ${f}`).toBe(SUB_FRAMES - 1);
      }
      // 透明化・消失ではない（ベース色になっていないこと）
      expect(isBase(blockAt(buf, 19, V1_LOW.x, V1_LOW.y))).toBe(false);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 300_000);
});

/**
 * **段数が上限近くの filter graph が実 ffmpeg を通るか**（M4 T4・H-182）。
 *
 * T4 は出入りアニメを「窓内のフレーム区間ごとの静的レイヤ」へ割るので、filter graph の
 * ノード数は段数（最大 `MAX_VIDEO_INSERT_ANIM_STEPS` = 64）に比例して増える。**8 段の
 * fixture だけで緑にすると「実データ規模では ffmpeg が受け付けない」を見逃す**——
 * `split` の出力数・`trim`/`overlay` の連結長は自前評価では確かめられない外部エンジンの制限。
 * ここは UI の上限（enter 30fr + exit 30fr）そのままの **59 段**を実 ffmpeg へ流す。
 *
 * サブ動画は**単色白**にしてある。合成後の R チャンネルがそのまま `255 × 不透明度`
 * （下地は 0x000080＝R=0）になるので、**段ごとの alpha が正しく効いているかを 1 画素で読める**
 * ——ID ブロック入りの素材だとフレームごとに素材色が変わり、不透明度と混ざって読めない。
 */
describe.skipIf(!ffmpeg.ok)('nativeExport サブ動画: 段数上限近くの出入りアニメ（M4 T4・H-182）', () => {
  const TOTAL2 = 80;
  const WIN = { startFrame: 5, endFrame: 75 };
  const D2 = WIN.endFrame - WIN.startFrame; // 70
  const ANIM = 30; // UI スライダの上限
  let dir2 = '';
  let frames2: Buffer = Buffer.alloc(0);
  let steps: ReturnType<typeof videoInsertAnimSteps>;

  beforeAll(() => {
    dir2 = mkdtempSync(join(tmpdir(), 'native-export-video-insert-anim-'));
    const subPath2 = join(dir2, 'sub-white.mp4');
    const mainPath2 = join(dir2, 'main.mp4');
    const outPath2 = join(dir2, 'out.mp4');
    const scriptPath2 = join(dir2, 'filter.txt');
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=white:size=${W}x${H}:rate=${FPS}:duration=${D2 / FPS + 1}`,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', subPath2,
    ]);
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x000080:size=${W}x${H}:rate=${FPS}:duration=${TOTAL2 / FPS}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-shortest', '-pix_fmt', 'yuv420p', mainPath2,
    ]);
    steps = videoInsertAnimSteps(
      { width: W, height: H }, undefined, 1, D2,
      { kind: 'fade', frames: ANIM }, { kind: 'fade', frames: ANIM },
    );
    const layer: OverlayLayer = {
      kind: 'video',
      ...WIN,
      sourceInFrame: 0,
      playbackRate: 1,
      placement: videoInsertPlacement({ width: W, height: H }, undefined, 1),
      ...(steps === undefined ? {} : { animSteps: steps }),
    };
    const script = applyOverlays(buildCutFilterScript([{ start: 0, end: TOTAL2 }], FPS), [layer], FPS, 1);
    writeFileSync(scriptPath2, script);
    run(buildFastCutArgs({
      input: mainPath2,
      filterScript: scriptPath2,
      output: outPath2,
      options: { resolution: 'full', quality: 'high' },
      target: { width: W, height: H },
      hardware: false,
      extraInputs: [{ path: subPath2 }],
    }));
    frames2 = run([
      '-hide_banner', '-loglevel', 'error', '-i', outPath2,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
  }, 300_000);

  afterAll(() => {
    if (dir2 !== '') rmSync(dir2, { recursive: true, force: true });
  });

  it('段数が 59（UI 上限の enter30+exit30）でも filter graph が通り、総フレーム数が変わらない', () => {
    // 段数そのものを実値で押さえる（fixture が「実は 8 段」に縮んでいたら赤）。
    expect(steps).toBeDefined();
    expect(steps!.length).toBe(ANIM - 1 + 1 + (ANIM - 1)); // 29 + 平坦部 + 29
    expect(frames2.length).toBe(TOTAL2 * W * H * 3);
  });

  it('全 59 段の alpha が正典どおり（R チャンネル = 255 × 不透明度・単調に上がって下がる）', () => {
    const alphaAt = (frame: number): number => blockAt(frames2, frame, W / 2 - 8, H / 2 - 8, 8).r / 255;
    const observed: number[] = [];
    for (let k = 0; k < D2; k += 1) observed.push(alphaAt(WIN.startFrame + k));
    // 正典の期待値（step 列そのものではなく `videoInsertAnimSampleAt` の値と突き合わせる）。
    let compared = 0;
    let worst = 0;
    for (const s of steps!) {
      for (let k = s.kStart; k < s.kEnd; k += 1) {
        worst = Math.max(worst, Math.abs(observed[k]! - s.opacity));
        compared += 1;
      }
    }
    expect(compared).toBe(D2 - 1); // k=0 は opacity 0 で描かれない（1 段も落としていない）
    // 許容 0.02（≒5/255）: 単色 fixture なので誤差は yuv420p の量子化だけ。
    expect(worst, `alpha の最大差 ${worst}`).toBeLessThanOrEqual(0.02);
    // k=0 は描かれない＝下地のまま。
    expect(observed[0]).toBeLessThanOrEqual(0.02);
    // 弁別: 立ち上がり・平坦・立ち下がりが実際に存在する（平坦なカーブを測って緑になっていない）。
    expect(observed[1]!).toBeLessThan(observed[10]!);
    expect(observed[10]!).toBeLessThan(observed[29]!);
    expect(observed[35]!).toBeGreaterThan(0.98);
    expect(observed[69]!).toBeLessThan(observed[50]!);
  });
});
