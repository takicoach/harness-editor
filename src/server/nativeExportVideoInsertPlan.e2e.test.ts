/**
 * サブ動画インサートの **製品経路** e2e（M4 T3・受入 B / C / D）。
 *
 * T2 の e2e（`nativeExportVideoInsert.e2e.test.ts`）は layer を**手で組んで** applyOverlays を
 * 直接呼ぶため、`planFastCutImpl` の配線（射影・最終座標・入力 index の割当・extraInputs の
 * 並び）を1つも検査できない。ここは**製品の `planFastCut` が返した args と、製品が書いた
 * filter script をそのまま**実 ffmpeg へ渡して焼き、画素で突き合わせる。
 *
 * 測る軸:
 * - **受入 B**（最重要）: 窓内の各フレームに出る**サブ動画のソースフレーム番号**を ID パッチで
 *   読み、正典①②（t=(S+rate×k)/合成fps に最も近い実在フレーム・タイは後ろ）と突合する。
 *   `playbackRate=0.7` を混ぜてあるので**直前フレーム規則（floor）との弁別が実際に効く**
 *   （弁別フレーム数を毎回 assert して、比較件数 0 の vacuous PASS を塞ぐ・#91）。
 * - **窓の境界 ±1**（正典④ `[start,end)` 排他）と **総尺検算**（受入 D: `plan.totalFrames` と
 *   出力 nb_frames の厳密一致 + `plan.verify` の検収）。
 * - **受入 C**（正典⑨ 音声不変）: 同一 fixture の「サブ動画あり／なし」で音声 PCM が
 *   **バイト完全一致**し、ffmpeg 引数と filter script の音声部分が 1 文字不変。
 *
 * ## ゲートの迂回
 * ゲートは M4 T5 で開放済み（`cutsOnly.ts` から `'videoInserts'` を削除）。T3 の時点で
 * 使っていた `vi.mock` によるゲート迂回は撤去し、製品の `planFastCut` をそのまま通している。
 *
 * ## fixture の非自明性（#97/#194）
 * - カットは**2 区間**（原本 [0,30) と [60,90)）＝ concat が実際に走る（恒等 fixture ではない）。
 * - サブ動画は**2 本**で、窓は重なり、V2 は**カットの継ぎ目（再生 30）をまたぐ**。
 * - サブ動画は合成と**別のアスペクト（320×122）・別の fps（60）**＝ contain の余白と
 *   「サブ動画自身の fps は時間軸に無関与」（正典①）が同時に効く。
 * - 音声は**正弦波**（無音だと受入 C の一致が vacuous になる）。
 *
 * ## レンダ回数
 * 素材生成 3 回 + 物差し検算 1 回 + 製品レンダ 2 回（サブ動画あり／なし）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { planFastCut } = await import('./fastCutPlan');
const { probeFrameCount } = await import('./probeFrames');
const { ffprobeFromFfmpeg, resolveFfmpegBin } = await import('./resolveFfmpeg');

const ffmpeg = resolveFfmpegBin();
if (!ffmpeg.ok && process.env['HARNESS_REQUIRE_CAPTURE_E2E'] === '1') {
  throw new Error('HARNESS_REQUIRE_CAPTURE_E2E=1 ですが ffmpeg が見つかりません（M4 T3 製品経路 e2e が黙って skip されるのを防ぎます）。');
}
const FFMPEG = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';

// ---------------------------------------------------------------------------
// fixture 諸元
// ---------------------------------------------------------------------------
/** composition（= videoConfig.RESOLUTION）と素材寸法（同値＝contain は入らない）。 */
const W = 320;
const H = 180;
const FPS = 30;
/** 原本の総フレーム数。 */
const SRC_FRAMES = 90;
/** 残す区間（原本）。カット後の再生総尺は 60。 */
const KEPT = [
  { originalStart: 0, originalEnd: 30 },
  { originalStart: 60, originalEnd: 90 },
];
const TOTAL = 60;
/** ベース映像の色（0x000080）。 */
const BASE_RGB = { r: 0, g: 0, b: 128 };

/** サブ動画（T2 e2e と同じ諸元: 別アスペクト・別 fps・ID パッチ焼き込み）。 */
const SUB_W = 320;
const SUB_H = 122;
const SUB_FPS = 60;
const SUB_FRAMES = 48;

/**
 * サブ動画 1 本目: 窓 [8,26)・S=3・rate=0.7（非整数比＝最近傍/直前の弁別が効く）。
 *
 * 窓の端を**カットの継ぎ目（再生 30）に載せない**のは、`clampVideoInserts` が
 * 「原本 end がカット区間の終端ちょうど」を区間の手前へ寄せるため（画像 `clampImages` と
 * 同型の既存挙動で、プレビューも同じ値になる）。ここで測りたいのは配線であって
 * clamp の端仕様ではないので、両者が混ざらない位置に置く。
 */
const V1 = { startFrame: 8, endFrame: 26, sourceInFrame: 3, playbackRate: 0.7 };
/** サブ動画 2 本目: 窓 [18,38)（V1 と重なり、カットの継ぎ目 30 を**中でまたぐ**）・S=0・rate=1・scale=0.5。 */
const V2 = { startFrame: 18, endFrame: 38, sourceInFrame: 0, playbackRate: 1, scale: 0.5 };

/** ID ブロックの読み取り点（出力座標）。T2 e2e と同一の幾何。 */
const V1_LOW = { x: 20, y: 40 };
const V1_HIGH = { x: 300, y: 40 };
const V2_LOW = { x: 110, y: 80 };
const V2_HIGH = { x: 210, y: 80 };

interface Rgb { r: number; g: number; b: number }

function run(args: string[]): Buffer {
  return execFileSync(FFMPEG, args, { maxBuffer: 512 * 1024 * 1024 });
}

/** 4×4 ブロックの平均 RGB。 */
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

/** ID ブロック（グレー段階 0..7 × 32）の読み値。グレーでなければ null。 */
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

/** 正典①: t = (S + rate×k)/合成fps。**掛けてから割る**（T1 申し送り3）。 */
function expectedSource(pts: readonly number[], layer: { sourceInFrame: number; playbackRate: number }, k: number): number {
  return canonPick(pts, (layer.sourceInFrame + layer.playbackRate * k) / FPS);
}

/** **直前フレーム規則**（誤った規則）。弁別性の対照。 */
function floorPick(pts: readonly number[], t: number): number {
  let best = 0;
  for (let i = 0; i < pts.length; i += 1) if (pts[i]! <= t + 1e-9) best = i;
  return best;
}

/** 素材の実在フレームの pts（整数 pts × time_base）。 */
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

/** 出力から rgb24 の全フレームを取り出す。 */
function decodeFrames(path: string): Buffer {
  return run(['-hide_banner', '-loglevel', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
}

/** 出力の音声を s16le PCM で取り出す（受入 C の突合に使う）。 */
function decodePcm(path: string): Buffer {
  return run([
    '-hide_banner', '-loglevel', 'error', '-i', path,
    '-map', '0:a:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-',
  ]);
}

/** 製品が書いた filter script のファイル名（`cut-filter-<token>.txt`）。 */
function scriptOf(dir: string): string {
  const found = readdirSync(join(dir, 'out')).find((f) => f.startsWith('cut-filter-'));
  if (found === undefined) throw new Error('cut-filter-*.txt が見つかりません（planFastCut が書いていない）');
  return readFileSync(join(dir, 'out', found), 'utf8');
}

/** filter script の**音声だけの行**（atrim / amix）。受入 C ではここが完全一致すること。 */
function audioOnlyLinesOf(script: string): string[] {
  return script.split('\n').filter((l) => /\[0:a\]|amix/.test(l));
}

/** 映像と音声が同居する concat 行（`[outa]` を産む行）。 */
function concatLineOf(script: string): string {
  const line = script.split('\n').find((l) => l.includes('concat='));
  if (line === undefined) throw new Error('filter script に concat 行がありません');
  return line;
}

/**
 * ffmpeg 引数の**音声部分**（`-map [outa]` 以降のエンコード指定）。
 * 末尾の `-y <出力パス>` は fixture ごとに違うので落とす（比較対象は音声の指定だけ）。
 */
function audioArgsOf(args: string[]): string[] {
  const i = args.indexOf('[outa]');
  if (i < 0) throw new Error('args に [outa] のマッピングがありません');
  const tail = args.slice(i);
  const y = tail.lastIndexOf('-y');
  if (y < 0) throw new Error('args に -y がありません');
  return tail.slice(0, y);
}

interface Fixture { dir: string; out: string; args: string[]; totalFrames: number; script: string; verify: string | null }

describe.skipIf(!ffmpeg.ok)('nativeExport サブ動画インサート 製品経路 e2e（M4 T3）', () => {
  let work = '';
  let subPath = '';
  let mainPath = '';
  let subPts: number[] = [];
  let withVi: Fixture;
  let withoutVi: Fixture;
  let frames: Buffer = Buffer.alloc(0);

  /** 製品の planFastCut を通し、返った args で実 ffmpeg を回す。 */
  function planAndRender(dir: string, name: string): Fixture {
    const out = join(work, `${name}.mp4`);
    const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, out, { hardware: false });
    if (plan === null) throw new Error(`planFastCut が null（${name}）`);
    if (plan.prepareCapture !== undefined) throw new Error('この fixture は撮影経路を通らない想定');
    const script = scriptOf(dir);
    run(plan.args);
    return { dir, out, args: plan.args, totalFrames: plan.totalFrames, script, verify: plan.verify(out, plan.totalFrames) };
  }

  /** サブ動画あり／なしのプロジェクトを作る（他は完全に同一）。 */
  function makeProject(name: string, videoInserts: boolean): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `m4t3-${name}-`)));
    mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
    mkdirSync(join(dir, 'src', 'InsertVideo'), { recursive: true });
    mkdirSync(join(dir, 'public'), { recursive: true });
    mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'public', 'main.mp4'), readFileSync(mainPath));
    writeFileSync(join(dir, 'public', 'sub.mp4'), readFileSync(subPath));
    writeFileSync(
      join(dir, 'src', 'videoConfig.ts'),
      [
        "export type VideoFormat = 'youtube' | 'short' | 'square';",
        "export const FORMAT: VideoFormat = 'youtube';",
        `export const FPS = ${FPS};`,
        `export const DURATION_FRAMES = ${SRC_FRAMES};`,
        "export const VIDEO_FILE = 'main.mp4';",
        'const RESOLUTION_MAP = {',
        `  youtube: { width: ${W}, height: ${H} },`,
        '  short: { width: 1080, height: 1920 },',
        '  square: { width: 1080, height: 1080 },',
        '} as const;',
        'export const RESOLUTION = RESOLUTION_MAP[FORMAT];',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'src', 'テロップテンプレート', 'telopData.ts'),
      ['export const FPS = 30;', `export const TOTAL_FRAMES = ${SRC_FRAMES};`, 'export const telopData = [];'].join('\n'),
    );
    let acc = 0;
    writeFileSync(
      join(dir, 'src', 'cutData.ts'),
      'export const cutData = [\n' +
        KEPT.map((k, i) => {
          const start = acc;
          acc += k.originalEnd - k.originalStart;
          return `  { id: ${i + 1}, originalStart: ${k.originalStart}, originalEnd: ${k.originalEnd}, playbackStart: ${start}, playbackEnd: ${acc} },`;
        }).join('\n') +
        '\n];\n',
    );
    writeFileSync(
      join(dir, 'transcript.json'),
      JSON.stringify({ engine: 'none', language: 'ja', duration_ms: 3000, words: [], segments: [] }),
    );
    writeFileSync(
      join(dir, 'src', 'InsertVideo', 'insertVideoData.ts'),
      'export const insertVideoData = [\n' +
        (videoInserts
          ? [
              `  { id: 1, startFrame: ${V1.startFrame}, endFrame: ${V1.endFrame}, file: 'sub.mp4', sourceInFrame: ${V1.sourceInFrame}, playbackRate: ${V1.playbackRate} },`,
              `  { id: 2, startFrame: ${V2.startFrame}, endFrame: ${V2.endFrame}, file: 'sub.mp4', sourceInFrame: ${V2.sourceInFrame}, scale: ${V2.scale} },`,
            ].join('\n')
          : '') +
        '\n];\n',
    );
    return dir;
  }

  beforeAll(() => {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'm4t3-work-')));
    subPath = join(work, 'sub.mp4');
    mainPath = join(work, 'main.mp4');

    // 1) サブ動画（各フレームに自分の番号を焼いた 320×122・60fps・48 枚）
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
    const rawPath = join(work, 'sub.rgb');
    writeFileSync(rawPath, raw);
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${SUB_W}x${SUB_H}`, '-r', String(SUB_FPS), '-i', rawPath,
      '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', subPath,
    ]);

    // 2) メイン素材（単色 + **正弦波**。無音だと受入 C の一致が vacuous になる）
    run([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=0x000080:size=${W}x${H}:rate=${FPS}:duration=${SRC_FRAMES / FPS}`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mainPath,
    ]);

    subPts = readPts(subPath);

    withVi = planAndRender(makeProject('vi', true), 'with-vi');
    withoutVi = planAndRender(makeProject('novi', false), 'without-vi');
    frames = decodeFrames(withVi.out);
  }, 300_000);

  afterAll(() => {
    for (const d of [work, withVi?.dir, withoutVi?.dir]) {
      if (d !== undefined && d !== '') rmSync(d, { recursive: true, force: true });
    }
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

  it('配線の一次資料: 製品の args と script がサブ動画入力（main の直後）を持つ', () => {
    const inputs: string[] = [];
    for (let i = 0; i < withVi.args.length; i += 1) if (withVi.args[i] === '-i') inputs.push(withVi.args[i + 1]!);
    // 音声 extraInputs も図形も無い fixture なので main → サブ動画×2。
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toBe(join(withVi.dir, 'public', 'main.mp4'));
    expect(inputs[1]).toBe(join(withVi.dir, 'public', 'sub.mp4'));
    expect(inputs[2]).toBe(join(withVi.dir, 'public', 'sub.mp4'));
    expect(withVi.script).toContain('[1:v]tpad=stop=-1:stop_mode=clone,');
    expect(withVi.script).toContain('[2:v]tpad=stop=-1:stop_mode=clone,');
    // サブ動画なし側には鎖が 1 文字も入らない（受入 E の e2e 側の写し）。
    expect(withoutVi.script).not.toContain('tpad=stop=-1');
  });

  it('受入 D 総尺検算: plan.totalFrames = 出力 nb_frames = カット後の再生尺（plan.verify も通る）', () => {
    expect(withVi.totalFrames).toBe(TOTAL);
    expect(probeFrameCount(withVi.out)).toBe(TOTAL);
    expect(frames.length).toBe(TOTAL * W * H * 3);
    expect(withVi.verify).toBeNull();
    // サブ動画なし側も同じ尺（サブ動画は時間軸に何も足さない・正典⑧）
    expect(withoutVi.totalFrames).toBe(TOTAL);
    expect(probeFrameCount(withoutVi.out)).toBe(TOTAL);
  });

  it('受入 B（ID パッチ突合）: 窓内の全フレームで正典①②のソースフレームが出る（直前規則との弁別つき）', () => {
    const observedV1: Array<number | null> = [];
    const observedV2: Array<number | null> = [];
    for (let f = V1.startFrame; f < V1.endFrame; f += 1) {
      observedV1.push(sourceIndexOf(blockAt(frames, f, V1_LOW.x, V1_LOW.y), blockAt(frames, f, V1_HIGH.x, V1_HIGH.y)));
    }
    for (let f = V2.startFrame; f < V2.endFrame; f += 1) {
      observedV2.push(sourceIndexOf(blockAt(frames, f, V2_LOW.x, V2_LOW.y), blockAt(frames, f, V2_HIGH.x, V2_HIGH.y)));
    }
    // 比較件数 > 0（ゼロ件ループで緑になる穴を塞ぐ・#91）
    expect(observedV1).toHaveLength(V1.endFrame - V1.startFrame);
    expect(observedV2).toHaveLength(V2.endFrame - V2.startFrame);
    expect(observedV1.every((v) => v !== null)).toBe(true);
    expect(observedV2.every((v) => v !== null)).toBe(true);

    const canonV1 = observedV1.map((_, k) => expectedSource(subPts, V1, k));
    const canonV2 = observedV2.map((_, k) => expectedSource(subPts, V2, k));
    expect(observedV1).toEqual(canonV1);
    expect(observedV2).toEqual(canonV2);

    // 弁別性の実証: V1（rate=0.7）は最近傍と直前で必ず食い違うフレームがある。
    const floorV1 = canonV1.map((_, k) => floorPick(subPts, (V1.sourceInFrame + V1.playbackRate * k) / FPS));
    const discriminating = canonV1.filter((v, i) => v !== floorV1[i]).length;
    expect(discriminating).toBeGreaterThan(0);
    expect(observedV1).not.toEqual(floorV1);
    // sourceInFrame=3 が効いていること（S=0 なら別の対応表になる）＝ S の取り違えを弁別する。
    const zeroS = canonV1.map((_, k) => expectedSource(subPts, { ...V1, sourceInFrame: 0 }, k));
    expect(canonV1).not.toEqual(zeroS);
    expect(observedV1).not.toEqual(zeroS);
  });

  it('正典④ 窓の境界 ±1: [start,end) 排他で在席が切り替わる（カットの継ぎ目をまたぐ V2 も）', () => {
    // V1（全画面）の直前/頭
    expect(isBase(blockAt(frames, V1.startFrame - 1, V1_LOW.x, V1_LOW.y))).toBe(true);
    expect(isBase(blockAt(frames, V1.startFrame, V1_LOW.x, V1_LOW.y))).toBe(false);
    // V1 の尻/直後（V2 は V1_LOW を覆わない位置）
    expect(isBase(blockAt(frames, V1.endFrame - 1, V1_LOW.x, V1_LOW.y))).toBe(false);
    expect(isBase(blockAt(frames, V1.endFrame, V1_LOW.x, V1_LOW.y))).toBe(true);
    // V2（中央 50%）の直前/頭・尻/直後。窓 [18,38) は再生 30 のカット継ぎ目をまたぐ
    // （M-5: 旧コメントの「窓 [20,40)」は実値と不一致だった）。
    expect(isBase(blockAt(frames, V2.startFrame - 1, V2_LOW.x, V2_LOW.y))).toBe(false); // V1 が下に居る
    expect(isBase(blockAt(frames, 30, V2_LOW.x, V2_LOW.y))).toBe(false); // 継ぎ目でも在席
    expect(isBase(blockAt(frames, V2.endFrame - 1, V2_LOW.x, V2_LOW.y))).toBe(false);
    expect(isBase(blockAt(frames, V2.endFrame, V2_LOW.x, V2_LOW.y))).toBe(true);
    // どちらの窓にも入らないフレームは全てベース
    for (const f of [0, 5, 7, 45, TOTAL - 1]) {
      expect(isBase(blockAt(frames, f, V1_LOW.x, V1_LOW.y)), `frame ${f}`).toBe(true);
      expect(isBase(blockAt(frames, f, V2_LOW.x, V2_LOW.y)), `frame ${f}`).toBe(true);
    }
  });

  it('受入 C（正典⑨ 音声不変）: サブ動画あり／なしで音声 PCM がバイト完全一致し、音声の引数・filter 行が 1 文字不変', () => {
    const a = decodePcm(withVi.out);
    const b = decodePcm(withoutVi.out);
    // 無音 fixture だと「両方ゼロ」で自明に一致するので、実際に音が入っていることを先に検算する。
    expect(a.length).toBeGreaterThan(0);
    let peak = 0;
    for (let i = 0; i + 1 < a.length; i += 2) peak = Math.max(peak, Math.abs(a.readInt16LE(i)));
    expect(peak).toBeGreaterThan(1000);
    expect(a.length).toBe(b.length);
    expect(a.equals(b)).toBe(true);
    // 引数と filter script の音声部分（サブ動画の配線は音声工程に一切触れない）
    expect(audioArgsOf(withVi.args)).toEqual(audioArgsOf(withoutVi.args));
    const audioLines = audioOnlyLinesOf(withVi.script);
    expect(audioLines.length).toBeGreaterThan(0);
    expect(audioLines).toEqual(audioOnlyLinesOf(withoutVi.script));
    /**
     * concat 行は映像と音声が同居するので完全一致にはならない——`applyOverlays` の規約で
     * **映像の出力ラベルだけ**が `[outv]` → `[shraw]` に付け替わり、行末に `;` が付く。
     * 音声側（`[a0]`/`[a1]` の入力・`a=1`・`[outa]`）が 1 文字でも変われば下の式が赤になる。
     */
    expect(concatLineOf(withVi.script)).toBe(`${concatLineOf(withoutVi.script).replace('[outv]', '[shraw]')};`);
  });
});
