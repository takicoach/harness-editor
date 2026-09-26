/**
 * C-0 の実 ffmpeg e2e: **素材寸法 ≠ composition** のとき、native の出力寸法と黒帯位置が
 * 正典（Remotion の `objectFit:'contain'`）と一致することを**画素**で確かめる。
 *
 * 受入 F（2026-09-03）で観測した壊れ方は「出力が素材寸法のまま・オーバーレイだけ
 * composition 幾何」だった。ここで測るのは 2 つ:
 *   1. 出力寸法が composition（1080×1920）ちょうどであること（ffprobe 実測）
 *   2. 黒帯の境界行が正典 contain の値と ±2px で一致すること
 *      正典: 表示高 = W_comp × (h_src / w_src) = 1080 × 1080/1920 = 607.5
 *            上帯 = (1920 − 607.5) / 2 = 656.25 → 内容行は 656.25〜1263.75
 *
 * 比較器が無感でないことは、**contain を外した対照**（素材寸法のまま焼く）で
 * 同じ検査が赤くなる（出力 1920×1080・黒帯なし）ことを毎回示す。
 *
 * 素材はこのファイル内で lavfi から作る（外部 fixture 依存なし）。ffmpeg が無ければ skip、
 * ただし `HARNESS_REQUIRE_CAPTURE_E2E=1`（= `npm run test:gate`）では throw（I-5 規律）。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SAR_NORMALIZE_FILTER, applySegmentContain, buildCutFilterScript, containFilterFor } from './fastCutRender';
import { planFastCut } from './fastCutPlan';
import { probeVideoSize } from './probeFrames';
import { probeVideoSize as probeVideoSizeE2E } from './transitionFrameCompare';
import { resolveFfmpegBin } from './resolveFfmpeg';

const ffmpeg = resolveFfmpegBin();
const required = process.env['HARNESS_REQUIRE_CAPTURE_E2E'] === '1';
if (!ffmpeg.ok && required) {
  throw new Error('HARNESS_REQUIRE_CAPTURE_E2E=1 ですが ffmpeg が見つかりません（C-0 e2e）。');
}
const FFMPEG = ffmpeg.ok ? ffmpeg.bin : 'ffmpeg';

/** 素材（横）と composition（縦）。異アスペクトなので contain で上下に黒帯が出る。 */
const SRC_W = 1920;
const SRC_H = 1080;
const COMP = { width: 1080, height: 1920 };
const FPS = 30;
/** 素材の色（yuv420p 往復が素直な緑・黒と十分離れている）。 */
const SRC_COLOR = '0x00cc00';
/** 正典 contain の内容領域（Remotion objectFit:'contain' と同じ算術）。 */
const CONTENT_H = (COMP.width * SRC_H) / SRC_W; // 607.5
const TOP_EDGE = (COMP.height - CONTENT_H) / 2; // 656.25
const BOTTOM_EDGE = TOP_EDGE + CONTENT_H; // 1263.75
/** 黒判定の閾値（rgb24 の各チャンネル）。素材の緑は g≈204 なので余裕は 170 以上。 */
const BLACK_MAX = 32;

const work = ffmpeg.ok ? mkdtempSync(join(tmpdir(), 'm3-c0-e2e-')) : '';
afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

function run(args: string[]): void {
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { maxBuffer: 64 * 1024 * 1024 });
}

/** 1920×1080・30fps・2 秒の単色素材（音声つき: 区間行の atrim が要るため）。 */
function makeSource(): string {
  return makeColorSource('source.mp4', SRC_W, SRC_H, 2);
}

/** 任意寸法・任意長の単色素材（音声つき）。 */
function makeColorSource(name: string, w: number, h: number, sec: number): string {
  const out = join(work, name);
  run([
    '-f', 'lavfi', '-i', `color=c=${SRC_COLOR}:s=${w}x${h}:r=${FPS}:d=${sec}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-y', out,
  ]);
  return out;
}

/**
 * **アナモルフィック素材**（非正方画素・C-8）。復号寸法 `w×h`・SAR `sarNum:sarDen` で、
 * 表示寸法は `w*sar × h`。実素材の例: DV/HDV（1440×1080 SAR 4:3 = 表示 1920×1080）。
 */
function makeAnamorphicSource(name: string, w: number, h: number, sec: number, sar: string): string {
  const out = join(work, name);
  run([
    '-f', 'lavfi', '-i', `color=c=${SRC_COLOR}:s=${w}x${h}:r=${FPS}:d=${sec}`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-shortest',
    '-vf', `setsar=${sar}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-y', out,
  ]);
  return out;
}

/**
 * 回転メタ（display matrix）つきの素材を作る（I-1）。`-display_rotation` は**入力側**の
 * オプションで、`-c copy` で remux すると side data として出力へ載る。
 * ffmpeg は復号時に自動回転するので、**実際にフィルタへ流れる絵は width/height が入れ替わった向き**。
 */
function makeRotatedSource(name: string, w: number, h: number, sec: number, deg: number): string {
  const plain = makeColorSource(`${name}.plain.mp4`, w, h, sec);
  const out = join(work, name);
  run(['-display_rotation', String(deg), '-i', plain, '-c', 'copy', '-y', out]);
  return out;
}

/**
 * planFastCut を実際に通すための最小プロジェクト（撮影なし・図形なし）。
 * `public/main.mp4` は**実素材**（寸法・fps は ffprobe で読まれる）。
 */
function makeProject(source: string, format: 'short' | 'youtube', durationFrames: number): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'm3-c0-proj-')));
  mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'public', 'main.mp4'), readFileSync(source));
  writeFileSync(
    join(dir, 'src', 'videoConfig.ts'),
    [
      "export type VideoFormat = 'youtube' | 'short' | 'square';",
      `export const FORMAT: VideoFormat = '${format}';`,
      `export const FPS = ${FPS};`,
      `export const DURATION_FRAMES = ${durationFrames};`,
      "export const VIDEO_FILE = 'main.mp4';",
      'const RESOLUTION_MAP = {',
      '  youtube: { width: 3840, height: 2160 },',
      '  short: { width: 1080, height: 1920 },',
      '  square: { width: 1080, height: 1080 },',
      '} as const;',
      'export const RESOLUTION = RESOLUTION_MAP[FORMAT];',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src', 'テロップテンプレート', 'telopData.ts'),
    ['export const FPS = 30;', `export const TOTAL_FRAMES = ${durationFrames};`, 'export const telopData = [];'].join('\n'),
  );
  writeFileSync(
    join(dir, 'src', 'cutData.ts'),
    'export const cutData = [\n' +
      '  { id: 1, originalStart: 0, originalEnd: 60, playbackStart: 0, playbackEnd: 60 },\n' +
      '];\n',
  );
  writeFileSync(
    join(dir, 'transcript.json'),
    JSON.stringify({ engine: 'none', language: 'ja', duration_ms: 4000, words: [], segments: [] }),
  );
  return dir;
}

/** script を当てて焼く（映像は無損失 ffv1・寸法検査と画素検査のため）。 */
function render(source: string, name: string, script: string): string {
  const scriptPath = join(work, `${name}.filter`);
  writeFileSync(scriptPath, script, 'utf8');
  const out = join(work, `${name}.mkv`);
  run([
    '-i', source,
    '-/filter_complex', scriptPath,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'ffv1', '-c:a', 'pcm_s16le',
    '-y', out,
  ]);
  return out;
}

/** 先頭 1 フレームを rgb24 で取り出す。 */
function firstFrame(path: string, width: number, height: number): Buffer {
  const out = execFileSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-i', path, '-map', '0:v:0', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const need = width * height * 3;
  if (out.length < need) throw new Error(`firstFrame: 画素が足りません（${out.length} < ${need}）`);
  return out.subarray(0, need);
}

/** 行 y が全画素黒か。 */
function rowIsBlack(frame: Buffer, width: number, y: number): boolean {
  for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 3;
    if (frame[o]! > BLACK_MAX || frame[o + 1]! > BLACK_MAX || frame[o + 2]! > BLACK_MAX) return false;
  }
  return true;
}

/** 上から見て最初に黒でない行（無ければ null）。 */
function firstNonBlackRow(frame: Buffer, width: number, height: number): number | null {
  for (let y = 0; y < height; y++) if (!rowIsBlack(frame, width, y)) return y;
  return null;
}

/** 下から見て最後に黒でない行（無ければ null）。 */
function lastNonBlackRow(frame: Buffer, width: number, height: number): number | null {
  for (let y = height - 1; y >= 0; y--) if (!rowIsBlack(frame, width, y)) return y;
  return null;
}

/** 列 x が全画素黒か。 */
function colIsBlack(frame: Buffer, width: number, height: number, x: number): boolean {
  for (let y = 0; y < height; y++) {
    const o = (y * width + x) * 3;
    if (frame[o]! > BLACK_MAX || frame[o + 1]! > BLACK_MAX || frame[o + 2]! > BLACK_MAX) return false;
  }
  return true;
}

/** 行 y を左から見て最初に黒でない列（無ければ null）。 */
function firstNonBlackCol(frame: Buffer, width: number, y: number): number | null {
  for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 3;
    if (frame[o]! > BLACK_MAX || frame[o + 1]! > BLACK_MAX || frame[o + 2]! > BLACK_MAX) return x;
  }
  return null;
}

/** 行 y を右から見て最後に黒でない列（無ければ null）。 */
function lastNonBlackCol(frame: Buffer, width: number, y: number): number | null {
  for (let x = width - 1; x >= 0; x--) {
    const o = (y * width + x) * 3;
    if (frame[o]! > BLACK_MAX || frame[o + 1]! > BLACK_MAX || frame[o + 2]! > BLACK_MAX) return x;
  }
  return null;
}

/** planFastCut が書いた filter script のファイル名（`cut-filter-<token>.txt`）。 */
function scriptName(dir: string): string {
  const found = readdirSync(join(dir, 'out')).find((f) => f.startsWith('cut-filter-'));
  if (found === undefined) throw new Error('cut-filter-*.txt が見つかりません（planFastCut が書いていない）');
  return found;
}

/** 正規表現メタ文字のエスケープ（filter 文字列をそのまま剥がすため）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SEGMENTS = [{ start: 0, end: 30 }];
const CONTAIN = containFilterFor({ width: SRC_W, height: SRC_H }, COMP);

describe.skipIf(!ffmpeg.ok)('C-0 e2e: 素材寸法 ≠ composition の出力寸法と黒帯位置', () => {
  it('異アスペクト（1920×1080 → short 1080×1920）で出力は composition・黒帯は正典 contain と一致', () => {
    const source = makeSource();
    expect(CONTAIN).not.toBeNull();
    const script = applySegmentContain(buildCutFilterScript(SEGMENTS, FPS), CONTAIN!);
    const out = render(source, 'contain', script);

    // 1) 出力寸法は composition ちょうど（素材の 1920×1080 ではない）。
    expect(probeVideoSize(out)).toMatchObject(COMP);

    // 2) 黒帯の境界が正典 contain（内容 607.5px を中央配置）と ±2px で一致。
    const frame = firstFrame(out, COMP.width, COMP.height);
    const top = firstNonBlackRow(frame, COMP.width, COMP.height);
    const bottom = lastNonBlackRow(frame, COMP.width, COMP.height);
    expect(top).not.toBeNull();
    expect(bottom).not.toBeNull();
    expect(Math.abs(top! - TOP_EDGE)).toBeLessThanOrEqual(2);
    expect(Math.abs(bottom! - (BOTTOM_EDGE - 1))).toBeLessThanOrEqual(2);
    // 帯の内側は素材色で埋まっている（黒帯だけの絵ではない）。
    expect(rowIsBlack(frame, COMP.width, Math.round(COMP.height / 2))).toBe(false);
    // 帯の外側は上下とも黒（左右には帯が出ない＝幅は composition いっぱい）。
    expect(rowIsBlack(frame, COMP.width, 0)).toBe(true);
    expect(rowIsBlack(frame, COMP.width, COMP.height - 1)).toBe(true);
  });

  it('陰性対照: contain を外すと出力は素材寸法のままで黒帯が無い（上の検査が無感でない証明）', () => {
    const source = makeSource();
    const out = render(source, 'nocontain', buildCutFilterScript(SEGMENTS, FPS));
    // 受入 F で観測した壊れ方そのもの（出力 1920×1080）。
    expect(probeVideoSize(out)).toMatchObject({ width: SRC_W, height: SRC_H });
    const frame = firstFrame(out, SRC_W, SRC_H);
    expect(firstNonBlackRow(frame, SRC_W, SRC_H)).toBe(0);
    expect(lastNonBlackRow(frame, SRC_W, SRC_H)).toBe(SRC_H - 1);
  });

  /**
   * M-3: **ピラーボックス**（縦素材 → 横 composition）。上の 1 件は上下黒帯（レターボックス）
   * だけを見ていたので、`pad` の x/y を取り違えた実装が生き残る。
   * 正典: 内容幅 = H_comp × (w_src/h_src) = 2160 × 1080/1920 = 1215
   *       左帯 = (3840 − 1215)/2 = 1312.5（`force_divisible_by=2` の丸めで実測 1313）
   */
  it('ピラーボックス（1080×1920 素材 → youtube 3840×2160）で左右に黒帯・上下は詰まる', () => {
    const source = makeColorSource('portrait.mp4', 1080, 1920, 1);
    const comp = { width: 3840, height: 2160 };
    const contain = containFilterFor({ width: 1080, height: 1920 }, comp);
    expect(contain).not.toBeNull();
    const out = render(source, 'pillarbox', applySegmentContain(buildCutFilterScript(SEGMENTS, FPS), contain!));
    expect(probeVideoSize(out)).toMatchObject(comp);

    const frame = firstFrame(out, comp.width, comp.height);
    const mid = Math.round(comp.height / 2);
    const left = firstNonBlackCol(frame, comp.width, mid);
    const right = lastNonBlackCol(frame, comp.width, mid);
    const contentW = (comp.height * 1080) / 1920; // 1215
    const leftEdge = (comp.width - contentW) / 2; // 1312.5
    expect(left).not.toBeNull();
    expect(Math.abs(left! - leftEdge)).toBeLessThanOrEqual(2);
    expect(Math.abs(right! - (leftEdge + contentW - 1))).toBeLessThanOrEqual(2);
    // 上下は詰まる（帯は左右だけ）。
    expect(colIsBlack(frame, comp.width, comp.height, Math.round(comp.width / 2))).toBe(false);
  });

  /**
   * I-1: **回転メタつき素材**。`-display_rotation 90` を載せた 1920×1080 は、復号後は
   * 1080×1920（＝ composition と同寸）。probe が回転を無視すると「1920×1080 ≠ composition」と
   * 誤判定して**不要な contain が入る**（受入 E の「同寸なら 1 文字不変」が壊れる）。
   */
  it('回転メタ（90°）つき素材は復号後の向きで composition と等値判定される（contain 無し・出力は composition）', () => {
    const source = makeRotatedSource('rot.mp4', 1920, 1080, 4, 90);
    // probe は復号後の向き（1080×1920）を返す。
    expect(probeVideoSize(source)).toMatchObject({ width: 1080, height: 1920 });

    const dir = makeProject(source, 'short', 120);
    try {
      const output = join(dir, 'out', 'rot-out.mp4');
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, output, { hardware: false });
      expect(plan).not.toBeNull();
      expect(plan!.target).toEqual({ width: 1080, height: 1920 });
      const script = readFileSync(join(dir, 'out', scriptName(dir)), 'utf8');
      // rotation を無視する実装ではここに contain が入る（＝この行が変異の検出点）。
      expect(script).not.toContain('force_original_aspect_ratio');

      run(plan!.args);
      expect(probeVideoSize(output)).toMatchObject({ width: 1080, height: 1920 });
      expect(plan!.verify(output, plan!.totalFrames)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * I-2: **出力寸法の検収**。`verify` はフレーム数だけでなく出力寸法も見る。
   * 回帰: contain を外した script の出力（＝受入 F の壊れ方）を同じ `verify` に食わせると赤。
   */
  it('verify は出力寸法も検収する（contain を外した出力は赤）', () => {
    const source = makeColorSource('verify-src.mp4', 1920, 1080, 4);
    const dir = makeProject(source, 'short', 120);
    try {
      const output = join(dir, 'out', 'verify-ok.mp4');
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, output, { hardware: false });
      expect(plan).not.toBeNull();
      const scriptPath = join(dir, 'out', scriptName(dir));
      const script = readFileSync(scriptPath, 'utf8');
      expect(script).toContain('force_original_aspect_ratio');

      run(plan!.args);
      expect(probeVideoSize(output)).toMatchObject({ width: 1080, height: 1920 });
      expect(plan!.verify(output, plan!.totalFrames)).toBeNull();

      // contain を剥がした script で焼くと 1920×1080 のまま＝寸法検査が赤になる。
      const stripped = script.replace(new RegExp(`,${escapeRe(containFilterFor({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })!)}`, 'g'), '');
      expect(stripped).not.toContain('force_original_aspect_ratio');
      const bad = render(source, 'verify-ng', stripped);
      expect(probeVideoSize(bad)).toMatchObject({ width: 1920, height: 1080 });
      const message = plan!.verify(bad, plan!.totalFrames);
      expect(message).not.toBeNull();
      expect(message).toContain('1080x1920');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * C-8: **SAR≠1:1（アナモルフィック）素材**。1440×1080 SAR 4:3 の表示寸法は 1920×1080 なので、
   * 16:9 composition では**黒帯が出ない**のが正典（Remotion は `objectFit:'contain'` を
   * 表示寸法で解く）。正規化なしで contain だけ入れると 1440×1080 を 4:3 として内接させるため、
   * 左右に黒帯が出る（＝表示アスペクトが歪む）。陰性対照でその差を毎回示す。
   */
  it('アナモルフィック（1440×1080 SAR 4:3 → 1920×1080）は正規化されて黒帯なし・出力 SAR=1:1', () => {
    const source = makeAnamorphicSource('anamorphic.mp4', 1440, 1080, 2, '4/3');
    const comp = { width: 1920, height: 1080 };
    const probed = probeVideoSize(source);
    expect(probed).toMatchObject({ width: 1440, height: 1080, exact: false });
    expect(probed!.sar).toBeCloseTo(4 / 3, 6);

    const contain = containFilterFor(probed!, comp);
    expect(contain).not.toBeNull();
    expect(contain!.startsWith(`${SAR_NORMALIZE_FILTER},`)).toBe(true);

    const out = render(source, 'anamorphic', applySegmentContain(buildCutFilterScript(SEGMENTS, FPS), contain!));
    const size = probeVideoSize(out);
    expect(size).toMatchObject(comp);
    expect(size!.sar).toBe(1);
    // 全面が素材色（黒帯ゼロ）＝表示アスペクト 16:9 が保たれている。
    const frame = firstFrame(out, comp.width, comp.height);
    expect(firstNonBlackRow(frame, comp.width, comp.height)).toBe(0);
    expect(lastNonBlackRow(frame, comp.width, comp.height)).toBe(comp.height - 1);
    const mid = Math.round(comp.height / 2);
    expect(firstNonBlackCol(frame, comp.width, mid)).toBe(0);
    expect(lastNonBlackCol(frame, comp.width, mid)).toBe(comp.width - 1);
  });

  it('陰性対照: SAR 正規化を外すと左右に黒帯が出る（上の検査が無感でない証明）', () => {
    const source = makeAnamorphicSource('anamorphic-ctl.mp4', 1440, 1080, 2, '4/3');
    const comp = { width: 1920, height: 1080 };
    const contain = containFilterFor(probeVideoSize(source)!, comp)!;
    const stripped = contain.replace(`${SAR_NORMALIZE_FILTER},`, '');
    expect(stripped).not.toContain('setsar');
    const out = render(source, 'anamorphic-ctl', applySegmentContain(buildCutFilterScript(SEGMENTS, FPS), stripped));

    const frame = firstFrame(out, comp.width, comp.height);
    const mid = Math.round(comp.height / 2);
    // 1440×1080 を 4:3 として内接 → 内容幅 1440・左帯 240。
    expect(firstNonBlackCol(frame, comp.width, mid)).toBeGreaterThan(0);
    expect(Math.abs(firstNonBlackCol(frame, comp.width, mid)! - 240)).toBeLessThanOrEqual(2);
  });

  /**
   * M-1: `probeFrames.probeVideoSize`（製品・null 返し・回転/SAR を見る）と
   * `transitionFrameCompare.probeVideoSize`（e2e 用・throw 版）は**別実装の兄弟**。
   * 回転なし素材では同じ答えを返すことを pin する（片方だけ直すと赤）。
   * TODO: parse を probeFrames 側へ一本化する（B ラウンドが transitionFrameCompare を編集中のため据え置き）。
   */
  it('兄弟実装（transitionFrameCompare.probeVideoSize）と回転なし素材で同値', () => {
    const source = makeSource();
    const mine = probeVideoSize(source);
    expect(mine).not.toBeNull();
    expect({ width: mine!.width, height: mine!.height }).toEqual(probeVideoSizeE2E(source));
  });
});
