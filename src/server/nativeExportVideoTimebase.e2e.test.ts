/**
 * canon 写像の **PTS 量子化**の回帰（M4 受入 F・実プロジェクト `01_skill-hanbai` で露見）。
 *
 * ## 何を守るテストか
 * `videoSourceChain` の `setpts` は、各ソースフレームを窓内相対フレーム `k` の**スロット**へ置く。
 * そのとき書く PTS を**スロットの境界**（`スロット/fps/TB`）にすると、倍精度の丸め誤差が
 * そのまま**スロット 1 つ分のずれ**になり、後段 `fps=…:round=down` の floor が 1 つ下の
 * スロットへ落とす＝窓の内容が丸ごと 1 コマ早く出る。
 *
 * 誤りは 2 段階で見つかった（どちらもこのファイルが守る）:
 *  1. **整数 fps**: `スロット/fps/TB` が整数をわずかに下回り（実測 3384 → `3383.9999999995`）、
 *     ffmpeg の整数化（切り捨て）で 1 タイムベース単位失われる。→ `round()` で解決。
 *  2. **非整数 fps**: `videoConfig.ts` の `FPS` は `59.94` という**10 進リテラル**
 *     （`60000/1001` ではない）。理想 pts `スロット × 1000000/999` は 999 スロットに 1 回しか
 *     整数にならないので、`round()` しても ±0.5 単位の誤差が残り、その半分で floor が落ちる。
 *     → **`+0.5` でスロットの中心へ置く**ことで解決（許容が ±半スロットになる）。
 *
 * **一次修正のテストが二次バグを見逃した理由**（申し送り・2026-09-04）: 当初このテストは
 * 59.94 を `60000/1001` でモデル化していた。その値なら周期がちょうど 1001 タイムベースになるので
 * `round()` で足りてしまう。**製品が式へ埋めるのは 10 進の `59.94`** なので、テストは
 * 製品と別の数を測っていた。以後、fps は**製品が持つのと同じ 10 進リテラル**で測る。
 *
 * ## 主軸は**タイムスタンプ**（画素ではない）
 * 1 コマずれが**画に出るのは内容が動くフレームだけ**なので、画素を主軸にすると弁別性が
 * 素材の性質に依存する。`setpts` が書く pts は**内容に一切依存しない**ので全フレームを弁別できる。
 * 主軸は「出力 pts が入るスロット（= 後段 `fps=…:round=down` が選ぶスロット）が、
 * JS 側で独立に再導出した canon のスロットと一致すること」。画素比較は補助軸に落とす。
 *
 * ## time_base × 合成 fps を複数回す（**盲点も一緒に測る**）
 * 399 スロット中、**PTS の置き方**ごとに「floor が別のスロットへ落とす」数（`misassigned` が
 * 毎回計算して pin する）:
 *
 * | 組み合わせ | 修正なし（切り捨て） | round(境界)＝一次修正 | **round(中心)＝現行** |
 * |---|---|---|---|
 * | 1/15360 × 30fps（既存 fixture 全部） | 4 | 0 | 0 |
 * | 1/90000 × 30fps | 122 | 0 | 0 |
 * | 1/600 × 25fps（実素材） | 150 | 0 | 0 |
 * | 1/60000 × 59.94fps（DJI 素材） | **398** | **398** | **0** |
 * | 1/600 × 59.94fps | 398 | 199 | 0 |
 * | 1/90000 × 59.94fps | 398 | 198 | 0 |
 *
 * **1/15360 × 30fps は 0〜4 個の盲点**——最初のずれるスロットが 123 で、既存の窓
 * （受入 A コーパス [20,60)・T2 [10,30)・総尺 80）はそこまで届かない。だから既存テストは
 * 全部緑だった。本ファイルはこの盲点も「露見しないことの確認」として常設する。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyOverlays,
  canonTimeBaseDen,
  canonTimeBaseMultiplier,
  videoInsertPlacement,
  type OverlayLayer,
} from './nativeExportVideo';
import { buildCutFilterScript, buildFastCutArgs } from './fastCutRender';
import { probeFrameCount } from './probeFrames';
import { ffprobeFromFfmpeg, resolveFfmpegBin } from './resolveFfmpeg';

const ffmpeg = resolveFfmpegBin();
if (!ffmpeg.ok && process.env['HARNESS_REQUIRE_CAPTURE_E2E'] === '1') {
  throw new Error(
    'HARNESS_REQUIRE_CAPTURE_E2E=1 ですが ffmpeg が見つかりません（PTS 量子化の回帰 e2e が黙って skip されるのを防ぎます）。',
  );
}
const FFMPEG = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';

/**
 * 59.94fps。**製品（`videoConfig.ts` の `FPS`）と同じ 10 進リテラル**で持つ。
 * `60000/1001` でモデル化すると周期が整数になってしまい、製品と別の数を測ることになる。
 */
const FPS_5994 = 59.94;

function run(args: string[]): Buffer {
  return execFileSync(FFMPEG, args, { maxBuffer: 512 * 1024 * 1024 });
}

// ---------------------------------------------------------------------------
// 決定的な物差し（ffmpeg 不要・整数演算で厳密に）
// ---------------------------------------------------------------------------

/** fps を 1/100 単位の整数にする（25 / 30 / 59.94 のいずれも整数になる）。 */
function fpsHundredths(fps: number): number {
  const n = Math.round(fps * 100);
  if (Math.abs(fps * 100 - n) > 1e-9) throw new Error(`fps が 1/100 の格子に載っていない（${fps}）`);
  return n;
}

/**
 * 後段 `fps=…:round=down` がこの pts をどのスロットへ入れるか。
 *
 * `fps` フィルタは fps 文字列を有理数（`59.94` → 5994/100）として解釈し、
 * `floor(pts × time_base × fps)` でスロットを決める。**整数演算で厳密に**再現する。
 */
function slotOfPts(pts: number, den: number, fps: number): number {
  return Math.floor((pts * fpsHundredths(fps)) / (den * 100));
}

/** PTS の置き方 3 種（`none` = 修正前・`boundary` = 一次修正・`center` = 現行）。 */
const PLACEMENTS = {
  none: (k: number, den: number, fps: number): number => Math.trunc(k / fps / (1 / den)),
  boundary: (k: number, den: number, fps: number): number => Math.round(k / fps / (1 / den)),
  center: (k: number, den: number, fps: number): number => Math.round((k + 0.5) / fps / (1 / den)),
} as const;

/** スロット 0..slots-1 のうち、その置き方だと floor が**別のスロット**へ落とす数。 */
function misassigned(den: number, fps: number, slots: number, how: keyof typeof PLACEMENTS): number {
  let n = 0;
  for (let k = 0; k < slots; k += 1) if (slotOfPts(PLACEMENTS[how](k, den, fps), den, fps) !== k) n += 1;
  return n;
}

/**
 * 正典①②③ を**独立に再導出**して「ソースフレーム i が載るスロット」を返す（画を介さない）。
 *
 * canon 写像の定義そのまま: 直前フレームとの**中点**が、窓内相対時間で何スロット目に入るか
 * （＝自分が最近傍になる最初のスロット）。窓より前は slot 0 へ潰す。
 */
function canonSlots(pts: readonly number[], s: number, rate: number, fps: number): number[] {
  return pts.map((t, i) => {
    if (i === 0) return 0;
    const mid = (t + pts[i - 1]!) / 2;
    return Math.max(0, Math.ceil(((mid - s / fps) / rate) * fps - 1e-6));
  });
}

// ---------------------------------------------------------------------------
// ffmpeg 側の物差し
// ---------------------------------------------------------------------------

/** 製品が組む canon 写像から `setpts='…'` の 1 段だけを取り出す（式を手写ししない）。 */
function canonSetpts(layer: { startFrame: number; endFrame: number; sourceInFrame: number; playbackRate: number; timeBaseDen?: number }, fps: number): string {
  const layers: OverlayLayer[] = [
    { kind: 'video', ...layer, placement: videoInsertPlacement({ width: 320, height: 180 }, undefined, 1) },
  ];
  const script = applyOverlays(buildCutFilterScript([{ start: 0, end: 40 }], fps), layers, fps, 1);
  // settb（素材 time_base が粗いときだけ立つ・I-1）ごと取り出す。式は手写ししない。
  const m = /\]((?:settb=[^,]+,)?)tpad=[^,]+,(setpts='[^']*')/.exec(script);
  if (m === null) throw new Error(`製品のスクリプトから canon の setpts を取り出せません:\n${script}`);
  return `${m[1]!}${m[2]!}`;
}

/** 素材の実在フレームの pts（**整数タイムベース単位**）。 */
function readPtsInt(path: string): number[] {
  return execFileSync(ffprobeFromFfmpeg(FFMPEG), [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts', '-of', 'csv=p=0', path,
  ]).toString().trim().split('\n').map((line) => Number(line.split(',')[0]));
}

function readTimeBaseDen(path: string): number {
  const tb = execFileSync(ffprobeFromFfmpeg(FFMPEG), [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=time_base', '-of', 'csv=p=0', path,
  ]).toString().trim().split(',')[0]!;
  const [num, den] = tb.split('/').map(Number);
  if (num !== 1 || !Number.isFinite(den)) throw new Error(`time_base が 1/N でない（${tb}）`);
  return den!;
}

/**
 * canon 写像の `setpts` を実 ffmpeg に通し、**出力 pts をタイムベース単位で**読む。
 *
 * `showinfo` は当該リンクの time_base（= 素材の time_base。`setpts` は tb を変えない）で
 * pts を出すので、そのままスロット判定に使える。画素は 1 つも介さない。
 */
function readCanonOutPts(src: string, setpts: string): number[] {
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'info', '-i', src, '-fps_mode', 'passthrough',
      '-vf', `${setpts},showinfo`, '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`showinfo の ffmpeg が失敗（status ${String(r.status)}）:\n${r.stderr.slice(-2000)}`);
  const out: number[] = [];
  for (const line of r.stderr.split('\n')) {
    const m = /Parsed_showinfo.* n: *\d+ +pts: *(-?\d+)/.exec(line);
    if (m !== null) out.push(Number(m[1]));
  }
  if (out.length === 0) throw new Error(`showinfo から pts を 1 件も読めません:\n${r.stderr.slice(-2000)}`);
  return out;
}

// ---------------------------------------------------------------------------
// fixture 諸元
// ---------------------------------------------------------------------------

/**
 * pts 主軸で回す組み合わせ。`exposes` は「**この組み合わせがどの誤りを発火させるか**」:
 *  - `'none'`: 修正なし（切り捨て）でだけ赤。`round(境界)` で足りる
 *  - `'boundary'`: `round(境界)` でも赤＝**二次バグの発火 fixture**（非整数 fps）
 *  - `'never'`: どの置き方でも赤にならない＝**盲点**（既存 fixture がこれ）
 */
const COMBOS: readonly {
  den: number;
  fps: number;
  /** 素材の fps（既定 60）。**time_base で表せる刻み**にすること（1/30 の素材を 60fps で焼くと pts が衝突する）。 */
  srcFps?: number;
  /** 素材のフレーム数（既定 128）。 */
  frames?: number;
  label: string;
  /**
   * **素材の time_base をそのまま使った場合**（＝ settb を挟まない場合）に、観測範囲でどの置き方が
   * 誤割当を出すか。`center` が true の行が **I-1 の端 fixture**（現行の中心置きでも足りない側）。
   */
  raw: { none: boolean; boundary: boolean; center: boolean };
  note: string;
}[] = [
  { den: 600, fps: 25, label: '1/600 × 25fps', raw: { none: true, boundary: false, center: false }, note: '受入 F の実素材（画面収録 mp4）' },
  { den: 90000, fps: 30, label: '1/90000 × 30fps', raw: { none: true, boundary: false, center: false }, note: '実素材で最多の time_base' },
  { den: 60000, fps: FPS_5994, label: '1/60000 × 59.94fps', raw: { none: true, boundary: true, center: false }, note: 'DJI 素材・**二次バグの発火 fixture**' },
  { den: 600, fps: FPS_5994, label: '1/600 × 59.94fps', raw: { none: true, boundary: true, center: false }, note: '画面収録 × 非整数 fps' },
  { den: 15360, fps: 30, label: '1/15360 × 30fps', raw: { none: false, boundary: false, center: false }, note: '**既存の合成 fixture 全部**（盲点）' },
  /**
   * **パラメータの端（I-1）**——「なぜ端を測るのか」: 中心置きの許容は `den/(2×fps)` タイムベース単位で、
   * den が合成 fps に近づくほど 0 に近づく。**許容幅がゼロに近づく側が設計限界**なので、
   * 素材 time_base が粗い側（den ≲ fps）を測らないと、写像が全フレーム 1 スロットずれても緑のままになる。
   */
  { den: 30, fps: 30, srcFps: 30, frames: 64, label: '1/30 × 30fps（端）', raw: { none: false, boundary: false, center: true }, note: '**I-1 の端 fixture**・den = 合成 fps（許容 0.5 単位）' },
  { den: 50, fps: FPS_5994, srcFps: 50, frames: 64, label: '1/50 × 59.94fps（端）', raw: { none: true, boundary: true, center: true }, note: '**I-1 の端 fixture**・den < 合成 fps（非整数 fps との積）' },
];

/** pts 主軸の素材（画素を見ないので小さくてよい）。既定 60fps・128 枚（端 fixture だけ COMBOS が上書き）。 */
const PTS_SRC = { width: 64, height: 36, fps: 60, frames: 128 } as const;

/** 素材ファイルの識別子（同じ諸元なら 1 本を使い回す）。 */
function srcKeyOf(c: { den: number; srcFps?: number; frames?: number }): string {
  return `${c.den}_${c.srcFps ?? PTS_SRC.fps}_${c.frames ?? PTS_SRC.frames}`;
}
/** 窓・S・rate。 */
const LAYER = { startFrame: 10, endFrame: 40, sourceInFrame: 0, playbackRate: 1 } as const;

describe.skipIf(!ffmpeg.ok)('canon 写像の PTS 量子化（受入 F の回帰・主軸はタイムスタンプ）', () => {
  let dir = '';
  const srcOf = new Map<string, string>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'native-export-video-timebase-'));
    for (const c of COMBOS) {
      const key = srcKeyOf(c);
      if (srcOf.has(key)) continue;
      const srcFps = c.srcFps ?? PTS_SRC.fps;
      const frames = c.frames ?? PTS_SRC.frames;
      const p = join(dir, `src-${key}.mp4`);
      run([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i',
        `testsrc2=size=${PTS_SRC.width}x${PTS_SRC.height}:rate=${srcFps}:duration=${frames / srcFps}`,
        '-c:v', 'libx264', '-crf', '30', '-pix_fmt', 'yuv420p', '-an',
        '-frames:v', String(frames), '-video_track_timescale', String(c.den), p,
      ]);
      srcOf.set(key, p);
    }
  }, 300_000);

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('置き方 × 組み合わせの pin: 399 スロット中の誤割当数（中心置きだけが全組み合わせで 0）', () => {
    const rows = ([[15360, 30], [90000, 30], [90000, 25], [60000, 30], [600, 25], [600, 30],
      [60000, FPS_5994], [600, FPS_5994], [90000, FPS_5994]] as const)
      .map(([den, fps]) => [
        `1/${den} x ${fps}`,
        [misassigned(den, fps, 399, 'none'), misassigned(den, fps, 399, 'boundary'), misassigned(den, fps, 399, 'center')],
      ] as const);
    expect(Object.fromEntries(rows)).toEqual({
      // [修正なし（切り捨て）, round(境界)＝一次修正, round(中心)＝現行]
      '1/15360 x 30': [4, 0, 0],
      '1/90000 x 30': [122, 0, 0],
      '1/90000 x 25': [106, 0, 0],
      '1/60000 x 30': [122, 0, 0],
      '1/600 x 25': [150, 0, 0],
      '1/600 x 30': [168, 0, 0],
      // **非整数 fps は `round(境界)` では直らない**（10 進 59.94 だと理想 pts がほぼ常に非整数）。
      '1/60000 x 59.94': [398, 398, 0],
      '1/600 x 59.94': [398, 199, 0],
      '1/90000 x 59.94': [398, 198, 0],
    });
    // 既存テストが全部緑だった理由: 1/15360 × 30fps で最初にずれるのはスロット 123。
    // 既存の窓（受入 A コーパスは総尺 80・T2 は 30）はそこまで届かない。
    expect(misassigned(15360, 30, 80, 'none')).toBe(0);
    // 逆に、コーパスが fps=25 だったなら 0..79 に 64 件あり検出できていた。
    expect(misassigned(15360, 25, 80, 'none')).toBe(64);
  });

  /**
   * **素材 time_base が粗い側（I-1）**。中心置きの許容は `den/(2×fps)` タイムベース単位で、
   * `den` が合成 fps に近づくほど 0 へ潰れる——**許容幅がゼロに近づく側が設計限界**なので、
   * ここを測らないと canon 写像が全フレーム 1 スロットずれても緑のままになる。
   */
  it('settb の整数倍率: 1 スロットあたり 8 タイムベース単位を確保し、粗い側の破綻を消す', () => {
    // 倍率の pin（`den >= 8×fps` の実素材はすべて 1 ＝ settb を挟まない＝既存出力は不変）。
    const mults = ([[600, 25], [90000, 30], [60000, FPS_5994], [15360, 30], [30, 30], [50, FPS_5994], [25, 25]] as const)
      .map(([den, fps]) => [`1/${den} x ${fps}`, canonTimeBaseMultiplier(den, fps)] as const);
    expect(Object.fromEntries(mults)).toEqual({
      '1/600 x 25': 1, '1/90000 x 30': 1, '1/60000 x 59.94': 1, '1/15360 x 30': 1,
      '1/30 x 30': 8, '1/50 x 59.94': 10, '1/25 x 25': 8,
    });
    // 粗い側は**素材 time_base のままだと中心置きでも壊れ**、整数倍へ上げると 0 になる（399 スロット）。
    const rows = ([[30, 30], [25, 25], [50, FPS_5994]] as const).map(([den, fps]) => [
      `1/${den} x ${fps}`,
      [misassigned(den, fps, 399, 'center'), misassigned(canonTimeBaseDen(den, fps), fps, 399, 'center')],
    ] as const);
    expect(Object.fromEntries(rows)).toEqual({
      // [素材 time_base のまま, settb で整数倍へ上げた後]
      '1/30 x 30': [393, 0],
      '1/25 x 25': [363, 0],
      '1/50 x 59.94': [66, 0],
    });
  });

  /**
   * **`setpts` の `round()` の位置づけ（M-1）**。`round()` を外す＝ ffmpeg の整数化（切り捨て）に
   * 落ちる置き方（`centerTrunc`）を測ると、**settb で 1 スロット 8 単位を確保した後はどの
   * 組み合わせでも 0**（切り捨てで失うのは 1 単位未満・中心は境界から 4 単位以上ある）。
   * つまり `round()` は I-1 の不変条件に吸収されており、**挙動テストでは守れない**——
   * 守っているのは上の「8 単位」の不変条件そのもの。settb が無ければ `round()` が要ることは
   * 素材 time_base のままの列が示す（1/50 × 59.94 で 232/399）。
   */
  it('round() は settb の 8 単位不変条件に吸収される（挙動では弁別できないことの実測）', () => {
    const centerTrunc = (k: number, den: number, fps: number): number => Math.trunc(((k + 0.5) / fps) * den);
    const misTrunc = (den: number, fps: number, slots: number): number => {
      let n = 0;
      for (let k = 0; k < slots; k += 1) if (slotOfPts(centerTrunc(k, den, fps), den, fps) !== k) n += 1;
      return n;
    };
    const rows = ([[600, 25], [90000, 30], [60000, FPS_5994], [15360, 30], [30, 30], [50, FPS_5994]] as const)
      .map(([den, fps]) => [`1/${den} x ${fps}`, [misTrunc(den, fps, 399), misTrunc(canonTimeBaseDen(den, fps), fps, 399)]] as const);
    expect(Object.fromEntries(rows)).toEqual({
      // [素材 time_base のまま, settb 後] — settb 後は全部 0（= round() を外しても挙動は変わらない）
      '1/600 x 25': [0, 0],
      '1/90000 x 30': [0, 0],
      '1/60000 x 59.94': [0, 0],
      '1/15360 x 30': [0, 0],
      '1/30 x 30': [0, 0],
      '1/50 x 59.94': [232, 0],
    });
  });

  it.each(COMBOS.map((c) => [c.label, c] as const))(
    '%s: canon 写像の出力 pts が、独立再導出したスロットの内側（中心付近）に入る',
    (label, combo) => {
      const src = srcOf.get(srcKeyOf(combo))!;
      expect(readTimeBaseDen(src), `${label}: 素材の time_base`).toBe(combo.den);
      const srcPts = readPtsInt(src).map((p) => p / combo.den);
      expect(srcPts.length, `${label}: 素材のフレーム数`).toBe(combo.frames ?? PTS_SRC.frames);

      /** 製品が canon 鎖の先頭で立てる time_base（settb が要らないときは素材のまま）。 */
      const outDen = canonTimeBaseDen(combo.den, combo.fps);
      const setpts = canonSetpts({ ...LAYER, timeBaseDen: combo.den }, combo.fps);
      const observed = readCanonOutPts(src, setpts);
      expect(observed.length, `${label}: 出力フレーム数`).toBe(combo.frames ?? PTS_SRC.frames);

      // 独立再導出（画を介さない）。
      const slots = canonSlots(srcPts, LAYER.sourceInFrame, LAYER.playbackRate, combo.fps);
      const span = Math.max(...slots) + 1;

      // 弁別性の検算: **素材の time_base のまま**だとどの置き方が赤になるかを毎回測って表と突き合わせる。
      expect(
        {
          none: misassigned(combo.den, combo.fps, span, 'none') > 0,
          boundary: misassigned(combo.den, combo.fps, span, 'boundary') > 0,
          center: misassigned(combo.den, combo.fps, span, 'center') > 0,
        },
        `${label}: 観測範囲 [0,${span - 1}] の発火（${combo.note}）`,
      ).toEqual(combo.raw);
      // 製品が実際に使う time_base（settb 後）では、中心置きはどの組み合わせでも 0。
      expect(misassigned(outDen, combo.fps, span, 'center'), `${label}: 中心置きの誤割当`).toBe(0);

      // 主軸: 出力 pts が入るスロット（= 後段 fps フィルタが選ぶスロット）が canon と一致する。
      const wrong = observed
        .map((p, i) => ({ i, p, got: slotOfPts(p, outDen, combo.fps), want: slots[i]! }))
        .filter((r) => r.got !== r.want)
        .map((r) => `frame ${r.i}: pts=${r.p} → slot ${r.got} / 正典 ${r.want}`);
      expect(wrong, `${label}: 出力 pts のスロット割当（不一致 ${wrong.length}/${observed.length}）`).toEqual([]);

      // 設計の pin: 境界すれすれではなく**スロットの中心付近**に置いている
      // （±半スロットの余裕が、time_base × fps の組み合わせ依存を消している当のもの）。
      // frame 0 は `if(eq(N,0),0,…)` で pts=0 に固定される（窓より前を slot 0 へ潰す正典）ので除く。
      const edge = observed
        .map((p, i) => ({ i, p, pos: (p * combo.fps) / outDen - slots[i]! }))
        .filter((r) => r.i > 0 && (r.pos < 0.25 || r.pos > 0.75))
        .map((r) => `frame ${r.i}: スロット内位置 ${r.pos.toFixed(3)}`);
      expect(edge, `${label}: pts はスロット中心付近（0.25〜0.75）`).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// 補助軸: 画素（動く素材でだけ弁別できる・主軸ではない）
// ---------------------------------------------------------------------------

/** 合成解像度・合成 fps（実素材と同じ 1/600 × 25fps）。 */
const W = 320;
const H = 180;
const FPS = 25;
const TOTAL = 40;
const BASE_RGB = { r: 0, g: 0, b: 128 };
const SUB_W = 320;
const SUB_H = 122;
const SUB_FPS = 60;
const SUB_FRAMES = 64;
const SUB_TIMESCALE = 600;
const V1 = { startFrame: 10, endFrame: 30, sourceInFrame: 0, playbackRate: 1 };
const V1_LOW = { x: 20, y: 40 };
const V1_HIGH = { x: 300, y: 40 };

interface Rgb {
  r: number;
  g: number;
  b: number;
}

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

function isBase(px: Rgb): boolean {
  return Math.abs(px.r - BASE_RGB.r) < 12 && Math.abs(px.g - BASE_RGB.g) < 12 && Math.abs(px.b - BASE_RGB.b) < 16;
}

function digitOf(px: Rgb): number | null {
  const avg = (px.r + px.g + px.b) / 3;
  if (Math.abs(px.r - avg) > 10 || Math.abs(px.g - avg) > 10 || Math.abs(px.b - avg) > 10) return null;
  const d = Math.round(avg / 32);
  if (d < 0 || d > 7) return null;
  return d;
}

function sourceIndexOf(low: Rgb, high: Rgb): number | null {
  const l = digitOf(low);
  const h = digitOf(high);
  if (l === null || h === null) return null;
  return h * 8 + l;
}

/** 正典②: 時刻 t に最も近い実在フレーム。同値タイは後ろ。 */
function canonPick(pts: readonly number[], t: number): number {
  let best = 0;
  for (let i = 0; i < pts.length; i += 1) {
    if (Math.abs(pts[i]! - t) <= Math.abs(pts[best]! - t) + 1e-9) best = i;
  }
  return best;
}

function floorPick(pts: readonly number[], t: number): number {
  let best = 0;
  for (let i = 0; i < pts.length; i += 1) if (pts[i]! <= t + 1e-9) best = i;
  return best;
}

function timeOf(k: number): number {
  return (V1.sourceInFrame + V1.playbackRate * k) / FPS;
}

describe.skipIf(!ffmpeg.ok)('補助軸: 動く素材の画素でも 1 コマずれが出ない（time_base 1/600 × 25fps）', () => {
  let dir = '';
  let subPts: number[] = [];
  let frames: Buffer = Buffer.alloc(0);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'native-export-video-timebase-px-'));
    const subPath = join(dir, 'sub.mp4');
    const outPath = join(dir, 'out.mp4');
    const mainPath = join(dir, 'main.mp4');
    const scriptPath = join(dir, 'filter.txt');
    const rawPath = join(dir, 'sub.rgb');

    // 毎フレーム内容が変わる ID ブロック（静止素材では原理的に弁別できないため）
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
    writeFileSync(rawPath, raw);
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SUB_W}x${SUB_H}`, '-r', String(SUB_FPS), '-i', rawPath,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
      '-video_track_timescale', String(SUB_TIMESCALE), subPath,
    ]);
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x000080:size=${W}x${H}:rate=${FPS}:duration=${TOTAL / FPS}`,
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-shortest', '-pix_fmt', 'yuv420p', mainPath,
    ]);
    expect(readTimeBaseDen(subPath)).toBe(SUB_TIMESCALE);
    subPts = readPtsInt(subPath).map((p) => p / SUB_TIMESCALE);

    const layers: OverlayLayer[] = [
      { kind: 'video', ...V1, placement: videoInsertPlacement({ width: W, height: H }, undefined, 1) },
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
      extraInputs: [{ path: subPath }],
    }));
    expect(probeFrameCount(outPath)).toBe(TOTAL);
    frames = run([
      '-hide_banner', '-loglevel', 'error', '-i', outPath,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
    ]);
  }, 300_000);

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
  });

  it('弁別性の検算: 窓内に「修正なしなら誤割当になるスロット」があり、最近傍と直前も食い違い、内容が毎フレーム動く', () => {
    const span = V1.endFrame - V1.startFrame;
    // この窓（20 スロット）は修正なし（切り捨て）だと 6 スロットが 1 つ下へ落ちる。
    expect(misassigned(SUB_TIMESCALE, FPS, span, 'none')).toBe(6);
    expect(misassigned(SUB_TIMESCALE, FPS, span, 'center')).toBe(0);
    let discriminating = 0;
    for (let k = 0; k < span; k += 1) {
      if (canonPick(subPts, timeOf(k)) !== floorPick(subPts, timeOf(k))) discriminating += 1;
    }
    expect(discriminating, '最近傍と直前が食い違うフレーム数').toBeGreaterThan(0);
    const expected = Array.from({ length: span }, (_, k) => canonPick(subPts, timeOf(k)));
    expect(new Set(expected).size, '窓内に出る相異なるソースフレーム数').toBeGreaterThan(span / 2);
  });

  it('窓内の全フレームで最近傍のソースフレームが出る（1 コマ先へ進まない）', () => {
    const span = V1.endFrame - V1.startFrame;
    const observed: number[] = [];
    for (let k = 0; k < span; k += 1) {
      const f = V1.startFrame + k;
      const px = { low: blockAt(frames, f, V1_LOW.x, V1_LOW.y), high: blockAt(frames, f, V1_HIGH.x, V1_HIGH.y) };
      expect(isBase(px.low), `k=${k}: サブ動画が居ない`).toBe(false);
      observed.push(sourceIndexOf(px.low, px.high)!);
    }
    const expected = Array.from({ length: span }, (_, k) => canonPick(subPts, timeOf(k)));
    const shifted = observed.map((v, k) => ({ k, v, want: expected[k]! })).filter((r) => r.v !== r.want);
    expect(shifted.map((r) => `k=${r.k}: 観測 ${r.v} / 正典 ${r.want}`), '内容が 1 コマ先に進んでいる').toEqual([]);
  });
});
