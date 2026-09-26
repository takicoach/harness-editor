/**
 * C-0: **素材寸法 ≠ videoConfig.resolution** のときの native 出力寸法とオーバーレイ幾何。
 *
 * 受入 F（コントローラ実測 2026-09-03）で発覚した製品バグの回帰テスト。DJI ショート
 * （mp4 1728×3072・`RESOLUTION` は short 1080×1920）で native 出力が **1728×3072 のまま**
 * になり、色レイヤ・撮影 PNG・図形だけが 1080×1920 の幾何で左上に乗っていた。
 * 原因は `fastCutPlan.ts` が「素材寸法 = `videoConfig.resolution`」と仮定していたこと。
 *
 * 正典（Remotion）は composition = `videoConfig.resolution` に
 * `OffthreadVideo style={{objectFit:'contain'}}` でフィットさせる。native も同じく
 * **composition を正本**とし、素材が違えば主映像の各区間正規化の直後に contain
 * （`scale=…force_original_aspect_ratio=decrease` + 中央 `pad`）を挟む。
 *
 * ここは script と plan の**配線**を pin する（実 ffmpeg の画素＝黒帯位置は
 * `nativeExportComposition.e2e.test.ts`）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFastCut } from './fastCutPlan';
import {
  SAR_NORMALIZE_FILTER,
  SAR_VERIFY_TOLERANCE,
  applySegmentContain,
  buildCutFilterScript,
  containFilterFor,
  verifyOutputSize,
} from './fastCutRender';

/** 素材が composition と違うときに各区間へ入る contain フィルタ（1080×1920 の場合）。 */
const CONTAIN_SHORT =
  'scale=1080:1920:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,' +
  'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black';

/** 拡大側（composition = youtube 3840×2160）の contain。 */
const CONTAIN_4K =
  'scale=3840:2160:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,' +
  'pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=black';

/** 16:9 composition（1920×1080）の contain（C-8 の SAR 正規化と合わせて使う）。 */
const CONTAIN_16_9 =
  'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,' +
  'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black';

/**
 * 最小プロジェクト（FORMAT='short' → composition 1080×1920・カット2区間で totalFrames=200）。
 * `public/main.mp4` は**中身を持たない実ファイル**（寸法は `probeSize` を注入して与える）。
 */
function makeShortProject(opts: { shapes?: boolean; format?: 'short' | 'youtube' } = {}): string {
  const format = opts.format ?? 'short';
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-c0-')));
  mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(join(dir, 'public', 'main.mp4'), '');
  writeFileSync(
    join(dir, 'src', 'videoConfig.ts'),
    [
      "export type VideoFormat = 'youtube' | 'short' | 'square';",
      `export const FORMAT: VideoFormat = '${format}';`,
      'export const FPS = 30;',
      'export const DURATION_FRAMES = 300;',
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
    ['export const FPS = 30;', 'export const TOTAL_FRAMES = 300;', 'export const telopData = [];'].join('\n'),
  );
  writeFileSync(
    join(dir, 'src', 'cutData.ts'),
    'export const cutData = [\n' +
      '  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },\n' +
      '  { id: 2, originalStart: 200, originalEnd: 300, playbackStart: 100, playbackEnd: 200 },\n' +
      '];\n',
  );
  writeFileSync(
    join(dir, 'transcript.json'),
    JSON.stringify({ engine: 'none', language: 'ja', duration_ms: 10000, words: [], segments: [] }),
  );
  if (opts.shapes === true) {
    mkdirSync(join(dir, 'src', 'InsertShape'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'InsertShape', 'shapeData.ts'),
      "export const shapeData = [\n  { id: 1, startFrame: 40, endFrame: 80, kind: 'line', " +
        "x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff', thickness: 'thin', opacity: 0.5 },\n];\n",
    );
  }
  return dir;
}

describe('containFilterFor / applySegmentContain（C-0 の部品）', () => {
  it('同寸なら null（1 文字も足さない）・違えば composition が正本', () => {
    expect(containFilterFor({ width: 1080, height: 1920 }, { width: 1080, height: 1920 })).toBeNull();
    expect(containFilterFor({ width: 1728, height: 3072 }, { width: 1080, height: 1920 })).toBe(CONTAIN_SHORT);
    // 異アスペクトでも文字列は同じ（pad が黒帯を作る／同アスペクトでは pad が恒等）。
    expect(containFilterFor({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toBe(CONTAIN_SHORT);
    // exact=false（SAR≠1:1 / rotation 不明）は同寸でも省略しない（同アスペクトなら pad は恒等）。
    expect(
      containFilterFor({ width: 1080, height: 1920, exact: false }, { width: 1080, height: 1920 }),
    ).toBe(CONTAIN_SHORT);
  });

  it('転換ありの区間行（gbrp/settb 形）にも挟まる・音声行は素通し', () => {
    const script = buildCutFilterScript(
      [{ start: 0, end: 100 }, { start: 200, end: 300 }],
      30,
      [{ afterIndex: 0, frames: 10, kind: 'crossfade' }],
    );
    const withContain = applySegmentContain(script, CONTAIN_SHORT);
    const videoLines = withContain.split('\n').filter((l) => l.startsWith('[0:v]'));
    expect(videoLines).toHaveLength(2);
    for (const line of videoLines) {
      expect(line).toContain('format=gbrp');
      expect(line).toMatch(/setpts=N,scale=1080:1920:force_original_aspect_ratio=decrease/);
      expect(line).toMatch(/color=black\[v\d+\];$/);
    }
    expect(withContain.split('\n').filter((l) => l.startsWith('[0:a]') && l.includes('scale='))).toHaveLength(0);
  });

  it('区間の映像行が無い script は throw（黙って素材寸法のまま書き出さない）', () => {
    expect(() => applySegmentContain('[0:a]atrim=0:1[a0];\n', CONTAIN_SHORT)).toThrow(/区間の映像行/);
  });

  it('区間数が想定と違えば throw（一部の区間だけ contain が入った script を焼かない）', () => {
    const script = buildCutFilterScript([{ start: 0, end: 100 }, { start: 200, end: 300 }], 30);
    expect(() => applySegmentContain(script, CONTAIN_SHORT, 3)).toThrow(/想定 3 \/ 実際 2/);
    expect(() => applySegmentContain(script, CONTAIN_SHORT, 2)).not.toThrow();
  });
});

/**
 * C-8（codex 再レビュー P2）: **SAR≠1:1（非正方画素）素材**。
 *
 * 正典（Remotion）は `objectFit:'contain'` を**表示寸法**で解くので、1440×1080 SAR 4:3 の
 * 素材は 1920×1080 として内接する。native の contain は復号寸法（1440×1080）で解くため、
 * 前段で表示寸法へ正規化しないと縦長に歪む（16:9 composition に 4:3 として置かれ、
 * 出ないはずの左右黒帯が出る）。
 */
describe('containFilterFor: SAR≠1:1 の正規化（C-8）', () => {
  it('SAR≠1:1 なら contain の前段に表示寸法への正規化＋setsar=1 が入る', () => {
    const filter = containFilterFor(
      { width: 1440, height: 1080, exact: false, sar: 4 / 3 },
      { width: 1920, height: 1080 },
    );
    expect(filter).toBe(`${SAR_NORMALIZE_FILTER},${CONTAIN_16_9}`);
    // 正規化は「表示寸法へ」なので幅だけを sar 倍し（偶数丸め）、以後は正方画素として扱う。
    expect(SAR_NORMALIZE_FILTER).toBe('scale=trunc(iw*sar/2)*2:ih:flags=lanczos,setsar=1');
  });

  it('SAR=1:1 / SAR 不明では 1 文字も足さない（受入 E・不明は sar 変数が 0 で焼けない）', () => {
    expect(containFilterFor({ width: 1728, height: 3072, exact: true, sar: 1 }, { width: 1080, height: 1920 }))
      .toBe(CONTAIN_SHORT);
    // SAR 不明（probe が読めない）は exact=false で contain は入るが、正規化は入れない。
    expect(containFilterFor({ width: 1080, height: 1920, exact: false, sar: null }, { width: 1080, height: 1920 }))
      .toBe(CONTAIN_SHORT);
    // sar を持たない probe（旧型の注入）でも従来どおり。
    expect(containFilterFor({ width: 1080, height: 1920 }, { width: 1080, height: 1920 })).toBeNull();
  });

  it('SAR=1:1 かつ同寸は従来どおり null（正規化の追加で受入 E が壊れていない）', () => {
    expect(containFilterFor({ width: 1080, height: 1920, exact: true, sar: 1 }, { width: 1080, height: 1920 }))
      .toBeNull();
  });
});

describe('verifyOutputSize: 出力 SAR の検収（C-8）', () => {
  const ok = { width: 1920, height: 1080, sar: 1 };
  it('寸法一致かつ SAR=1:1 なら null', () => {
    expect(verifyOutputSize('/out.mp4', { width: 1920, height: 1080 }, () => ok)).toBeNull();
  });

  it('SAR≠1:1 の出力は拒否（表示寸法が想定と違う＝受入 F の壊れ方の SAR 版）', () => {
    const message = verifyOutputSize(
      '/out.mp4',
      { width: 1920, height: 1080 },
      () => ({ width: 1920, height: 1080, sar: 4 / 3 }),
    );
    expect(message).not.toBeNull();
    expect(message).toContain('SAR');
  });

  it('SAR を計測できない出力も拒否（フレーム数検査と同じ fail-loud）', () => {
    expect(verifyOutputSize('/out.mp4', { width: 1920, height: 1080 }, () => ({ width: 1920, height: 1080, sar: null })))
      .toContain('SAR');
    expect(verifyOutputSize('/out.mp4', { width: 1920, height: 1080 }, () => ({ width: 1920, height: 1080 })))
      .toContain('SAR');
  });

  /**
   * 丸め由来のごく小さい SAR ずれは通す（実測 1.000823 = 1216:1215・`force_divisible_by=2` の
   * 1px 丸めで `scale` が DAR 保存のため SAR を動かす）。厳密 1 で弾くと素材≠composition の
   * プロジェクトが全件 Remotion 退避になる。許容 1% はアナモルフィック（4:3 = 0.333）の 33 倍下。
   */
  it('丸め由来の微小ずれ（1.000823）は通し、1% 超は弾く', () => {
    expect(verifyOutputSize('/out.mp4', { width: 1080, height: 1920 }, () => ({ width: 1080, height: 1920, sar: 1.000823 })))
      .toBeNull();
    expect(SAR_VERIFY_TOLERANCE).toBe(0.01);
    expect(verifyOutputSize('/out.mp4', { width: 1080, height: 1920 }, () => ({ width: 1080, height: 1920, sar: 1.02 })))
      .toContain('SAR');
  });

  it('寸法不一致は従来どおり寸法のメッセージ', () => {
    expect(verifyOutputSize('/out.mp4', { width: 1080, height: 1920 }, () => ok)).toContain('1080x1920');
  });
});

describe('planFastCut: 素材寸法 ≠ videoConfig.resolution（C-0）', () => {
  it('(a) 同アスペクト不一致（1728×3072 → 1080×1920）は各区間に contain が入り、出力寸法は composition', () => {
    const dir = makeShortProject();
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1728, height: 3072 }),
      });
      expect(plan).not.toBeNull();
      // 出力寸法（= 表示用 target）は composition。素材の 1728×3072 ではない。
      expect(plan!.target).toEqual({ width: 1080, height: 1920 });
      const data = (written as unknown as { data: string }).data;
      // 主映像の**各区間**（2区間）に contain が入る。
      const containLines = data.split('\n').filter((l) => l.includes(CONTAIN_SHORT));
      expect(containLines).toHaveLength(2);
      for (const line of containLines) {
        expect(line.startsWith('[0:v]')).toBe(true);
        // 区間正規化（setpts）の**直後**・出力ラベルの直前に入る。
        expect(line).toMatch(/setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease/);
        expect(line).toMatch(/color=black\[v\d+\];$/);
      }
      // 音声の区間行には入らない。
      expect(data.split('\n').filter((l) => l.startsWith('[0:a]') && l.includes('scale='))).toHaveLength(0);
      // preset（full）は等倍なので最後段の縮小 scale は増えない。
      expect(data).not.toContain(':flags=lanczos[outv]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(a2) 図形 PNG は composition 寸法でラスタライズされる（素材寸法ではない）', () => {
    const dir = makeShortProject({ shapes: true });
    try {
      const rasterSizes: { width: number; height: number }[] = [];
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => {},
        writeBinaryFile: () => {},
        rasterizeShape: (_shape, width, height) => {
          rasterSizes.push({ width, height });
          return Buffer.from([]);
        },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1728, height: 3072 }),
      });
      expect(plan).not.toBeNull();
      expect(rasterSizes).toEqual([{ width: 1080, height: 1920 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) probed == composition なら script は従来と 1 文字不変（受入 E）', () => {
    const dir = makeShortProject();
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1080, height: 1920 }),
      });
      expect(plan).not.toBeNull();
      const data = (written as unknown as { data: string }).data;
      expect(data).toBe(buildCutFilterScript([{ start: 0, end: 100 }, { start: 200, end: 300 }], 30));
      expect(data).not.toContain('force_original_aspect_ratio');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * C-8: **製品経路の配線**。`containFilterFor` に SAR 正規化を足しても、`planFastCut` が
   * probe の `sar` を渡していなければ実プロジェクトでは無効のまま（部品だけ緑の半配線）。
   * ここは planFastCut が書いた script そのものを見る。
   */
  it('(h) SAR≠1:1 素材（1440×1080 SAR 4:3）は planFastCut が書く script にも正規化が入る', () => {
    const dir = makeShortProject();
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1440, height: 1080, exact: false, sar: 4 / 3 }),
      });
      expect(plan).not.toBeNull();
      const data = (written as unknown as { data: string }).data;
      const videoLines = data.split('\n').filter((l) => l.startsWith('[0:v]'));
      expect(videoLines).toHaveLength(2);
      for (const line of videoLines) {
        expect(line).toContain(`${SAR_NORMALIZE_FILTER},scale=1080:1920:force_original_aspect_ratio=decrease`);
      }
      // SAR=1:1 の素材では 1 文字も増えない（同じ経路の対照）。
      let plain: { data: string } | null = null;
      planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_path, d) => { plain = { data: d }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1440, height: 1080, exact: false, sar: 1 }),
      });
      expect((plain as unknown as { data: string }).data).not.toContain('setsar');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * I-3: **拡大側**（composition 3840×2160 × 素材 1920×1080）。
   * `probed.width > source.width` のような**片側条件**で contain を省く実装だと、
   * この向き（素材が composition より小さい）で contain が消えて受入 F が再発する。
   */
  it('(e) 拡大側（3840×2160 composition × 1920×1080 素材）でも各区間に contain が入る', () => {
    const dir = makeShortProject({ format: 'youtube' });
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1920, height: 1080 }),
      });
      expect(plan).not.toBeNull();
      expect(plan!.target).toEqual({ width: 3840, height: 2160 });
      const data = (written as unknown as { data: string }).data;
      expect(data.split('\n').filter((l) => l.includes(CONTAIN_4K))).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * I-3: **縮小 preset × 不一致素材**。区間 contain は composition（1080×1920）で、
   * preset 縮小（720p → 720×1280）は**最後段だけ**（C-2 の `[outv]` 契約）。
   * どちらか一方を target/composition で取り違えると、この 2 本の突合で赤になる。
   */
  it('(f) 縮小 preset（720p）× 不一致素材: 区間 contain は composition・最後段 scale は target', () => {
    const dir = makeShortProject();
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: '720p', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1728, height: 3072 }),
      });
      expect(plan).not.toBeNull();
      expect(plan!.target).toEqual({ width: 720, height: 1280 });
      const data = (written as unknown as { data: string }).data;
      // 区間 contain は composition 寸法（720×1280 ではない）。
      expect(data.split('\n').filter((l) => l.includes(CONTAIN_SHORT))).toHaveLength(2);
      // 最後段の縮小は target ちょうど・1 回だけ。
      expect(data).toContain('[catv]scale=720:1280:flags=lanczos[outv]');
      expect(data.split('scale=720:1280')).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * I-1: `probed` が**同寸でも `exact === false`（SAR≠1:1 / rotation 不明）なら contain を入れる**。
   * 同アスペクトでは pad が恒等なので副作用は無く、表示寸法が読み切れていないときに
   * 「等値だから素通し」で素材寸法のまま焼く事故（受入 F）を塞ぐ側へ倒す。
   */
  it('(g) 同寸でも exact=false（SAR/回転が読み切れない）なら contain を入れる', () => {
    const dir = makeShortProject();
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => ({ width: 1080, height: 1920, exact: false }),
      });
      expect(plan).not.toBeNull();
      const data = (written as unknown as { data: string }).data;
      expect(data.split('\n').filter((l) => l.includes(CONTAIN_SHORT))).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) 素材寸法を計測できない（null / 0）なら plan は null（Remotion 退避）', () => {
    const dir = makeShortProject();
    try {
      const common = {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
      };
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        ...common,
        probeSize: () => null,
      })).toBeNull();
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        ...common,
        probeSize: () => ({ width: 0, height: 1920 }),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
