import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planFastCut, planFastCutDetailed, CAPTURE_MS_PER_FRAME } from './fastCutPlan';
import { planCaptureRuns as realPlanCaptureRuns } from './captureRunPlanner';
import type { RenderCaptureEstimate } from './renderJobTypes';
import { buildCutFilterScript } from './fastCutRender';
import { applyAudioMix } from './nativeExportAudio';
import { buildDuckGainExpr } from './duckGainExpr';
import { loadProject } from '../core';
import { readProjectFiles } from './loadProjectFiles';
import { nativeUnsupportedReasons } from '../shared/cutsOnly';
import { __setResvgRequireForTest, __resetResvgRequireForTest } from './shapeRaster';
import type { DuckEnvelope, TranscriptWord } from '../core/types';
import type { ResolveChromiumResult } from './resolveChromium';

interface SeItemFixture {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  volume?: number;
}

interface ShapeItemFixture {
  id: number;
  startFrame: number;
  endFrame: number;
  kind?: 'arrow' | 'line' | 'rect' | 'ellipse';
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  color?: string;
  thickness?: 'thin' | 'medium' | 'thick';
  opacity?: number;
}

interface TelopItemFixture {
  id: number;
  startFrame: number;
  endFrame: number;
  text: string;
  template?: number;
  /** 2点アニメ／キーフレーム（F-1）。telopData.ts へそのまま書き出す。 */
  motion?: Record<string, unknown>;
}

interface TitleItemFixture {
  id: number;
  startFrame: number;
  endFrame: number;
  text: string;
}

interface ImageItemFixture {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  type?: 'photo' | 'infographic' | 'overlay';
}

interface BgmItemFixture {
  id: number;
  file: string;
  startFrame: number;
  endFrame: number;
  volume?: number;
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** true なら bgmData.ts にダッキング焼き込み（'ducking:' を含む形）を書く。 */
  ducking?: boolean;
}

interface TransitionItemFixture {
  id: number;
  /** 原本フレーム（`computeJoins` の atOriginal）または 'head' / 'tail'。 */
  at: number | 'head' | 'tail';
  kind: 'crossfade' | 'slide' | 'wipe' | 'fadeBlack' | 'fadeWhite' | 'fadeColor';
  durationFrames: number;
  direction?: 'left' | 'right' | 'up' | 'down';
  color?: string;
}

/** テロップ等が空の最小プロジェクトを作る（cuts=残す区間の指定）。 */
function makeProject(opts: {
  telops?: boolean;
  cuts?: boolean;
  se?: boolean;
  seAsset?: boolean;
  seItems?: SeItemFixture[];
  bgm?: boolean;
  bgmAsset?: boolean;
  bgmItems?: BgmItemFixture[];
  words?: TranscriptWord[];
  shapes?: boolean;
  shapeItems?: ShapeItemFixture[];
  /** テロップ（原本フレームアンカー）。telops:true の既定より細かく指定したいとき。 */
  telopItems?: TelopItemFixture[];
  /**
   * `src/テロップテンプレート/TelopPlayer.tsx` を置く（F-1）。
   * true = キーフレーム対応の目印つき / false = 旧版（目印なし）/ 省略 = ファイル自体を置かない。
   */
  telopPlayerKeys?: boolean;
  /** タイトル（原本フレームアンカー）。 */
  titleItems?: TitleItemFixture[];
  /** 挿入画像（原本フレームアンカー）。 */
  imageItems?: ImageItemFixture[];
  /** videoConfig.ts に TELOP_CONFIG を書く（titleStyle が解像度既定と別値になる）。 */
  telopConfig?: { titleTop: number; titleLeft: number; titleFontSize: number };
  /**
   * シーン転換（**at は原本フレーム**・M3 T5）。`src/Transition/transitionData.ts` を書く。
   * 原本 at は `computeJoins` の `atOriginal`（= 前区間の originalEnd）と一致させること
   * （既定 cuts fixture では 100）。一致しない at は正典どおり捨てられる。
   */
  transitionItems?: TransitionItemFixture[];
  /**
   * サブ動画（`src/InsertVideo/insertVideoData.ts`）を 1 本置く（M3 B-7 M-1）。
   * ゲート（`cutsOnly`）が**まだ閉じている唯一の要因**なので、「転換は開いたがゲート機構は
   * 生きている」ことを実 plan で示すのに使う。
   */
  videoInsert?: boolean;
  /**
   * サブ動画の中身を細かく指定する（M4 T5・`videoInsert: true` の既定より複雑な形）。
   * 併せて `videoInsertAsset: true` を渡すと `public/` に実体（ダミー）を置く——
   * 置かないと T3 の退避（ファイルが無い）で plan が null になり、
   * **ゲートの検査のつもりが退避の検査になる**（緑の理由が変わる）。
   */
  videoInsertItems?: Array<{
    id: number;
    startFrame: number;
    endFrame: number;
    file: string;
    sourceInFrame: number;
    playbackRate?: number;
    position?: { x: number; y: number };
    scale?: number;
    enter?: { kind: string; frames: number; direction?: string };
    exit?: { kind: string; frames: number; direction?: string };
  }>;
  videoInsertAsset?: boolean;
  /** `src/speedData.ts` を書く（`mainSpeed !== 1` は nativeExport が**まだ**扱えない要因）。 */
  mainSpeed?: number;
} = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-fastcut-')));
  mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'videoConfig.ts'),
    [
      "export type VideoFormat = 'youtube' | 'short' | 'square';",
      "export const FORMAT: VideoFormat = 'youtube';",
      'export const FPS = 30;',
      'export const DURATION_FRAMES = 300;',
      "export const VIDEO_FILE = 'main.mp4';",
      'const RESOLUTION_MAP = {',
      '  youtube: { width: 3840, height: 2160 },',
      '  short: { width: 1080, height: 1920 },',
      '  square: { width: 1080, height: 1080 },',
      '} as const;',
      'export const RESOLUTION = RESOLUTION_MAP[FORMAT];',
      ...(opts.telopConfig === undefined
        ? []
        : [
            'export const TELOP_CONFIG = {',
            `  titleTop: ${opts.telopConfig.titleTop},`,
            `  titleLeft: ${opts.telopConfig.titleLeft},`,
            `  titleFontSize: ${opts.telopConfig.titleFontSize},`,
            '};',
          ]),
    ].join('\n'),
  );
  const telopItems = opts.telopItems ?? (opts.telops === true
    ? [{ id: 1, startFrame: 0, endFrame: 30, text: 'あ', template: 1 }]
    : []);
  const telops = telopItems.length === 0
    ? '[]'
    : '[' + telopItems.map((t) =>
        `{ id: ${t.id}, startFrame: ${t.startFrame}, endFrame: ${t.endFrame}, text: ${JSON.stringify(t.text)}, template: ${t.template ?? 1}${t.motion === undefined ? '' : `, motion: ${JSON.stringify(t.motion)}`} }`,
      ).join(', ') + ']';
  writeFileSync(
    join(dir, 'src', 'テロップテンプレート', 'telopData.ts'),
    [
      'export const FPS = 30;',
      'export const TOTAL_FRAMES = 300;',
      `export const telopData = ${telops};`,
    ].join('\n'),
  );
  if (opts.telopPlayerKeys !== undefined) {
    // F-1: キーの適用者は案件側のラッパー。目印の有無で「書き出しに反映されるか」が決まる。
    writeFileSync(
      join(dir, 'src', 'テロップテンプレート', 'TelopPlayer.tsx'),
      opts.telopPlayerKeys
        ? '// MOTION_KEYFRAMES_V1\nexport const TelopPlayer = () => null;\n'
        : 'export const TelopPlayer = () => null;\n',
    );
  }
  if (opts.cuts !== false) {
    writeFileSync(
      join(dir, 'src', 'cutData.ts'),
      'export const cutData = [\n' +
        '  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },\n' +
        '  { id: 2, originalStart: 200, originalEnd: 300, playbackStart: 100, playbackEnd: 200 },\n' +
        '];\n',
    );
  }
  writeFileSync(
    join(dir, 'transcript.json'),
    JSON.stringify({ engine: 'none', language: 'ja', duration_ms: 10000, words: opts.words ?? [], segments: [] }),
  );
  if (opts.se === true) {
    const items = opts.seItems ?? [{ id: 1, startFrame: 10, endFrame: 20, file: 'chime.mp3' }];
    mkdirSync(join(dir, 'src', 'SoundEffects'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'SoundEffects', 'seData.ts'),
      [
        "export const seData = [",
        ...items.map(
          (it) =>
            `  { id: ${it.id}, startFrame: ${it.startFrame}, endFrame: ${it.endFrame}, file: '${it.file}'` +
            (it.volume !== undefined ? `, volume: ${it.volume}` : '') +
            ' },',
        ),
        "];",
      ].join('\n'),
    );
    if (opts.seAsset !== false) {
      mkdirSync(join(dir, 'public', 'se'), { recursive: true });
      for (const it of items) {
        writeFileSync(join(dir, 'public', 'se', it.file), '');
      }
    }
  }
  if (opts.bgm === true) {
    const items = opts.bgmItems ?? [
      { id: 1, file: 'loop.mp3', startFrame: 110, endFrame: 170, volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0 },
    ];
    mkdirSync(join(dir, 'src', 'Bgm'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'Bgm', 'bgmData.ts'),
      [
        'export const bgmData = [',
        ...items.map((it) => {
          const duckingLine = it.ducking
            ? "    ducking: { gain: 0.5, attackFrames: 3, releaseFrames: 9, regions: [{ start: 0, end: 5 }] },\n"
            : '';
          return (
            '  {\n' +
            `    id: ${it.id},\n` +
            `    file: '${it.file}',\n` +
            `    startFrame: ${it.startFrame},\n` +
            `    endFrame: ${it.endFrame},\n` +
            `    volume: ${it.volume ?? 1},\n` +
            `    fadeInFrames: ${it.fadeInFrames ?? 0},\n` +
            `    fadeOutFrames: ${it.fadeOutFrames ?? 0},\n` +
            duckingLine +
            '  },'
          );
        }),
        '];',
      ].join('\n'),
    );
    if (opts.bgmAsset !== false) {
      mkdirSync(join(dir, 'public', 'BGM'), { recursive: true });
      for (const it of items) {
        writeFileSync(join(dir, 'public', 'BGM', it.file), '');
      }
    }
  }
  if (opts.shapes === true) {
    const items = opts.shapeItems ?? [
      { id: 1, startFrame: 40, endFrame: 80, kind: 'line' as const, x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff', thickness: 'thin' as const, opacity: 0.5 },
    ];
    mkdirSync(join(dir, 'src', 'InsertShape'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'InsertShape', 'shapeData.ts'),
      [
        "export const shapeData = [",
        ...items.map(
          (it) =>
            `  { id: ${it.id}, startFrame: ${it.startFrame}, endFrame: ${it.endFrame}, kind: '${it.kind ?? 'line'}', ` +
            `x1: ${it.x1 ?? 0}, y1: ${it.y1 ?? 0}, x2: ${it.x2 ?? 1}, y2: ${it.y2 ?? 1}, color: '${it.color ?? '#fff'}', ` +
            `thickness: '${it.thickness ?? 'thin'}'` +
            (it.opacity !== undefined ? `, opacity: ${it.opacity}` : '') +
            ' },',
        ),
        "];",
      ].join('\n'),
    );
  }
  if (opts.titleItems !== undefined && opts.titleItems.length > 0) {
    mkdirSync(join(dir, 'src', 'Title'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'Title', 'titleData.ts'),
      'export const titleData = [\n' +
        opts.titleItems
          .map((t) => `  { id: ${t.id}, startFrame: ${t.startFrame}, endFrame: ${t.endFrame}, text: ${JSON.stringify(t.text)} },`)
          .join('\n') +
        '\n];\n',
    );
  }
  if (opts.imageItems !== undefined && opts.imageItems.length > 0) {
    mkdirSync(join(dir, 'src', 'InsertImage'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'InsertImage', 'insertImageData.ts'),
      'export const insertImageData = [\n' +
        opts.imageItems
          .map((i) =>
            `  { id: ${i.id}, startFrame: ${i.startFrame}, endFrame: ${i.endFrame}, file: ${JSON.stringify(i.file)}, type: ${JSON.stringify(i.type ?? 'photo')} },`,
          )
          .join('\n') +
        '\n];\n',
    );
  }
  if (opts.transitionItems !== undefined && opts.transitionItems.length > 0) {
    mkdirSync(join(dir, 'src', 'Transition'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'Transition', 'transitionData.ts'),
      'export const transitionData = [\n' +
        opts.transitionItems
          .map(
            (t) =>
              `  { id: ${t.id}, at: ${typeof t.at === 'number' ? t.at : JSON.stringify(t.at)}, ` +
              `kind: ${JSON.stringify(t.kind)}, durationFrames: ${t.durationFrames}` +
              (t.direction !== undefined ? `, direction: ${JSON.stringify(t.direction)}` : '') +
              (t.color !== undefined ? `, color: ${JSON.stringify(t.color)}` : '') +
              ' },',
          )
          .join('\n') +
        '\n];\n',
    );
  }
  const inserts =
    opts.videoInsertItems ??
    (opts.videoInsert === true
      ? [{ id: 1, startFrame: 10, endFrame: 40, file: 'sub.mp4', sourceInFrame: 0 }]
      : undefined);
  if (inserts !== undefined) {
    mkdirSync(join(dir, 'src', 'InsertVideo'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'InsertVideo', 'insertVideoData.ts'),
      `export const insertVideoData = ${JSON.stringify(inserts, null, 2)};\n`,
    );
    if (opts.videoInsertAsset === true) {
      for (const f of new Set(inserts.map((v) => v.file))) writeFileSync(join(dir, 'public', f), '');
    }
  }
  if (opts.mainSpeed !== undefined) {
    writeFileSync(
      join(dir, 'src', 'speedData.ts'),
      `export const MAIN_SPEED = ${opts.mainSpeed};\nexport const SEGMENT_SPEEDS: Record<number, number> = {};\n`,
    );
  }
  return dir;
}

/**
 * 素材（`public/main.mp4`）の実寸（C-6）。fixture の composition（youtube = 3840x2160）と
 * **同値**にして、contain（C-0）が恒等になる＝ script が従来と 1 文字も変わらないようにする。
 *
 * 本ファイルの fixture は素材ファイルを置かないが、製品は**無条件に probe する**（C-6）ので
 * ここを注入しないとテストが製品と別の分岐（plan null）を通る。
 */
const SOURCE_SIZE = { width: 3840, height: 2160, exact: true } as const;

describe('planFastCut', () => {
  it('independent BGM crosses a reordered join at its final time without a second projection', () => {
    const dir = makeProject({ bgm: true, bgmItems: [{ id: 1, file: 'loop.mp3', startFrame: 95, endFrame: 105 }] });
    try {
      writeFileSync(join(dir, 'src/cutData.ts'), 'export const cutData = [{id:2,originalStart:200,originalEnd:300,playbackStart:0,playbackEnd:100},{id:1,originalStart:0,originalEnd:100,playbackStart:100,playbackEnd:200}];');
      writeFileSync(join(dir, 'editor-timeline.json'), JSON.stringify({ version: 1, placements: [{ collection: 'bgm', id: 1, originalStart: 0, originalEnd: 10 }] }));
      let script = '';
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true, writeFile: (_path, data) => { script = data; },
        probeRates: () => ({ r: 30, avg: 30 }), probeUniform: () => true, probeSize: () => SOURCE_SIZE,
      });
      expect(plan).not.toBeNull();
      expect(script).toContain('adelay=3167:all=1');
      expect(script).toContain('atrim=0:0.333333');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('カットだけのプロジェクトは ffmpeg 引数とフィルタスクリプトを組み立てる', () => {
    const dir = makeProject();
    try {
      let written: { path: string; data: string } | null = null;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (path, data) => { written = { path, data }; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      });
      expect(plan).not.toBeNull();
      // 残すのは [0,100) と [200,300)＝200 フレーム。
      expect(plan?.totalFrames).toBe(200);
      expect(plan?.target).toEqual({ width: 3840, height: 2160 });
      expect(plan?.args.join(' ')).toContain(join(dir, 'public', 'main.mp4'));
      expect(written).not.toBeNull();
      const w = written as unknown as { path: string; data: string };
      // M-4: ジョブ token が名前に混ざる。
      expect(w.path).toMatch(/[/\\]cut-filter-[a-z0-9-]+\.txt$/);
      expect(w.path.startsWith(join(dir, 'out', 'cut-filter-'))).toBe(true);
      expect(w.data).toContain('concat=n=2:v=1:a=1[outv][outa]');
      // 等倍なのでスケールフィルタは入らない。
      expect(w.data).not.toContain('scale=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('焦点再レビュー必須1: 非撮影経路（図形あり）は plan.cleanup が filterScript と .shape-*.png を削除する', () => {
    const dir = makeProject({ shapes: true });
    try {
      const removed: string[] = [];
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => {},
        writeBinaryFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: { removeDir: (p) => { removed.push(p); } },
      });
      expect(plan).not.toBeNull();
      expect(plan!.prepareCapture).toBeUndefined();
      expect(plan!.cleanup).toBeTypeOf('function');
      plan!.cleanup!();
      // filterScript(cut-filter-*.txt) + shapePngPaths(.shape-0-*.png) の2件。
      expect(removed).toHaveLength(2);
      expect(removed.some((p) => /cut-filter-[a-z0-9-]+\.txt$/.test(p))).toBe(true);
      expect(removed.some((p) => /\.shape-0-[a-z0-9-]+\.png$/.test(p))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('焦点再レビュー必須1: cleanup の1件が throw しても他の削除・呼び出し元を止めない', () => {
    const dir = makeProject({ shapes: true });
    try {
      const removed: string[] = [];
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => {},
        writeBinaryFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: {
          removeDir: (p) => {
            if (p.includes('.shape-')) throw new Error('EBUSY');
            removed.push(p);
          },
        },
      });
      expect(() => plan!.cleanup!()).not.toThrow();
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatch(/cut-filter-[a-z0-9-]+\.txt$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'codex-review P2: 撮影経路の適格性チェック（projectId 未指定）で不成立になっても' +
      '図形PNGを書き出さない（ラスタライズより前にチェックする・実ファイルで検算）',
    () => {
      // telops:true で hasCaptureOverlays=true にし、shapes:true で図形PNGラスタライズの
      // 対象を作る。capture（projectId）を渡さないので撮影経路として不成立＝ plan は null
      // になる。旧コードはこの判定の前に図形PNGを書き出していたため out/ に
      // `.shape-*-{token}.png` が残り続けていた（書き出しのたびに新token）。
      // writeBinaryFile/rasterizeShape は既定実体（実 fs 書き込み・実 resvg）のまま使う——
      // モックで「書かれなかった」ことにしていないかを実ファイルで検算するため。
      const dir = makeProject({ shapes: true, telops: true });
      try {
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => {},
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
          // capture 未指定＝ projectId 無し＝撮影経路が不成立。
        });
        expect(plan).toBeNull();
        const outEntries = readdirSync(join(dir, 'out'));
        expect(
          outEntries.filter((e) => e.startsWith('.shape-')),
          `out/ に図形PNGが残っている（リーク）: ${JSON.stringify(outEntries)}`,
        ).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('1080p を選ぶと concat の後段に縮小を 1 回だけ挟む', () => {
    const dir = makeProject();
    try {
      let data = '';
      planFastCut(dir, { resolution: '1080p', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_p, d) => { data = d; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      });
      expect(data).toContain('[catv]scale=1920:1080:flags=lanczos[outv]');
      expect(data.match(/scale=/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('テロップがあるのに撮影 deps（部品ロード）が無ければ null（従来どおり黙って通常経路へ）', () => {
    // M2c: ゲート（cutsOnly）は開いたが、Node で Telop 部品を解決する手段が無い環境では
    // 撮影経路は成立しない。挙動は M2b までと同じ（Remotion 経路・退避通知だけが出る）。
    const dir = makeProject({ telops: true });
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('読み取れないプロジェクトは null（黙って通常経路へ）', () => {
    expect(planFastCut('/does/not/exist', { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
      hardware: true,
      writeFile: () => { /* 呼ばれない */ },
    })).toBeNull();
  });

  it('フレームレートが計測できなければ null（安全側で通常経路へ）', () => {
    const dir = makeProject();
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => null,
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('VFR（r と avg の乖離）は null（trim 秒指定がフレーム境界とずれるため）', () => {
    const dir = makeProject();
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 29.5 }),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('宣言 fps との乖離は null', () => {
    const dir = makeProject();
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 24, avg: 24 }),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('平均一致でもフレーム長が不均一（probeUniform=false）なら null（平均一致 VFR の素通し対策）', () => {
    const dir = makeProject();
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => false,
        probeSize: () => (SOURCE_SIZE),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('フレーム長一様性が判定不能（probeUniform=null）なら null（安全側で通常経路へ）', () => {
    const dir = makeProject();
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => null,
        probeSize: () => (SOURCE_SIZE),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SE 付きプロジェクトは plan が生成され args に SE の -i・filter に amix が入る', () => {
    const dir = makeProject({ se: true });
    try {
      let data = '';
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_p, d) => { data = d; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      });
      expect(plan).not.toBeNull();
      expect(plan?.args.join(' ')).toContain(join(dir, 'public', 'se', 'chime.mp3'));
      expect(data).toContain('amix=inputs=2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SE ファイルが public/se に存在しない場合は null（安全側で Remotion）', () => {
    const dir = makeProject({ se: true, seAsset: false });
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('I-1: SE がカットに跨ぐ位置にある場合の adelay 実値と入力順を固定する', () => {
    // cutRegion=[100,200)（既定 cuts fixture）。
    // SE1（chime.mp3）: disk startFrame=110（カット後の再生座標）
    //   → anchorSe で原本 210 へアンカー（playbackToOriginal: 110>=100 なので +100）
    //   → deriveSePlayback で再び originalToPlayback（210>=200 なので -100）→ 再生 110 に戻る
    //   → adelay = round(110/30*1000) = 3667ms
    // SE2（pon.mp3）: disk startFrame=10（カット前）→ カットの影響を受けず再生 10 のまま
    //   → adelay = round(10/30*1000) = 333ms
    const dir = makeProject({
      se: true,
      seItems: [
        { id: 1, startFrame: 110, endFrame: 120, file: 'chime.mp3' },
        { id: 2, startFrame: 10, endFrame: 20, file: 'pon.mp3' },
      ],
    });
    try {
      let data = '';
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_p, d) => { data = d; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      });
      expect(plan).not.toBeNull();
      expect(data).toContain('adelay=3667:all=1[mix0]');
      expect(data).toContain('adelay=333:all=1[mix1]');
      const args = (plan as unknown as { args: string[] }).args;
      expect(args.indexOf(join(dir, 'public', 'se', 'chime.mp3')))
        .toBeLessThan(args.indexOf(join(dir, 'public', 'se', 'pon.mp3')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SE 無しプロジェクトのフィルタスクリプトは従来と 1 文字も変わらない（回帰ガード）', () => {
    const dir = makeProject();
    try {
      let data = '';
      planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_p, d) => { data = d; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      });
      const expected = buildCutFilterScript(
        [{ start: 0, end: 100 }, { start: 200, end: 300 }],
        30,
      );
      expect(data).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(a) BGM＋SE 混在（カットを跨ぐ）は adelay 実値・volume・-stream_loop -1・入力順（se→bgm）を pin する', () => {
    // cutRegions=[{start:100,end:200}]（既定 cuts fixture の除去区間）。
    // SE(pon.mp3): disk startFrame=10（カットの影響を受けず再生 10 のまま）→ adelay=333ms
    // BGM1(loop.mp3): disk startFrame=110（カット後の再生座標。除去区間の「後ろ」のみに存在）
    //   → anchor で原本 210 へ（playbackToOriginal(110): 110>=100 なので 110+100=210）
    //   → deriveBgmPlayback で再び originalToPlayback(210)（210>=200 なので 210-100=110）→ 再生 110 に戻る
    //   → adelay = round(110/30*1000) = 3667ms
    //   （このクリップは originalStart=210, originalEnd=270 が両方とも除去区間 [100,200) の
    //   「後ろ」にあり、clampBgm の分岐（start/end が除去区間の内側に落ちるケース）を通らない）
    // BGM2(span.mp3): disk startFrame=50, endFrame=170（除去区間を実際に原本座標で跨ぐ）
    //   → anchor: originalStart=playbackToOriginal(50)。50<100 なので cut の影響を受けず 50 のまま。
    //             originalEnd=playbackToOriginal(170)。170>=100 なので 170+100=270。
    //     → EditorBgmClip: originalStart=50, originalEnd=270（除去区間 [100,200) の前後に実際に伸びる）。
    //   → clampBgm: start=50 は [100,200) の内側ではない（50<100）・end=270 も内側ではない（270>200）
    //     ので変更なし・flaggedIds も立たない（このクリップは除去区間を "跨ぐ" が、
    //     どちらの端も区間の内側には落ちないため clamp 自体は発火しない。これは正しい —
    //     区間の内外どちらにも端が無いクリップは端を寄せる必要がなく、
    //     originalToPlayback 側の平行移動だけで正しい再生区間が導出される）。
    //   → projectBgm: start=originalToPlayback(50)。cut.start=100 未満なので removed=0 → 50。
    //                 end=originalToPlayback(270)。270>=cut.end=200 なので removed=100 → 270-100=170。
    //     → 再生区間 [50,170)（disk と同じ値に戻る — 除去区間ぶんの平行移動が始点・終点の
    //     両方に等しく効いて往復が恒等になるのは、除去区間がクリップの内部にすっぽり収まる
    //     この形の場合に限られる。恒等に戻ることそのものが「clamp 非発火・projectBgm の
    //     平行移動が正しく効いている」ことの検算になる）。
    //   → adelay = round(50/30*1000) = 1667ms
    const dir = makeProject({
      se: true,
      seItems: [{ id: 1, startFrame: 10, endFrame: 20, file: 'pon.mp3', volume: 0.7 }],
      bgm: true,
      bgmItems: [
        { id: 1, file: 'loop.mp3', startFrame: 110, endFrame: 170, volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0 },
        // I-3: fade を付けて mixClips→applyAudioMix の配線を pin する。
        // durFrames = 170-50 = 120。
        // afade in: st=0, d=sec(6,30)=0.200000。
        // afade out: startFrame=max(0, 120-1-9)=110 → st=sec(110,30)=3.666667、
        //            dFrames=max(1, 120-1-110)=9 → d=sec(9,30)=0.300000。
        { id: 2, file: 'span.mp3', startFrame: 50, endFrame: 170, volume: 0.4, fadeInFrames: 6, fadeOutFrames: 9 },
      ],
    });
    try {
      let data = '';
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_p, d) => { data = d; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      });
      expect(plan).not.toBeNull();
      // se が先（mix0）・bgm が後（bgmItems の宣言順で mix1・mix2）。
      expect(data).toContain('adelay=333:all=1[mix0]');
      expect(data).toContain('adelay=3667:all=1[mix1]');
      expect(data).toContain('adelay=1667:all=1[mix2]'); // 跨ぎクリップ（BGM2）の pin
      // volume が SE/BGM 取り違えなく各 mix チェーンに入っていること（同一行内で adelay とセットで確認）。
      expect(data).toMatch(/\[1:a\][^\n]*volume=0\.7[^\n]*adelay=333:all=1\[mix0\]/);
      expect(data).toMatch(/\[2:a\][^\n]*volume=0\.2[^\n]*adelay=3667:all=1\[mix1\]/);
      expect(data).toMatch(/\[3:a\][^\n]*volume=0\.4[^\n]*adelay=1667:all=1\[mix2\]/);
      // I-3: BGM の fade が mixClips→applyAudioMix の同一チェーン行に現れることを pin
      // （SE 側 [mix0] の行には afade が漏れていないことも本テストの他アサーションで分かる）。
      expect(data).toMatch(
        /\[3:a\][^\n]*afade=t=in:st=0:d=0\.200000[^\n]*afade=t=out:st=3\.666667:d=0\.300000[^\n]*adelay=1667:all=1\[mix2\]/,
      );
      // SE の行（[mix0] で終わる）に afade が混入していないこと（漏れ配線の検知）。
      const mix0Line = data.split('\n').find((l) => l.includes('[mix0];'));
      expect(mix0Line).not.toContain('afade');
      const args = (plan as unknown as { args: string[] }).args;
      const sePath = join(dir, 'public', 'se', 'pon.mp3');
      const bgmPath = join(dir, 'public', 'BGM', 'loop.mp3');
      const bgmPath2 = join(dir, 'public', 'BGM', 'span.mp3');
      const seIdx = args.indexOf(sePath);
      const bgmIdx = args.indexOf(bgmPath);
      const bgmIdx2 = args.indexOf(bgmPath2);
      expect(seIdx).toBeGreaterThan(-1);
      expect(bgmIdx).toBeGreaterThan(seIdx);
      expect(bgmIdx2).toBeGreaterThan(bgmIdx);
      // BGM 入力の直前に -stream_loop -1（SE には付かない）。両方の BGM 入力で確認する。
      expect(args[bgmIdx - 1]).toBe('-i');
      expect(args[bgmIdx - 2]).toBe('-1');
      expect(args[bgmIdx - 3]).toBe('-stream_loop');
      expect(args[bgmIdx2 - 1]).toBe('-i');
      expect(args[bgmIdx2 - 2]).toBe('-1');
      expect(args[bgmIdx2 - 3]).toBe('-stream_loop');
      expect(args[seIdx - 1]).toBe('-i');
      expect(args[seIdx - 2]).not.toBe('-stream_loop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b) bgmData.ts にダッキングが焼き込まれていれば null（Remotion 経路へ・M1c まで非対応）', () => {
    const dir = makeProject({
      bgm: true,
      bgmItems: [{ id: 1, file: 'loop.mp3', startFrame: 110, endFrame: 170, ducking: true }],
    });
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(b2) I-1: 1 行に潰した ducking 焼き込みでも null（評価済みモジュール判定・整形非依存のアブレーション）', () => {
    // 旧実装の /^\s*ducking\s*:/m は「行頭の ducking:」しか拾えないため、
    // 1 行に潰された bgmData.ts（ducking が行頭に来ない）では検知漏れになり、
    // ダッキング焼き込み済み BGM が誤って native 経路に通ってしまっていた。
    const dir = makeProject({ bgm: true });
    try {
      writeFileSync(
        join(dir, 'src', 'Bgm', 'bgmData.ts'),
        "export const bgmData = [{ id:1, file:'loop.mp3', startFrame:0, endFrame:45, volume:0.2, fadeInFrames:0, fadeOutFrames:0, ducking: { gain: 0.3 } }];",
      );
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) BGM ファイルが public/BGM に存在しない場合は null（安全側で Remotion）', () => {
    const dir = makeProject({ bgm: true, bgmAsset: false });
    try {
      expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => { /* 呼ばれない */ },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) planFastCut の SE 配線が applyAudioMix と一致する（BGM 無し・SE のみ）', () => {
    const dir = makeProject({ se: true });
    try {
      let data = '';
      planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: (_p, d) => { data = d; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
      });
      const base = buildCutFilterScript([{ start: 0, end: 100 }, { start: 200, end: 300 }], 30);
      // makeProject の既定 SE item: { id: 1, startFrame: 10, endFrame: 20, file: 'chime.mp3' }
      // 10 はカット区間 [100,200) の外なので、往復しても再生座標は 10 のまま。
      const expected = applyAudioMix(base, [
        { startFrame: 10, endFrame: 20, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
      ], 30);
      expect(data).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('M1c: リクエスト受け口と fastCutPlan 配線（二層ゲート）', () => {
    // makeProject 既定の cuts fixture: cutRegions=[{start:100,end:200}]（原本上の除去区間）。
    // makeProject 既定 bgmItems: loop.mp3 startFrame=110, endFrame=170（往復して再生座標も同じ）。
    const words: TranscriptWord[] = [
      // 原本フレーム [180,219)（180=6000ms, 219=7300ms・fps30 で round が整数に落ちる値を選定）。
      { text: 'x', start: 6000, end: 7300 },
    ];

    it('(a) ducking supplied（enabled・mid）＋カット越しの words → BGM チェーンに volume 式（SE には漏れない・境界は手計算と一致）', () => {
      const dir = makeProject({ bgm: true, se: true, words });
      try {
        let data = '';
        const plan = planFastCut(
          dir,
          { resolution: 'full', quality: 'high', ducking: { enabled: true, strength: 'mid' } },
          '/out/tmp.mp4',
          {
            hardware: true,
            writeFile: (_p, d) => { data = d; },
            probeRates: () => ({ r: 30, avg: 30 }),
            probeUniform: () => true,
            probeSize: () => (SOURCE_SIZE),
          },
        );
        expect(plan).not.toBeNull();

        // 手計算（speechRegionsToPlayback の座標変換を検算）:
        // buildSpeechRegions: word[6000ms,7300ms] → frame[round(6000/1000*30)=180, round(7300/1000*30)=219)。
        // speechRegionsToPlayback（cuts=[{100,200}]）:
        //   start=180: 100<=180<200 の除去区間内 → c.end=200 へ寄せる（クランプ＝座標変換が効く箇所）。
        //   end=219: 219<=200 は成立しない（区間外）→ 219 のまま。
        //   → クランプ後 [200,219)。
        //   pStart=originalToPlayback(200): 200>=cut.end(200) → removed=100 → monotone=200-100=100。
        //   pEnd=originalToPlayback(219): 219>=200 → removed=100 → monotone=219-100=119。
        //   → 再生座標の喋り区間 [100,119)。
        // BGM クリップ（再生座標）[110,170) と交差: start=max(100,110)=110, end=min(119,170)=119。
        //   → クリップ内相対 region: [110-110, 119-110) = [0,9)。
        // gain=DUCK_GAIN.mid=0.5、attackFrames=round(0.1*30)=3、releaseFrames=round(0.3*30)=9。
        const envelope: DuckEnvelope = {
          regions: [{ start: 0, end: 9 }],
          gain: 0.5,
          attackFrames: 3,
          releaseFrames: 9,
        };
        const expectedExpr = buildDuckGainExpr(envelope, 30);
        expect(expectedExpr).not.toBeNull();
        // 全一致（部分一致だと「ducking が SE 側に漏れる」「BGM に二重適用される」変異を検出できない）。
        // SE クリップ（makeProject 既定: id:1, startFrame:10, endFrame:20, file:'chime.mp3'）は
        // mixClips の先頭に来るが ducking を渡さない — SE への漏れ変異はこの (a) の全一致で検出する。
        const base = buildCutFilterScript([{ start: 0, end: 100 }, { start: 200, end: 300 }], 30);
        const expected = applyAudioMix(base, [
          { startFrame: 10, endFrame: 20, volume: 1 },
          { startFrame: 110, endFrame: 170, volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0, ducking: envelope },
        ], 30);
        expect(data).toBe(expected);
        // 式は BGM の 1 系統だけ（SE に漏れていれば 2 以上になる）。
        expect(data.match(/volume='/g)?.length).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('(b) ducking supplied だが enabled:false → volume 式なし・M1b と同一チェーン', () => {
      const dir = makeProject({ bgm: true, words });
      try {
        let data = '';
        const plan = planFastCut(
          dir,
          { resolution: 'full', quality: 'high', ducking: { enabled: false, strength: 'mid' } },
          '/out/tmp.mp4',
          {
            hardware: true,
            writeFile: (_p, d) => { data = d; },
            probeRates: () => ({ r: 30, avg: 30 }),
            probeUniform: () => true,
            probeSize: () => (SOURCE_SIZE),
          },
        );
        expect(plan).not.toBeNull();
        expect(data).not.toContain("volume='");
        const base = buildCutFilterScript([{ start: 0, end: 100 }, { start: 200, end: 300 }], 30);
        const expected = applyAudioMix(base, [
          { startFrame: 110, endFrame: 170, volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0 },
        ], 30);
        expect(data).toBe(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('(c) ducking 未供給＋焼き込みあり → null（従来ゲート回帰。M1b (b2) fixture 流用）', () => {
      const dir = makeProject({ bgm: true });
      try {
        writeFileSync(
          join(dir, 'src', 'Bgm', 'bgmData.ts'),
          "export const bgmData = [{ id:1, file:'loop.mp3', startFrame:0, endFrame:45, volume:0.2, fadeInFrames:0, fadeOutFrames:0, ducking: { gain: 0.3 } }];",
        );
        expect(planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => { /* 呼ばれない */ },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        })).toBeNull();
        // 理由 pin: 将来別の理由（telops 等）で null になる退行と区別する。
        const project = loadProject(readProjectFiles(dir));
        expect(nativeUnsupportedReasons({ ...project, bgmDucking: true })).toContain('ducking');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('C-1 安全弁: region 数が MAX_DUCK_REGIONS を超えると plan は null（DuckGainRegionLimitExceededError を捕捉して Remotion 経路へ退避）', () => {
      // gapMergeFrames(=round(0.4*30)=12) を超える間隔(14 frame周期)で単語を離散配置し、
      // buildSpeechRegions が結合せず MAX_DUCK_REGIONS+1(=4097) 個の別々の speech region を作る。
      // BGM クリップをその全域を覆う長さにし、cutData/videoConfig も同スケールへ書き換える。
      const FPS = 30;
      const PERIOD_FRAMES = 14;
      const REGION_COUNT = 4097; // MAX_DUCK_REGIONS(4096) + 1
      const frameToMs = (f: number): number => (f / FPS) * 1000;
      const words: TranscriptWord[] = Array.from({ length: REGION_COUNT }, (_, i) => {
        const frameStart = i * PERIOD_FRAMES;
        return { text: 'あ', start: frameToMs(frameStart), end: frameToMs(frameStart + 1) };
      });
      const totalFrames = REGION_COUNT * PERIOD_FRAMES + 2000; // 余裕を持たせる
      const dir = makeProject({ bgm: true, words });
      try {
        writeFileSync(
          join(dir, 'src', 'videoConfig.ts'),
          [
            "export type VideoFormat = 'youtube' | 'short' | 'square';",
            "export const FORMAT: VideoFormat = 'youtube';",
            `export const FPS = ${FPS};`,
            `export const DURATION_FRAMES = ${totalFrames};`,
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
          join(dir, 'src', 'cutData.ts'),
          'export const cutData = [\n' +
            `  { id: 1, originalStart: 0, originalEnd: ${totalFrames}, playbackStart: 0, playbackEnd: ${totalFrames} },\n` +
            '];\n',
        );
        writeFileSync(
          join(dir, 'src', 'Bgm', 'bgmData.ts'),
          'export const bgmData = [\n' +
            '  {\n' +
            '    id: 1,\n' +
            "    file: 'loop.mp3',\n" +
            '    startFrame: 0,\n' +
            `    endFrame: ${totalFrames},\n` +
            '    volume: 0.2,\n' +
            '    fadeInFrames: 0,\n' +
            '    fadeOutFrames: 0,\n' +
            '  },\n' +
            '];\n',
        );
        const plan = planFastCut(
          dir,
          { resolution: 'full', quality: 'high', ducking: { enabled: true, strength: 'mid' } },
          '/out/tmp.mp4',
          {
            hardware: true,
            writeFile: () => { /* 呼ばれない想定（例外経路で return null） */ },
            probeRates: () => ({ r: FPS, avg: FPS }),
            probeUniform: () => true,
            probeSize: () => (SOURCE_SIZE),
          },
        );
        expect(plan).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('(d) ducking 未供給＋焼き込み無し → plan 非 null（後方互換）', () => {
      const dir = makeProject({ bgm: true });
      try {
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => { /* 呼ばれる */ },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('M1d: 図形オーバーレイの配線', () => {
    // 共通 cuts fixture: cutRegions=[{start:100,end:200}]（原本上の除去区間）。
    // 既定 se item: id1 startFrame10 endFrame20 file chime.mp3（10 はカット区間外・往復不変）。
    // 既定 bgm item: id1 file loop.mp3 startFrame110 endFrame170 volume0.2（往復不変・SE/BGM I-1 と同じ理屈）。
    // 既定 shape item: id1 startFrame40 endFrame80 kind line opacity0.5（第1保持区間 [0,100) 内で
    //   クランプ非発火・カット非跨ぎ。anchorShapes→clampShapes→projectShapes は全て恒等（40<100 なので
    //   playbackToOriginal/originalToPlayback とも removed=0）。durationFrames=80-40=40。

    it('図形1個（opacity付き）+SE1+BGM1 で plan 非 null・overlay 鎖と fade 対・extraInputs 順序(se→bgm→png)・inputIndexBase 実値を pin', () => {
      const dir = makeProject({ se: true, bgm: true, shapes: true });
      try {
        let data = '';
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: (_p, d) => { data = d; },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).not.toBeNull();

        // 手計算: durationFrames=40 >= 2*FADE_FRAMES(16) → fade=t=in/out 分岐（geq ではない）。
        //   fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=32:n=8:alpha=1（s=D-8=40-8=32）。
        // setpts シフト = sec(startFrame=40,30) = (40/30).toFixed(6) = "1.333333"。
        // enable 式: gte(t,sec(40-0.5,30))*lt(t,sec(80-0.5,30))
        //   sec(39.5,30) = (39.5/30).toFixed(6) = "1.316667"
        //   sec(79.5,30) = (79.5/30).toFixed(6) = "2.650000"
        // inputIndexBase = 1(main) + seInputs.length(1) + bgmInputs.length(1) = 3 → PNG 入力は [3:v]。
        expect(data).toContain(
          '[3:v]format=rgba,fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=32:n=8:alpha=1,settb=1/30,setpts=N+40[shp0];',
        );
        expect(data).toContain(
          "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,1.316667)*lt(t,2.650000)'[outv]",
        );
        // PNG 入力は音声(SE→BGM)の後ろに積む（設計判断6）。extraInputs 順序 pin。
        const args = (plan as unknown as { args: string[] }).args;
        const sePath = join(dir, 'public', 'se', 'chime.mp3');
        const bgmPath = join(dir, 'public', 'BGM', 'loop.mp3');
        // M-4: ジョブ token が名前に混ざるため、前方一致で探す。
        const pngPrefix = join(dir, 'out', '.shape-0-');
        const seIdx = args.indexOf(sePath);
        const bgmIdx = args.indexOf(bgmPath);
        const pngIdx = args.findIndex((a) => a.startsWith(pngPrefix));
        expect(seIdx).toBeGreaterThan(-1);
        expect(bgmIdx).toBeGreaterThan(seIdx);
        expect(pngIdx).toBeGreaterThan(bgmIdx);
        // 画像入力は -loop 1 -framerate {fps} -t {durSec} -i path の形。
        // durSec = sec(durationFrames=40, fps=30) = (40/30).toFixed(6) = "1.333333"。
        expect(args[pngIdx - 1]).toBe('-i');
        expect(args[pngIdx - 2]).toBe('1.333333');
        expect(args[pngIdx - 3]).toBe('-t');
        expect(args[pngIdx - 4]).toBe('30');
        expect(args[pngIdx - 5]).toBe('-framerate');
        expect(args[pngIdx - 6]).toBe('1');
        expect(args[pngIdx - 7]).toBe('-loop');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('I-2: カット区間より後ろの図形（非恒等写像）で setpts シフト秒・enable 実値を pin する', () => {
      // レビュー指摘: 既定 fixture（disk 40/80）は 40<cutRegion.start(100) のため
      // anchorShapes/clampShapes/projectShapes のどの分岐でも removed=0 の恒等写像しか通らず、
      // projectShapes に空配列を渡す・reorderStartEnd を呼び忘れる等の引数取り違えを検出できない
      // （恒等 fixture 禁止の Global Constraint 抵触）。カット区間 [100,200) より後ろの disk 座標を
      // 使い、実際に +100/-100 の非自明な座標変換を通す。
      //
      // disk（shapeData.ts・再生座標）: startFrame=150, endFrame=190。
      // 1) anchorShapes（loadProject 内・playbackToOriginal）:
      //    originalStart = playbackToOriginal(150, [{100,200}]):
      //      monotone=150; cut{100,200}: 150>=100 なので +100 → 250。
      //    originalEnd = playbackToOriginal(190, [{100,200}]):
      //      monotone=190; 190>=100 なので +100 → 290。
      //    → EditorShape { originalStart: 250, originalEnd: 290 }。
      // 2) clampShapes（fastCutPlan 内・原本座標）:
      //    start=250: [100,200) の内側ではない（250>=200）→ 不変。
      //    end=290: (100,200] の内側ではない（290>200）→ 不変。→ 変更なし・flaggedIds=[]。
      // 3) projectShapes（原本→再生・originalToPlayback）:
      //    startFrame = originalToPlayback(250, [{100,200}]):
      //      250>=cut.end(200) → removed+=100 → monotone=250-100=150。
      //    endFrame = originalToPlayback(290, [{100,200}]):
      //      290>=200 → removed=100 → monotone=290-100=190。
      //    → ShapeSegment { startFrame: 150, endFrame: 190 }（disk と同値へ往復 — cutRegions が
      //    save 時と変わっていないための正しい往復。number は同じでも +100/-100 の実演算を経由した
      //    結果である点が「恒等分岐（40<100 で無演算）」の既定 fixture と異なる）。
      // 4) reorderStartEnd: 既定 cutOrder は単調（identity）→ 不変。
      // 5) fastCutPlan の filter（endFrame>startFrame）: 190>150 → 保持。
      //
      // durationFrames = 190-150 = 40（>=16 → fade=t=in/out 分岐、s=D-8=32、既定テストと同型）。
      // setpts シフト = sec(150,30) = (150/30).toFixed(6) = "5.000000"。
      // enable 式 = gte(t,sec(150-0.5,30))*lt(t,sec(190-0.5,30))
      //   sec(149.5,30) = (149.5/30).toFixed(6) = "4.983333"
      //   sec(189.5,30) = (189.5/30).toFixed(6) = "6.316667"
      // SE/BGM 無しなので inputIndexBase = 1(main) + 0 = 1 → PNG 入力は [1:v]。
      const dir = makeProject({
        shapes: true,
        shapeItems: [{ id: 1, startFrame: 150, endFrame: 190, kind: 'rect', color: '#0f0', thickness: 'medium' }],
      });
      try {
        let data = '';
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: (_p, d) => { data = d; },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).not.toBeNull();
        expect(data).toContain(
          '[1:v]format=rgba,fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=32:n=8:alpha=1,settb=1/30,setpts=N+150[shp0];',
        );
        expect(data).toContain(
          "[shbase][shp0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,4.983333)*lt(t,6.316667)'[outv]",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('PNG 書き出し呼び出し: shape-0.png へのバイナリ書き出しが1回・extraInputs のパスと一致', () => {
      const dir = makeProject({ shapes: true });
      try {
        const written: Array<{ path: string; data: Buffer }> = [];
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => { /* filter script 側は無視 */ },
          writeBinaryFile: (p, d) => { written.push({ path: p, data: d }); },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).not.toBeNull();
        expect(written.length).toBe(1);
        // M-4: ジョブ token が名前に混ざる。
        expect(written[0]!.path).toMatch(/[/\\]\.shape-0-[a-z0-9-]+\.png$/);
        expect(written[0]!.path.startsWith(join(dir, 'out', '.shape-0-'))).toBe(true);
        const args = (plan as unknown as { args: string[] }).args;
        expect(args).toContain(written[0]!.path);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('図形ゼロのプロジェクトはフィルタスクリプトが従来と1文字も変わらない（回帰ガード）', () => {
      const dir = makeProject();
      try {
        let data = '';
        planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: (_p, d) => { data = d; },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        const expected = buildCutFilterScript(
          [{ start: 0, end: 100 }, { start: 200, end: 300 }],
          30,
        );
        expect(data).toBe(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('図形がゼロ長に縮退している場合: overlay 鎖なし・PNG 書き出しなし・extraInputs に PNG なし', () => {
      // clampShapes/anchorShapes は「カット区間へ完全に飲み込まれた」原本区間を生成し得ない
      // （playbackToOriginal は常にカット区間の外側にしか写像しない数学的不変条件のため。
      //   SE/BGM の disk 往復と同じ理屈で、跨ぎ・端寄せは再現できても「内部に落ちる」入力は
      //   disk→anchor 経由では構築不能）。同じ filter 行（endFrame>startFrame）を、
      //   disk 上で既にゼロ長（startFrame===endFrame）の図形で踏む形で代替検証する。
      const dir = makeProject({ shapes: true, shapeItems: [{ id: 1, startFrame: 50, endFrame: 50 }] });
      try {
        let data = '';
        const written: Array<{ path: string; data: Buffer }> = [];
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: (_p, d) => { data = d; },
          writeBinaryFile: (p, d) => { written.push({ path: p, data: d }); },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).not.toBeNull();
        expect(data).not.toContain('overlay=');
        expect(data).not.toContain('format=rgba');
        expect(written.length).toBe(0);
        const args = (plan as unknown as { args: string[] }).args;
        expect(args.join(' ')).not.toContain('shape-0.png');
        const expected = buildCutFilterScript([{ start: 0, end: 100 }, { start: 200, end: 300 }], 30);
        expect(data).toBe(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('I-3: resolution:1080p のとき rasterizeShape へ渡す寸法は target（1920x1080）で source(3840x2160) ではない', () => {
      const dir = makeProject({ shapes: true });
      try {
        const calls: Array<{ width: number; height: number }> = [];
        const plan = planFastCut(dir, { resolution: '1080p', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => { /* filter script 側は無視 */ },
          writeBinaryFile: () => { /* PNG 書き出しは無視 */ },
          rasterizeShape: (_shape, width, height) => {
            calls.push({ width, height });
            return Buffer.from([0x89, 0x50, 0x4e, 0x47]); // 検証対象は寸法のみ・中身はダミー
          },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).not.toBeNull();
        expect(plan?.target).toEqual({ width: 1920, height: 1080 });
        expect(calls).toEqual([{ width: 1920, height: 1080 }]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('I-4: 複数図形（D=40 と D=12・色違い）の PNG 書き出し順・バイト差・-t 実値・fade/geq の出現順を pin する', () => {
      // disk 座標はどちらも第1保持区間 [0,100) 内（40<100・恒等写像。座標変換の非自明性は
      // 既存の I-2 テストが担う。本テストの主眼は「複数図形の対応付け」— インデックス・
      // PNG・duration・enable/fade式が図形間で取り違わないことの実証）。
      const dir = makeProject({
        shapes: true,
        shapeItems: [
          { id: 1, startFrame: 10, endFrame: 50, kind: 'rect', x1: 0.1, y1: 0.1, x2: 0.3, y2: 0.3, color: '#FF0000', thickness: 'thin' },
          { id: 2, startFrame: 60, endFrame: 72, kind: 'rect', x1: 0.5, y1: 0.5, x2: 0.7, y2: 0.7, color: '#00FF00', thickness: 'thin' },
        ],
      });
      try {
        let data = '';
        const written: Array<{ path: string; data: Buffer }> = [];
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: (_p, d) => { data = d; },
          writeBinaryFile: (p, d) => { written.push({ path: p, data: d }); },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).not.toBeNull();

        // (a) writeBinary 2回・パス順（shape-0 → shape-1）。M-4: ジョブ token が名前に混ざる。
        expect(written.length).toBe(2);
        expect(written[0]!.path).toMatch(/[/\\]\.shape-0-[a-z0-9-]+\.png$/);
        expect(written[1]!.path).toMatch(/[/\\]\.shape-1-[a-z0-9-]+\.png$/);

        // (b) 2つの PNG バイト列が互いに異なる（色・ジオメトリが違うので実 resvg 出力も違う）。
        expect(written[0]!.data.equals(written[1]!.data)).toBe(false);

        // (c) args の各 PNG 直前の -t がそれぞれの尺（D1=40→sec(40,30)=1.333333・D2=12→sec(12,30)=0.400000）。
        const args = (plan as unknown as { args: string[] }).args;
        const idx0 = args.indexOf(written[0]!.path);
        const idx1 = args.indexOf(written[1]!.path);
        expect(idx0).toBeGreaterThan(-1);
        expect(idx1).toBeGreaterThan(idx0);
        expect(args[idx0 - 1]).toBe('-i');
        expect(args[idx0 - 2]).toBe('1.333333');
        expect(args[idx0 - 3]).toBe('-t');
        expect(args[idx1 - 1]).toBe('-i');
        expect(args[idx1 - 2]).toBe('0.400000');
        expect(args[idx1 - 3]).toBe('-t');

        // (d) スクリプトに fade 対（1個目・D=40>=16）と geq（2個目・D=12<16）がその順で現れる。
        const fadeIdx = data.indexOf('fade=t=in:s=0:n=8:alpha=1,fade=t=out:s=32:n=8:alpha=1');
        const geqIdx = data.indexOf("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(min(N/8,(12-N)/8),0,1)'");
        expect(fadeIdx).toBeGreaterThan(-1);
        expect(geqIdx).toBeGreaterThan(fadeIdx);
        // setpts シフト・enable 実値（shape0: sec(10,30)=0.333333／shape1: sec(60,30)=2.000000）。
        expect(data).toContain('settb=1/30,setpts=N+10[shp0]');
        expect(data).toContain('settb=1/30,setpts=N+60[shp1]');
        expect(data).toContain("enable='gte(t,0.316667)*lt(t,1.650000)'");
        expect(data).toContain("enable='gte(t,1.983333)*lt(t,2.383333)'");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('M-1: writeBinaryFile が throw したら plan は null（applyShapeOverlays 到達前でも図形処理全体を Remotion 経路へ退避）', () => {
      const dir = makeProject({ shapes: true });
      try {
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => { /* 呼ばれない想定 */ },
          writeBinaryFile: () => { throw new Error('ディスク書き込み失敗（テスト用）'); },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('ラスタライズが throw したら plan は null（Remotion 経路へ退避）', () => {
      const dir = makeProject({ shapes: true });
      try {
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => { /* 呼ばれない想定 */ },
          writeBinaryFile: () => { throw new Error('呼ばれてはいけない'); },
          rasterizeShape: () => { throw new Error('resvg 失敗（テスト用）'); },
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('I-1: resvg ローダが失敗（実 rasterizeShape 経由・deps 未指定）していても plan は null（Remotion 経路へ退避）', () => {
      const dir = makeProject({ shapes: true });
      __setResvgRequireForTest(() => {
        throw new Error('resvg 不在（テスト用）');
      });
      try {
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
          hardware: true,
          writeFile: () => { /* 呼ばれない想定 */ },
          writeBinaryFile: () => { throw new Error('呼ばれてはいけない'); },
          // rasterizeShape は deps 未指定＝既定の実体（shapeRaster.rasterizeShape）を使う。
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
        });
        expect(plan).toBeNull();
      } finally {
        __resetResvgRequireForTest();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// M2c T5: 撮影オーバーレイ（テロップ / タイトル / 挿入画像）の2段化
// ---------------------------------------------------------------------------

/** planCaptureRuns の代役: スパンごとに run 1本（= 静的スタイル相当）を返す。 */
function fakePlanRuns(distinctPerSpan = 1) {
  return vi.fn((opts: { spans: { start: number; end: number }[] }) => ({
    runs: opts.spans.map((s) => ({ representativeFrame: s.start, startFrame: s.start, endFrame: s.end })),
    distinctFrames: opts.spans.length * distinctPerSpan,
    totalFrames: opts.spans.reduce((a, s) => a + (s.end - s.start), 0),
  }));
}

/** captureSpecifiedRuns の代役: 渡された run をそのまま manifest に写す。 */
function fakeCapture() {
  return vi.fn(async (req: { runs: { startFrame: number; endFrame: number }[]; outDir: string }) => ({
    ok: true as const,
    manifest: {
      runs: req.runs.map((r, i) => ({ pngFileIndex: i, startFrame: r.startFrame, endFrame: r.endFrame })),
      pngFiles: req.runs.map((_r, i) => join(req.outDir, `00000${i}.png`)),
    },
  }));
}

/** buildCaptureSequenceInput の代役: 実ファイルを作らず契約どおりの戻り値を返す。 */
function fakeSequence() {
  return vi.fn((
    runs: readonly { startFrame: number; endFrame: number }[],
    _png: readonly string[],
    opts: { dir: string; fps: number; startNumber?: number },
  ) => ({
    dir: opts.dir,
    framerate: opts.fps,
    startNumber: opts.startNumber ?? 0,
    frameCount: runs[runs.length - 1]!.endFrame - runs[0]!.startFrame,
    linkMs: 0,
  }));
}

const FAKE_TELOP = (() => null) as unknown as never;

function captureDeps(over: Record<string, unknown> = {}) {
  return {
    projectId: 'proj-1',
    serverOrigin: () => 'http://127.0.0.1:2129',
    planCaptureRuns: fakePlanRuns(),
    captureSpecifiedRuns: fakeCapture(),
    buildCaptureSequenceInput: fakeSequence(),
    loadComponents: () => ({ Telop: FAKE_TELOP, InsertImage: FAKE_TELOP }),
    removeDir: vi.fn(),
    ...over,
  } as never;
}

/** resolveChromium の代役: ok/不在を明示的に切り替えるための最小 fake。 */
function fakeResolveChromium(result: ResolveChromiumResult): () => ResolveChromiumResult {
  return () => result;
}

const CHROMIUM_MISSING: ResolveChromiumResult = {
  ok: false,
  kind: 'chromium-missing',
  message: '撮影エンジン（chrome-headless-shell）が見つかりません',
};
const CHROMIUM_OK: ResolveChromiumResult = { ok: true, bin: '/fake/chrome-headless-shell', source: 'tools' };

/**
 * planFastCut の共通 deps（撮影経路テストの標準セット・I-1）。
 *
 * resolveChromium を**同居**させ、既定で CHROMIUM_OK を返す。これが無いと deps 未注入の
 * 呼び出しが `resolveChromiumBin`（開発機の実体）へ落ち、テストの緑が開発機に暗黙依存する
 * （陰性対照: HARNESS_CHROMIUM に存在しないパスを立てて本ファイル全体が緑であること）。
 */
function planDeps(over: Record<string, unknown> = {}) {
  return {
    hardware: true,
    writeFile: () => {},
    probeRates: () => ({ r: 30, avg: 30 }),
    probeUniform: () => true,
    probeSize: () => (SOURCE_SIZE),
    // I-1 / M-3: サブ動画の素材諸元（fixture は 0 バイトのダミーなので実 probe は使えない）。
    // 1/15360 は既存の合成 fixture と同じ time_base で倍率 1 ＝ settb は入らない（受入 E）。
    probeSubVideo: () => ({ timeBaseDen: 15360, sar: 1 }),
    resolveChromium: fakeResolveChromium(CHROMIUM_OK),
    ...over,
  } as never;
}

describe('planFastCut — キーフレーム未対応の案件では撮影データからキーを落とす（F-1）', () => {
  /**
   * 高速書き出しは案件の部品ではなく**エディタ側のラッパー**（CaptureTelopLayer）で描くため、
   * 何もしないと旧版案件で「通常書き出し＝静止 / 高速書き出し＝動く」と**エンジンごとに別の絵**が出る。
   * 利用者にはどちらが選ばれるか分からないので、撮影データ側でキーを落として両経路を揃える。
   */
  const KEYS = { preset: 'keyframes', keys: [{ t: 0, scale: 1 }, { t: 1, scale: 2 }] };

  function plannedTelops(planRuns: ReturnType<typeof fakePlanRuns>) {
    const jobs = planRuns.mock.calls.map(
      (c) => c[0] as unknown as { data?: { telops?: { motion?: unknown }[] } },
    );
    const job = jobs.find((j) => j.data?.telops !== undefined);
    expect(job).toBeDefined();
    return job!.data!.telops!;
  }

  async function run(dir: string) {
    const planRuns = fakePlanRuns();
    const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
      hardware: true,
      writeFile: () => {},
      probeRates: () => ({ r: 30, avg: 30 }),
      probeUniform: () => true,
      probeSize: () => (SOURCE_SIZE),
      capture: captureDeps({ planCaptureRuns: planRuns }),
    }));
    await plan!.prepareCapture!(() => {});
    return plannedTelops(planRuns);
  }

  it('旧版ラッパーの案件ではキーが落ちる（通常書き出しと同じ＝静止）', async () => {
    const dir = makeProject({
      telopPlayerKeys: false,
      telopItems: [{ id: 1, startFrame: 0, endFrame: 30, text: 'あ', motion: KEYS }],
    });
    try {
      expect(await run(dir)).toEqual([expect.objectContaining({ motion: undefined })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('対応済みラッパーの案件ではキーが残る（高速書き出しでも動く）', async () => {
    const dir = makeProject({
      telopPlayerKeys: true,
      telopItems: [{ id: 1, startFrame: 0, endFrame: 30, text: 'あ', motion: KEYS }],
    });
    try {
      expect(await run(dir)).toEqual([expect.objectContaining({ motion: KEYS })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('プリセット（2点アニメ）は旧版案件でも落とさない（既存挙動の非退行）', async () => {
    const preset = { preset: 'zoomIn', intensity: 0.7 };
    const dir = makeProject({
      telopPlayerKeys: false,
      telopItems: [{ id: 1, startFrame: 0, endFrame: 30, text: 'あ', motion: preset }],
    });
    try {
      expect(await run(dir)).toEqual([expect.objectContaining({ motion: preset })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('planFastCut — 撮影オーバーレイの2段化（M2c T5）', () => {
  it('テロップがあっても撮影 deps が注入されていれば plan 非 null・prepareCapture が定義される', () => {
    const dir = makeProject({ telops: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps(),
      }));
      expect(plan).not.toBeNull();
      expect(plan!.prepareCapture).toBeTypeOf('function');
      expect(plan!.totalFrames).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // M2c T5b 修正1: 画像レイヤの data に解決済み imageUrl を載せる（既定テンプレの
  // InsertImage は `segment.imageUrl ?? staticFile('images/'+file)` なので、
  // imageUrl が無いと Node 分類で captureRuntime.staticFile が throw する）。
  it('prepare: 画像レイヤの data に /api/asset の解決済み imageUrl が載る（分類側・撮影側で同一データ）', async () => {
    const dir = makeProject({ imageItems: [{ id: 3, startFrame: 110, endFrame: 130, file: 'a b.png' }] });
    try {
      const planRuns = fakePlanRuns();
      const capture = fakeCapture();
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ planCaptureRuns: planRuns, captureSpecifiedRuns: capture }),
      }));
      await plan!.prepareCapture!(() => {});
      const expectedUrl = '/api/asset?id=proj-1&path=images%2Fa%20b.png';
      const planned = (planRuns.mock.calls[0]![0] as unknown as { data: { images: { imageUrl?: string; file: string }[] } }).data.images[0]!;
      expect(planned.imageUrl).toBe(expectedUrl);
      // 撮影ページへ渡すデータも同一（分類に使う DOM と撮る DOM を食い違わせない）。
      const captured = (capture.mock.calls[0]![0] as unknown as { data: { images: { imageUrl?: string }[] } }).data.images[0]!;
      expect(captured.imageUrl).toBe(expectedUrl);
      // file は元ファイル名のまま（最終 render 互換・EditorComposition と同じ規約）。
      expect(planned.file).toBe('a b.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // M2c T5b: loadComponents 未注入でも既定実体（loadOverlayComponentsForPlanner）が配線される。
  it('テロップがあり loadComponents 未注入でも plan 非 null（既定の部品ロードが配線されている）', async () => {
    const dir = makeProject({ telops: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ loadComponents: undefined }),
      }));
      expect(plan).not.toBeNull();
      expect(plan!.prepareCapture).toBeTypeOf('function');
      // makeProject の fixture は Telop.tsx を持たない → 既定実体が missing-file で失敗し、
      // prepare は ok:false（renderJob は Remotion へフォールバックする）。
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain('Telop.tsx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('タイトルのみのプロジェクトは部品ロード無し（loadComponents 未注入）でも撮影経路に乗る', () => {
    const dir = makeProject({ titleItems: [{ id: 1, startFrame: 120, endFrame: 160, text: 'T' }] });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ loadComponents: undefined }),
      }));
      expect(plan!.prepareCapture).toBeTypeOf('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('オーバーレイが無いプロジェクトは prepareCapture を持たない（従来経路そのまま）', () => {
    const dir = makeProject({ shapes: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        writeBinaryFile: () => {},
        rasterizeShape: () => Buffer.from('png'),
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps(),
      }));
      expect(plan!.prepareCapture).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: 画像と telop+title の2レイヤぶん planner が呼ばれ、スパンは最終座標の和集合（非恒等写像）', async () => {
    // cutData: [0,100) と [200,300) → 原本 220 は再生 120 へ写る（非恒等）
    const dir = makeProject({
      // データファイルは**再生フレーム**で保存される。読み込みで原本アンカーへ（+100）、
      // 導出で再生座標へ（-100）戻る＝同じ数値でも実演算を経由する非恒等 fixture
      // （既存の図形 I-2 テストと同型）。
      telopItems: [{ id: 1, startFrame: 120, endFrame: 160, text: 'あ' }],
      titleItems: [{ id: 2, startFrame: 140, endFrame: 180, text: 'T' }],
      imageItems: [{ id: 3, startFrame: 110, endFrame: 130, file: 'a.png' }],
    });
    try {
      const planRuns = fakePlanRuns();
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ planCaptureRuns: planRuns }),
      }));
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(true);
      expect(planRuns).toHaveBeenCalledTimes(2);
      const imageCall = planRuns.mock.calls[0]![0] as Record<string, unknown>;
      const ttCall = planRuns.mock.calls[1]![0] as Record<string, unknown>;
      // 画像レイヤが先（z 順の下）
      expect(imageCall['layer']).toBe('image');
      expect(imageCall['spans']).toEqual([{ start: 110, end: 130 }]);
      // テロップ [120,160) とタイトル [140,180) は重なるので和集合1本になる
      expect(ttCall['layer']).toBe('telop-title');
      expect(ttCall['spans']).toEqual([{ start: 120, end: 180 }]);
      // 撮影は原本解像度・尺は最終総フレーム数
      expect(ttCall['videoConfig']).toEqual({ width: 3840, height: 2160, fps: 30, durationInFrames: 200 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: titleStyle は videoConfig の実値がそのまま撮影データへ渡る（黙って既定値に落とさない）', async () => {
    const dir = makeProject({ titleItems: [{ id: 1, startFrame: 110, endFrame: 150, text: 'T' }] });
    try {
      const planRuns = fakePlanRuns();
      const capture = fakeCapture();
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ planCaptureRuns: planRuns, captureSpecifiedRuns: capture, loadComponents: undefined }),
      }));
      await plan!.prepareCapture!(() => {});
      // 3840x2160 / TELOP_CONFIG 不在 → readTitleStyle の解像度既定（top=65 left=115 fontSize=48）
      const expected = { top: 65, left: 115, fontSize: 48 };
      expect((planRuns.mock.calls[0]![0] as unknown as { data: { titleStyle: unknown } }).data.titleStyle).toEqual(expected);
      expect((capture.mock.calls[0]![0] as unknown as { data: { titleStyle: unknown }; layer: string }).data.titleStyle).toEqual(expected);
      expect((capture.mock.calls[0]![0] as unknown as { layer: string }).layer).toBe('title');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: titleStyle は TELOP_CONFIG の実値が渡る（解像度既定と別値の fixture で「実値 vs 既定」を区別）', async () => {
    // 解像度既定は top=65/left=115/fontSize=48。ここではどれとも異なる値を書き込む。
    const dir = makeProject({
      titleItems: [{ id: 1, startFrame: 110, endFrame: 150, text: 'T' }],
      telopConfig: { titleTop: 220, titleLeft: 64, titleFontSize: 96 },
    });
    try {
      const planRuns = fakePlanRuns();
      const capture = fakeCapture();
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ planCaptureRuns: planRuns, captureSpecifiedRuns: capture, loadComponents: undefined }),
      }));
      await plan!.prepareCapture!(() => {});
      const expected = { top: 220, left: 64, fontSize: 96 };
      expect((planRuns.mock.calls[0]![0] as unknown as { data: { titleStyle: unknown } }).data.titleStyle).toEqual(expected);
      expect((capture.mock.calls[0]![0] as unknown as { data: { titleStyle: unknown } }).data.titleStyle).toEqual(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: 撮影対象の run が0本になったら ok:false（オーバーレイ抜きの動画を黙って出さない）', async () => {
    const dir = makeProject({ telops: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({
          planCaptureRuns: vi.fn(() => ({ runs: [], distinctFrames: 0, totalFrames: 0 })),
        }),
      }));
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain('run が0本');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: スパン末尾の run が撮影結果に届いていなければ ok:false（M-2・末尾欠落の黙殺防止）', async () => {
    const dir = makeProject({ telops: true });
    try {
      // スパンを2本の run（前半/後半）に分ける planCaptureRuns を注入し、captureSpecifiedRuns
      // 側で末尾（後半）の run だけを結果から落とす——「run はスパン境界で必ず切れる」契約が
      // 破れて末尾が欠けたケースを模す（実際に起きうるのは撮影側の不具合や欠落）。
      const planRuns = vi.fn((opts: { spans: { start: number; end: number }[] }) => ({
        runs: opts.spans.flatMap((s) => {
          const mid = Math.floor((s.start + s.end) / 2);
          return [
            { representativeFrame: s.start, startFrame: s.start, endFrame: mid },
            { representativeFrame: mid, startFrame: mid, endFrame: s.end },
          ];
        }),
        distinctFrames: opts.spans.length * 2,
        totalFrames: opts.spans.reduce((a, s) => a + (s.end - s.start), 0),
      }));
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({
          planCaptureRuns: planRuns,
          captureSpecifiedRuns: vi.fn(
            async (req: { runs: { startFrame: number; endFrame: number }[]; outDir: string }) => {
              // 末尾の run（配列の最後＝スパン終端に届く run）だけを結果から落とす。
              const truncated = req.runs.slice(0, -1);
              return {
                ok: true as const,
                manifest: {
                  runs: truncated.map((r, i) => ({ pngFileIndex: i, startFrame: r.startFrame, endFrame: r.endFrame })),
                  pngFiles: truncated.map((_r, i) => join(req.outDir, `00000${i}.png`)),
                },
              };
            },
          ),
        }),
      }));
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain('末尾');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('撮影の一時ディレクトリはジョブごとに別名（キャンセル→即再実行で旧撮影が新ジョブを上書きしない）', async () => {
    const dir = makeProject({ telops: true });
    try {
      const dirsOf = async (): Promise<string[]> => {
        const capture = fakeCapture();
        const sequence = fakeSequence();
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
          hardware: true,
          writeFile: () => {},
          probeRates: () => ({ r: 30, avg: 30 }),
          probeUniform: () => true,
          probeSize: () => (SOURCE_SIZE),
          capture: captureDeps({ captureSpecifiedRuns: capture, buildCaptureSequenceInput: sequence }),
        }));
        await plan!.prepareCapture!(() => {});
        return [
          (capture.mock.calls[0]![0] as unknown as { outDir: string }).outDir,
          (sequence.mock.calls[0]![2] as unknown as { dir: string }).dir,
        ];
      };
      const first = await dirsOf();
      const second = await dirsOf();
      expect(first[0]).not.toBe(second[0]);
      expect(first[1]).not.toBe(second[1]);
      // 名前空間だけが違う（レイヤ/スパンの識別子は保つ）
      for (const d of [...first, ...second]) expect(d).toContain('.capture-telop-title');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * C-1（T3 レビュー）: 分母は run 総数 `capturedTotal` であって一意シグネチャ数
   * `distinctFrames` ではない。両者は**恒等ではない**（非連続な同一シグネチャは run が
   * 分かれるので runs ≥ distinct）。恒等 fixture で pin すると二重座標系のバグが
   * 素通りするため、**実 `planCaptureRuns`** で runs > distinct になる素材を使う。
   */
  it('prepare: 予測時間は run 総数（capturedTotal）× 68.23ms・distinctFrames とは一致しない（C-1・実 planCaptureRuns）', async () => {
    const dir = makeProject({
      cuts: false,
      telopItems: [
        { id: 1, startFrame: 0, endFrame: 30, text: 'あ', template: 1 },
        { id: 2, startFrame: 60, endFrame: 90, text: 'い', template: 1 },
      ],
      titleItems: [{ id: 1, startFrame: 0, endFrame: 120, text: 'タイトル' }],
    });
    try {
      const capture = fakeCapture();
      const reported: RenderCaptureEstimate[] = [];
      let runsPassedToCapture = 0;
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({
          // 実装（Set ベースのシグネチャ分類）をそのまま通す。
          planCaptureRuns: realPlanCaptureRuns,
          captureSpecifiedRuns: vi.fn(async (req: never) => {
            // report は撮影前に済んでいること
            expect(reported).toHaveLength(1);
            runsPassedToCapture += (req as unknown as { runs: unknown[] }).runs.length;
            return await capture(req);
          }),
        }),
      }));
      const outcome = await plan!.prepareCapture!((e) => reported.push(e));
      expect(outcome.ok).toBe(true);
      const first = reported[0]!;
      // 実際に Chromium が撮る枚数（= 撮影へ渡した run の総数）が分母。
      expect(first.capturedTotal).toBe(runsPassedToCapture);
      // 非恒等 fixture であること自体を pin（恒等なら二重座標系のバグを検出できない）。
      expect(first.capturedTotal).toBeGreaterThan(first.distinctFrames);
      expect(first.estimatedMs).toBe(first.capturedTotal * CAPTURE_MS_PER_FRAME);
      // distinctFrames は情報用として据え置き（削除されていないこと）。
      expect(first.distinctFrames).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: onProgress が capture へ渡り、report の capturedFrames へ累積で伝わる（M2d T3・申し送り⑥）', async () => {
    const dir = makeProject({
      telopItems: [
        { id: 1, startFrame: 0, endFrame: 20, text: 'あ', template: 1 },
        { id: 2, startFrame: 60, endFrame: 80, text: 'い', template: 1 },
      ],
    });
    try {
      const capture = vi.fn(
        async (
          req: { runs: { startFrame: number; endFrame: number }[]; outDir: string },
          deps?: { onProgress?: (captured: number, total: number) => void },
        ) => {
          req.runs.forEach((_r, i) => deps?.onProgress?.(i + 1, req.runs.length));
          return {
            ok: true as const,
            manifest: {
              runs: req.runs.map((r, i) => ({ pngFileIndex: i, startFrame: r.startFrame, endFrame: r.endFrame })),
              pngFiles: req.runs.map((_r, i) => join(req.outDir, `00000${i}.png`)),
            },
          };
        },
      );
      const reported: { distinctFrames: number; estimatedMs: number; capturedFrames?: number }[] = [];
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ captureSpecifiedRuns: capture }),
      }));
      const outcome = await plan!.prepareCapture!((e) => reported.push(e));
      expect(outcome.ok).toBe(true);
      // 2スパン（テロップ2本・非隣接）→ 2 run。初回見積り（capturedFrames 無し）に続き、
      // 累積 capturedFrames が 1→2（=distinctFrames、最終）まで伝わる。
      expect(reported).toEqual([
        { distinctFrames: 2, capturedTotal: 2, estimatedMs: 2 * CAPTURE_MS_PER_FRAME },
        { distinctFrames: 2, capturedTotal: 2, estimatedMs: 1 * CAPTURE_MS_PER_FRAME, capturedFrames: 1 },
        { distinctFrames: 2, capturedTotal: 2, estimatedMs: 0, capturedFrames: 2 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * I-1（T3 レビュー）: レイヤ横断の累積が無検証だった（`cumulative = captured` に変異させても
   * 全緑で生存した）。挿入画像レイヤ + テロップレイヤの2ジョブで、`capturedFrames` が
   * **レイヤ境界をまたいで単調増加**し、最終値が `capturedTotal` に一致することを pin する。
   */
  it('prepare: capturedFrames はレイヤ境界をまたいで単調増加し、最終値が capturedTotal に一致する（I-1）', async () => {
    const dir = makeProject({
      imageItems: [{ id: 1, startFrame: 0, endFrame: 20, file: 'a.png' }],
      telopItems: [
        { id: 1, startFrame: 40, endFrame: 60, text: 'あ', template: 1 },
        { id: 2, startFrame: 70, endFrame: 90, text: 'い', template: 1 },
      ],
    });
    try {
      const capture = vi.fn(
        async (
          req: { runs: { startFrame: number; endFrame: number }[]; outDir: string },
          deps?: { onProgress?: (captured: number, total: number) => void },
        ) => {
          req.runs.forEach((_r, i) => deps?.onProgress?.(i + 1, req.runs.length));
          return {
            ok: true as const,
            manifest: {
              runs: req.runs.map((r, i) => ({ pngFileIndex: i, startFrame: r.startFrame, endFrame: r.endFrame })),
              pngFiles: req.runs.map((_r, i) => join(req.outDir, `00000${i}.png`)),
            },
          };
        },
      );
      const reported: RenderCaptureEstimate[] = [];
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ captureSpecifiedRuns: capture }),
      }));
      const outcome = await plan!.prepareCapture!((e) => reported.push(e));
      expect(outcome.ok).toBe(true);
      // 2レイヤ（image: 1スパン / telop-title: 2スパン）＝ run 総数 3。
      expect(capture).toHaveBeenCalledTimes(2);
      const total = capture.mock.calls.reduce((a, c) => a + (c[0] as { runs: unknown[] }).runs.length, 0);
      expect(total).toBe(3);
      const progress = reported.filter((e) => e.capturedFrames !== undefined);
      // レイヤ境界（1本目のレイヤの最終 run → 2本目のレイヤの1本目）で 1 に戻らないこと。
      expect(progress.map((e) => e.capturedFrames)).toEqual([1, 2, 3]);
      for (const e of reported) expect(e.capturedTotal).toBe(3);
      expect(progress[progress.length - 1]!.capturedFrames).toBe(progress[progress.length - 1]!.capturedTotal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * I-2（T3 レビュー）: 進捗整合の不一致で throw すると、**表示の不整合ごときで撮影全体が
   * Remotion 退避に落ちる**（出力が変わる）。不一致は「以降の進捗報告を止める + warn 1回」
   * に留め、撮影自体は成功させる（#194 の不一致 fixture は維持）。
   */
  it('prepare: onProgress の total が run 数と食い違っても撮影は成功し、warn 1回で以降の進捗報告が止まる（I-2・不一致 fixture）', async () => {
    const dir = makeProject({
      telopItems: [
        { id: 1, startFrame: 0, endFrame: 20, text: 'あ', template: 1 },
        { id: 2, startFrame: 60, endFrame: 80, text: 'い', template: 1 },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const capture = vi.fn(
        async (
          req: { runs: { startFrame: number; endFrame: number }[]; outDir: string },
          deps?: { onProgress?: (captured: number, total: number) => void },
        ) => {
          // 実際の run 数と食い違う total を報告する不正な撮影実装を模す（2 run 分報告する）。
          req.runs.forEach((_r, i) => deps?.onProgress?.(i + 1, req.runs.length + 1));
          return {
            ok: true as const,
            manifest: {
              runs: req.runs.map((r, i) => ({ pngFileIndex: i, startFrame: r.startFrame, endFrame: r.endFrame })),
              pngFiles: req.runs.map((_r, i) => join(req.outDir, `00000${i}.png`)),
            },
          };
        },
      );
      const reported: RenderCaptureEstimate[] = [];
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ captureSpecifiedRuns: capture }),
      }));
      const outcome = await plan!.prepareCapture!((e) => reported.push(e));
      // 撮影は成功（Remotion 退避に落ちない）。
      expect(outcome.ok).toBe(true);
      // 初回見積り（capturedFrames 無し）だけが残り、以降 capturedFrames は一切乗らない。
      expect(reported.filter((e) => e.capturedFrames !== undefined)).toEqual([]);
      expect(reported).toHaveLength(1);
      // warn はジョブにつき1回だけ（run ごとに撒かない）。
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('一致しません');
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: 撮影失敗は種別つきで ok:false（throw で抜けない）・一時ディレクトリを掃除する', async () => {
    const dir = makeProject({ telops: true });
    try {
      const removeDir = vi.fn();
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({
          captureSpecifiedRuns: vi.fn(async () => ({ ok: false, kind: 'launch-failed', message: 'chromium なし' })),
          removeDir,
        }),
      }));
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain('launch-failed');
      expect(outcome.ok === false && outcome.reason).toContain('chromium なし');
      outcome.cleanup!();
      // M-4: cut-filter.txt も同じ後始末経路に乗る（shapePngPaths はこのプロジェクトに
      // 図形が無いので空）。撮影一時ディレクトリと合わせて2件。
      expect(removeDir).toHaveBeenCalledTimes(2);
      const removed = removeDir.mock.calls.map((c) => c[0] as string);
      expect(removed.some((p) => /\.capture-telop-title-[a-z0-9-]+$/.test(p))).toBe(true);
      expect(removed.some((p) => /cut-filter-[a-z0-9-]+\.txt$/.test(p))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: 撮影用 origin が未記録なら ok:false（Host ヘッダ推測はしない）', async () => {
    const dir = makeProject({ telops: true });
    try {
      const capture = fakeCapture();
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ serverOrigin: () => null, captureSpecifiedRuns: capture }),
      }));
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(false);
      expect(capture).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: z 順（画像→図形→telop+title）と入力 index・extraInputs 順序・setpts/enable 実値を pin する', async () => {
    const dir = makeProject({
      se: true, // 音声 extraInput を1本入れて index の順送りを非自明にする
      shapes: true, // 図形（静止 PNG）1個: 原本 [40,80) → 再生 [40,80)
      telopItems: [{ id: 1, startFrame: 120, endFrame: 160, text: 'あ' }], // 原本 [220,260) 経由の往復
      imageItems: [{ id: 3, startFrame: 110, endFrame: 130, file: 'a.png' }], // 原本 [210,230) 経由の往復
    });
    try {
      let script = '';
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: (_p: string, d: string) => { script = d; },
        writeBinaryFile: () => {},
        rasterizeShape: () => Buffer.from('png'),
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps(),
      }));
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(true);
      // 入力: 0=main / 1=SE / 2=画像連番 / 3=図形PNG / 4=telop-title連番
      expect(script).toContain('[2:v]format=rgba,settb=1/30,setpts=N+110[shp0];'); // 110/30
      expect(script).toContain('[3:v]format=rgba,fade=t=in'); // 図形は静止型（フェード付き）
      expect(script).toContain('[4:v]format=rgba,settb=1/30,setpts=N+120[shp2];'); // 120/30
      // enable 窓（[start-0.5, end-0.5) 秒）: 画像 [110,130) / telop-title [120,160)
      expect(script).toContain("enable='gte(t,3.650000)*lt(t,4.316667)'");
      expect(script).toContain("enable='gte(t,3.983333)*lt(t,5.316667)'");
      // 積層順（z 順）: 画像 → 図形 → telop+title
      expect(script.indexOf('[shbase][shp0]')).toBeLessThan(script.indexOf('[ov0][shp1]'));
      expect(script.indexOf('[ov0][shp1]')).toBeLessThan(script.indexOf('[ov1][shp2]'));
      expect(script).toContain('[ov1][shp2]overlay');
      expect(script.trimEnd().endsWith('[outv]')).toBe(true);
      // extraInputs の順序（音声 → 画像連番 → 図形PNG → telop+title連番）
      const args = (outcome as { args: string[] }).args;
      const inputs = args.reduce<string[]>((acc, a, i) => (a === '-i' ? [...acc, args[i + 1]!] : acc), []);
      expect(inputs[0]).toBe(join(dir, 'public', 'main.mp4'));
      expect(inputs[1]).toBe(join(dir, 'public', 'se', 'chime.mp3'));
      expect(inputs[2]).toMatch(/[/\\]\.capture-image-[a-z0-9-]+-seq0[/\\]%06d\.png$/);
      // M-4: ジョブ token が名前に混ざる。
      expect(inputs[3]).toMatch(/[/\\]\.shape-0-[a-z0-9-]+\.png$/);
      expect(inputs[4]).toMatch(/[/\\]\.capture-telop-title-[a-z0-9-]+-seq0[/\\]%06d\.png$/);
      // 連番入力は image2（-framerate / -start_number）で渡る
      expect(args.join(' ')).toContain('-framerate 30 -start_number 0');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { width: 3840, height: 2160, expectedRatio: .5 },
    { width: 3842, height: 2160, expectedRatio: undefined },
  ])('prepare: only uniformly reduced images use output density ($width x $height)', async size => {
    const dir = makeProject({ telops: true, imageItems: [{ id: 3, startFrame: 10, endFrame: 30, file: 'a.png' }] });
    try {
      // Capture uses the declared composition, not the decoded source-video size.
      const config = join(dir, 'src', 'videoConfig.ts');
      writeFileSync(config, readFileSync(config, 'utf8').replace('width: 3840, height: 2160', `width: ${size.width}, height: ${size.height}`));
      const capture = fakeCapture();
      const plan = planFastCut(dir, { resolution: '1080p', quality: 'high' }, '/out/tmp.mp4', planDeps({
        probeSize: () => ({ width: size.width, height: size.height, exact: true }),
        capture: captureDeps({ captureSpecifiedRuns: capture }),
      }));
      const outcome = await plan!.prepareCapture!(() => {});
      expect(outcome.ok).toBe(true);
      const requests = capture.mock.calls.map(([req]) => req as unknown as { layer: string; width: number; height: number; pixelRatio?: number });
      expect(requests.find(r => r.layer === 'image')).toMatchObject({ width: size.width, height: size.height });
      expect(requests.find(r => r.layer === 'image')!.pixelRatio).toBe(size.expectedRatio);
      expect(requests.filter(r => r.layer !== 'image').length).toBeGreaterThan(0);
      expect(requests.filter(r => r.layer !== 'image').every(r => r.pixelRatio === undefined)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare: 出力を縮小するときは連番入力に scale を掛ける（撮影は原寸）', async () => {
    const dir = makeProject({ telops: true });
    try {
      let script = '';
      const planRuns = fakePlanRuns();
      const plan = planFastCut(dir, { resolution: '1080p', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: (_p: string, d: string) => { script = d; },
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps({ planCaptureRuns: planRuns }),
      }));
      await plan!.prepareCapture!(() => {});
      // 撮影は原本解像度のまま
      expect((planRuns.mock.calls[0]![0] as unknown as { videoConfig: { width: number } }).videoConfig.width).toBe(3840);
      // 連番入力側で出力解像度へ合わせる
      expect(script).toContain('format=rgba,scale=1920:1080,settb=1/30,setpts=N+');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('planFastCut — Chromium 適格性チェック（M2d T2・設計判断5）', () => {
  it('テロップ入りで resolveChromium が不在 → plan は null（事前分岐・撮影に入る前に Remotion 継続）', () => {
    const dir = makeProject({ telops: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps(),
        resolveChromium: fakeResolveChromium(CHROMIUM_MISSING),
      }));
      expect(plan).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('テロップ入りで resolveChromium が在り → 従来どおり plan 非 null・prepareCapture が定義される', () => {
    const dir = makeProject({ telops: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps(),
        resolveChromium: fakeResolveChromium(CHROMIUM_OK),
      }));
      expect(plan).not.toBeNull();
      expect(plan!.prepareCapture).toBeTypeOf('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('受入E: テロップ/タイトル/画像が無い（音声・図形のみ）プロジェクトは resolveChromium 不在でも plan 非 null（撮影しない経路は Chromium を要求しない）', () => {
    const dir = makeProject({ shapes: true, se: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', {
        hardware: true,
        writeFile: () => {},
        writeBinaryFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        resolveChromium: fakeResolveChromium(CHROMIUM_MISSING),
      });
      expect(plan).not.toBeNull();
      expect(plan!.prepareCapture).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2 位置検証: 図形付き+テロップ入り+Chromium不在 → 図形PNG(.shape-*.png)が書き出されていない（ラスタライズより前の分岐）', () => {
    const dir = makeProject({ shapes: true, telops: true });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        capture: captureDeps(),
        resolveChromium: fakeResolveChromium(CHROMIUM_MISSING),
      }));
      expect(plan).toBeNull();
      const outEntries = readdirSync(join(dir, 'out'));
      expect(
        outEntries.filter((e) => e.startsWith('.shape-')),
        `out/ に図形PNGが残っている（リーク）: ${JSON.stringify(outEntries)}`,
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('planFastCutDetailed — 退避理由の一本化（M2d T2 修正 I-2・受入C）', () => {
  it('テロップ入りで Chromium 不在なら { plan: null, ineligible: "chromium-missing" }', () => {
    const dir = makeProject({ telops: true });
    try {
      const detailed = planFastCutDetailed(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        capture: captureDeps(),
        resolveChromium: fakeResolveChromium(CHROMIUM_MISSING),
      }));
      expect(detailed.plan).toBeNull();
      expect(detailed.ineligible).toBe('chromium-missing');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('env-path-missing / unsupported-platform も resolveChromium の kind をそのまま返す', () => {
    const dir = makeProject({ telops: true });
    try {
      for (const kind of ['env-path-missing', 'unsupported-platform'] as const) {
        const detailed = planFastCutDetailed(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
          capture: captureDeps(),
          resolveChromium: fakeResolveChromium({ ok: false, kind, message: 'x' }),
        }));
        expect(detailed.plan).toBeNull();
        expect(detailed.ineligible).toBe(kind);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('撮影と無関係な非適格（projectId 無し）は ineligible を立てない（今回の対象は撮影エンジンのみ）', () => {
    const dir = makeProject({ telops: true });
    try {
      const detailed = planFastCutDetailed(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({}));
      expect(detailed.plan).toBeNull();
      expect(detailed.ineligible).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('plan が立つときは ineligible なし・planFastCut は同じ plan を返す薄いラッパ', () => {
    const dir = makeProject({ telops: true });
    try {
      const deps = planDeps({ capture: captureDeps() });
      const detailed = planFastCutDetailed(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', deps);
      expect(detailed.plan).not.toBeNull();
      expect(detailed.ineligible).toBeUndefined();
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', deps);
      expect(plan).not.toBeNull();
      expect(plan!.totalFrames).toBe(detailed.plan!.totalFrames);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('planFastCut — needsCapture 述語の共有（M2d T2 修正 I-3）', () => {
  it('カットに飲まれて縮退したテロップだけのプロジェクトは撮影経路に入らない（Chromium 不在でも plan 非 null）', () => {
    // cutData は [0,100) と [200,300) を残す＝カット区間は [100,200)。
    // カット区間に飲まれたテロップは保存時に境界へ寄り、再生座標で start==end（縮退）になる。
    const dir = makeProject({ telopItems: [{ id: 1, startFrame: 100, endFrame: 100, text: 'あ' }] });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        resolveChromium: fakeResolveChromium(CHROMIUM_MISSING),
      }));
      expect(plan).not.toBeNull();
      expect(plan!.prepareCapture).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('planFastCut — 撮影段への resolveChromium 伝播（M2d 最終・M-4）', () => {
  it('prepareCapture が deps.resolveChromium を captureSpecifiedRuns へ渡す（plan ok・capture missing を作れる）', async () => {
    const dir = makeProject({ telops: true });
    try {
      // 1回目（plan の適格性チェック）は「在り」、以降（撮影段）は「不在」を返す resolver。
      // 伝播が無い実装では撮影段が resolveChromiumBin（開発機の実体）を見るため、
      // この fake の不在は撮影結果に一切現れない（＝伝播の有無を弁別できる）。
      let calls = 0;
      const resolveChromium = (): ResolveChromiumResult => (calls++ === 0 ? CHROMIUM_OK : CHROMIUM_MISSING);
      const capture = vi.fn(async (
        _req: unknown,
        deps?: { resolveChromium?: () => ResolveChromiumResult },
      ) => {
        const resolved = (deps?.resolveChromium ?? (() => CHROMIUM_OK))();
        return resolved.ok
          ? { ok: true as const, manifest: { runs: [], pngFiles: [] } }
          : { ok: false as const, kind: 'chromium-missing' as const, message: resolved.message };
      });
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        hardware: true,
        writeFile: () => {},
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => (SOURCE_SIZE),
        resolveChromium,
        capture: captureDeps({ captureSpecifiedRuns: capture }),
      }));
      expect(plan).not.toBeNull();
      const outcome = await plan!.prepareCapture!(() => {});
      expect(capture).toHaveBeenCalled();
      expect((capture.mock.calls[0]![1] as { resolveChromium?: unknown }).resolveChromium).toBe(resolveChromium);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.reason).toContain('chromium-missing');
      outcome.cleanup?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * M3 T5: **ゲート開放後に転換配線が実際に通電する**ことの統合 pin。
 *
 * `buildTransitionWiring` は T2 で純関数として切り出され単体テストは通っていたが、
 * ゲート（`cutsOnly.ts`）が閉じている間は **planFastCut からは一度も呼ばれない**
 * （sceneTransitions が空になるので overlaps=[] / sceneFades=[] の分岐しか通らない）。
 * ここは「配線したつもりで通電していない」（H-27 / H-53）を検出する 1 本で、
 * **転換あり × 音声 ducking あり × 撮影あり** を 1 つの plan で同時に通す。
 *
 * 対立仮説（これが壊れているとどう見えるか）:
 *   - ゲートが閉じたまま → plan は **null**（全アサーションの手前で落ちる）
 *   - 転換が resolveSceneTransitions を通らず素通し → 原本 at 100 がどの再生境界とも
 *     一致せず overlaps が空 → script に `xfade` が出ない（転換が静かに消えた動画）
 *   - 色レイヤが撮影 PNG の後（最前面）に積まれる → `[fd0]` の overlay 行が
 *     撮影 PNG の overlay 行より後ろに来る（設計判断5 の z 順違反）
 */
describe('M3 T5: 転換 × ducking × 撮影の統合 plan（ゲート開放の通電確認）', () => {
  /** 原本フレーム 100 = 既定 cuts fixture の join（前区間 originalEnd）。 */
  const JOIN_ORIGINAL = 100;
  /**
   * ducking を発火させる語。**転換があると座標が動く**ので M1c(a) の語（原本 [180,219)）は使えない:
   * bgmData.ts の値は**最終座標**として読まれ（`loadProject` が `uncollapseStartEnd` で
   * 再生座標へ戻す）、既定 BGM の最終 [110,170) は再生 [126,186) になる。
   * M1c(a) の語の再生区間 [100,119) はここと交差しないので envelope が空になり、
   * 「転換を足すと ducking が消えた」ように見えるが**それは fixture の数字の問題**。
   * ここでは再生 [130,160) に来る語（原本 [230,260)・カット [100,200) の後ろ）を使う。
   */
  const duckWords: TranscriptWord[] = [{ text: 'x', start: 7667, end: 8667 }];

  it('plan 非 null・script に xfade / 色レイヤ / 縮小 / ducking が揃い、色レイヤは撮影 PNG より前段', async () => {
    const dir = makeProject({
      telops: true,
      bgm: true,
      words: duckWords,
      transitionItems: [
        { id: 1, at: JOIN_ORIGINAL, kind: 'crossfade', durationFrames: 16 },
        { id: 2, at: 'head', kind: 'fadeBlack', durationFrames: 10 },
      ],
    });
    try {
      let data = '';
      const plan = planFastCut(
        dir,
        { resolution: '1080p', quality: 'high', ducking: { enabled: true, strength: 'mid' } },
        '/out/tmp.mp4',
        planDeps({
          writeFile: (_p: string, d: string) => { data = d; },
          capture: captureDeps(),
        }),
      );
      expect(plan).not.toBeNull();
      await plan!.prepareCapture!(() => {});
      expect(data).not.toBe('');

      // (1) 重なり系が xfade として組まれている（crossfade は stock `fade`・T1 採否表）。
      expect(data).toContain('xfade=transition=fade');
      // 窓 = 再生境界 100 の重なり 16 フレーム。offset=(100-16)/30・duration=16/30。
      expect(data).toContain(`duration=${(16 / 30).toFixed(9)}:offset=${((100 - 16) / 30).toFixed(9)}`);
      // xfade 群の内側だけが gbrp・群の出口で yuv420p へ戻る（設計判断2 の filter 鎖の形）。
      expect(data).toContain('format=gbrp');
      expect(data).toContain('format=yuv420p');

      // (2) fade 色レイヤ（fadeBlack head D=10）が geq alpha で駆動されている。
      expect(data).toContain(`color=c=0x000000:s=1920x1080:r=30:d=${(10 / 30).toFixed(6)}`);
      expect(data).toContain("a='255*clip(1-N/10,0,1)'");

      // (3) 1080p の縮小（lanczos）は転換配線の中で 1 回だけ（区間ごとに掛けない）。
      // 撮影 PNG 側にも `scale=1920:1080`（`scaleTo`・flags 無し）が出るので、
      // 数えるのは **lanczos 付きの縮小だけ**にする（両方を一緒に数えると常に 2 になる）。
      expect(data).toContain('[catv]scale=1920:1080:flags=lanczos');
      expect(data.match(/scale=1920:1080:flags=lanczos/g)?.length).toBe(1);

      // (4) ducking の volume 式が BGM の 1 系統だけに載る（SE 無しなので漏れは即赤）。
      expect(data.match(/volume='/g)?.length).toBe(1);
      // BGM の最終座標は 110 フレーム（= bgmData.ts の値そのもの。最終座標で保存される契約の
      // 往復が恒等であることの pin）。転換で座標がずれていれば adelay が変わる。
      expect(data).toContain('adelay=3667:all=1[mix0]');

      // (5) 撮影 PNG（telop+title 鎖）が積まれている。
      const capturePng = data.match(/\[\d+:v\]/g) ?? [];
      expect(capturePng.length).toBeGreaterThan(0);

      // (6) z 順: 色レイヤ（[fd0] の overlay）は撮影 PNG の overlay より**前段**（設計判断5）。
      const fadeOverlay = data.indexOf('[fd0]overlay=');
      expect(fadeOverlay).toBeGreaterThan(-1);
      const lastOverlay = data.lastIndexOf('overlay=');
      expect(lastOverlay).toBeGreaterThan(fadeOverlay);

      // (7) 総フレーム数は finalTotalFrames（200 − 16 = 184）。verifyCutFrames が自動追随する。
      expect(plan!.totalFrames).toBe(184);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * ゲートの陰性対照を**実 plan で**持つ（B-7 M-1）。
   *
   * 陰性対照 #4（`transitionCorpus.e2e`）は `nativeUnsupportedReasons` の単体呼び出しなので、
   * 「ゲートは理由を返すが plan は通してしまう」壊れ方を検出できない（配線を見ていない）。
   * ここは**転換ありの同じ fixture に videoInserts を 1 本足すだけ**で plan が null になることを見る。
   * 対立仮説: ゲートの判定結果を planFastCut が握り潰していれば、この plan は非 null になる。
   */
  it('転換あり + 速度変更あり → plan は null（ゲート機構が生きている・#4 の実配線版）', () => {
    // **M4 で videoInserts はゲートから外れた**ので、ここで使う「まだ閉じている要因」は
    // `mainSpeed !== 1`（速度変更）へ差し替えた。videoInserts のままだと、素材ファイルが
    // 無いための**退避**で null になるのを「ゲートが効いている」と読み違える。
    const opts = {
      telops: true,
      transitionItems: [
        { id: 1, at: JOIN_ORIGINAL, kind: 'crossfade' as const, durationFrames: 16 },
      ],
    };
    const closed = makeProject({ ...opts, mainSpeed: 2 });
    const open = makeProject(opts);
    try {
      const call = (dir: string): unknown =>
        planFastCut(
          dir,
          { resolution: '1080p', quality: 'high' },
          '/out/tmp.mp4',
          planDeps({ writeFile: () => {}, capture: captureDeps() }),
        );
      // 対照: 同じ転換のまま速度を戻すと plan は組める（＝null の原因がゲートだと確定する）。
      expect(call(open)).not.toBeNull();
      expect(call(closed)).toBeNull();
    } finally {
      rmSync(closed, { recursive: true, force: true });
      rmSync(open, { recursive: true, force: true });
    }
  });
});

/**
 * C-1（codex-review P2）: fade 色の妥当性は**図形ラスタライズより前**に判定する。
 *
 * 旧コードは色レイヤ合成（`applySceneFadeLayers` → `ffmpegColor`）の throw を捕まえて
 * plan null にしていたが、その時点で `.shape-{i}-{token}.png` は**書き出し済み**で
 * cleanup も prepareCapture も無い（＝書き出しのたびに out/ に残骸が溜まる）。
 */
describe('planFastCut — fade 色の適格性チェック（C-1）', () => {
  const shapeEntries = (dir: string): string[] =>
    readdirSync(join(dir, 'out')).filter((e) => e.startsWith('.shape-'));

  it('非対応の fade 色 + 図形あり → plan null かつ out/ に .shape-* が残らない', () => {
    const dir = makeProject({
      shapes: true,
      transitionItems: [
        // `rgb(255,0,0)` は ffmpeg の色として渡せない形（CSS 名でも #RGB でもない）。
        { id: 1, at: 'head' as const, kind: 'fadeColor' as const, durationFrames: 10, color: 'rgb(255,0,0)' },
      ],
    });
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        writeFile: () => {},
      }));
      expect(plan).toBeNull();
      expect(shapeEntries(dir), `out/ に図形PNGが残っている（リーク）`).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CSS 基本名（red）と #RGB 短縮は変換して native で描く（退避しない）', () => {
    const cases: Array<[string, string]> = [
      ['red', '0xFF0000'],
      ['#fff', '0xFFFFFF'],
    ];
    for (const [color, expected] of cases) {
      const dir = makeProject({
        transitionItems: [
          { id: 1, at: 'head' as const, kind: 'fadeColor' as const, durationFrames: 10, color },
        ],
      });
      try {
        let written = '';
        const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
          writeFile: (_p: string, data: string) => { written = data; },
        }));
        expect(plan, `${color} で plan が立たない`).not.toBeNull();
        expect(written).toContain(`color=c=${expected}:`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

/**
 * C-6（広域 I-4）: 素材寸法の probe は**無条件**（旧コードは `exists(videoPath)` で囲っていた）。
 * 本ファイルの fixture は素材ファイルを置かないので、囲いがあるとテストは製品と別の分岐を通り、
 * probe まわりの回帰を 1 件も検出できない。
 */
describe('planFastCut — 素材寸法 probe の無条件化（C-6）', () => {
  it('素材ファイルが無くても probeSize を 1 回呼ぶ（テストが製品と同じ分岐を通る）', () => {
    const dir = makeProject();
    try {
      const calls: string[] = [];
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        writeFile: () => {},
        probeSize: (p: string) => { calls.push(p); return SOURCE_SIZE; },
      }));
      expect(plan).not.toBeNull();
      expect(calls).toEqual([join(dir, 'public', 'main.mp4')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probeSize が null なら plan null（素材が無い＝計測不能と同じ扱い）', () => {
    const dir = makeProject();
    try {
      const plan = planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
        writeFile: () => {},
        probeSize: () => null,
      }));
      expect(plan).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * M4 T5: **ゲート開放後にサブ動画配線が実際に通電する**ことの統合 pin。
 *
 * T2〜T4 で組んだ層（canon 写像・配置・出入りアニメの段分割）は、ゲート（`cutsOnly.ts` の
 * `videoInserts` 行）が閉じている間 **planFastCut からは一度も呼ばれない**。ここは
 * 「配線したつもりで通電していない」（H-27 / H-53）を検出する 1 本で、
 * **サブ動画 × 出入りアニメ × 図形 × 撮影（テロップ）**を 1 つの plan で同時に通す。
 *
 * 対立仮説（これが壊れているとどう見えるか）:
 *   - ゲートが閉じたまま → plan は **null**（全アサーションの手前で落ちる。開放前に実測済み）
 *   - canon 写像が入らない → `tpad` / 中点 ceil の `setpts` が出ない（＝正典②を再現しない絵）
 *   - 出入りアニメが段分割されない → `split=` が出ない（黙って無アニメの絵になる）
 *   - z 順違反 → サブ動画の overlay（`format=rgb`）が図形/撮影 PNG の overlay より後ろに来る
 */
describe('M4 T5: サブ動画 × 出入りアニメ × 図形 × 撮影の統合 plan（ゲート開放の通電確認）', () => {
  const insertItems = [
    {
      id: 1,
      startFrame: 20,
      endFrame: 50,
      file: 'sub.mp4',
      sourceInFrame: 3,
      playbackRate: 1.5,
      position: { x: 0.4, y: -0.25 },
      scale: 1.5,
      enter: { kind: 'fade', frames: 8 },
      exit: { kind: 'fade', frames: 8 },
    },
  ];

  it('plan 非 null・script に canon 写像 / 段分割 / format=rgb が揃い、サブ動画は図形・撮影より前段', async () => {
    const dir = makeProject({
      telops: true,
      shapes: true,
      videoInsertItems: insertItems,
      videoInsertAsset: true,
    });
    try {
      let data = '';
      const plan = planFastCut(
        dir,
        { resolution: 'full', quality: 'high' },
        '/out/tmp.mp4',
        planDeps({
          writeFile: (_p: string, d: string) => { data = d; },
          capture: captureDeps(),
        }),
      );
      expect(plan).not.toBeNull();
      await plan!.prepareCapture!(() => {});
      expect(data).not.toBe('');

      // (1) canon 写像（正典①②③）: 末尾クランプの tpad → 中点 ceil の setpts → fps → 窓長 trim。
      expect(data).toContain('tpad=stop=-1:stop_mode=clone');
      expect(data).toContain('fps=30:round=down:eof_action=pass');
      // 窓長 30 フレーム（endFrame − startFrame）。定数ではなくケースの値から来ている。
      expect(data).toContain('trim=end_frame=30');
      // sourceInFrame=3 / playbackRate=1.5 が式へ入っている（既定へ落ちていない）。
      expect(data).toContain('-3/30)/1.5)');

      // (2) 出入りアニメが段へ分割されている（時変式ではなく静的レイヤ列・T4 の方式）。
      expect(data).toMatch(/split=\d+\[vs0_0\]/);
      expect(data).toContain('colorchannelmixer=aa=');

      // (3) サブ動画レイヤだけ overlay が RGB 合成（T2 裁定1）。
      expect(data).toContain('format=rgb:');

      // (4) z 順（正典⑦）: サブ動画の overlay は図形・撮影 PNG の overlay より**前段**。
      const overlays = data.split('\n').filter((l) => l.includes(']overlay='));
      expect(overlays.length).toBeGreaterThan(1);
      const kinds = overlays.map((l) => l.includes('format=rgb'));
      const firstOther = kinds.indexOf(false);
      const lastVideo = kinds.lastIndexOf(true);
      expect(firstOther, 'サブ動画以外の overlay（図形/撮影）が 1 本も無い＝z 順を検査できていない')
        .toBeGreaterThan(-1);
      expect(lastVideo, 'サブ動画の overlay が図形/撮影より後ろに積まれている（正典⑦ 違反）')
        .toBeLessThan(firstOther);

      // (5) 総フレーム数は既定 cuts fixture の 200（転換なし）。
      expect(plan!.totalFrames).toBe(200);
      // 出力フレーム数の検算が配線されている（サブ動画があっても外れない）。
      expect(typeof plan!.verify).toBe('function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('サブ動画あり + 速度変更あり → plan は null（ゲート機構はサブ動画以外で生きている）', () => {
    const closed = makeProject({
      telops: true,
      videoInsertItems: insertItems,
      videoInsertAsset: true,
      mainSpeed: 2,
    });
    const open = makeProject({ telops: true, videoInsertItems: insertItems, videoInsertAsset: true });
    try {
      const call = (dir: string): unknown =>
        planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
          writeFile: () => {},
          capture: captureDeps(),
        }));
      expect(call(open)).not.toBeNull();
      expect(call(closed)).toBeNull();
    } finally {
      rmSync(closed, { recursive: true, force: true });
      rmSync(open, { recursive: true, force: true });
    }
  });

  it('サブ動画の素材が public/ に無ければ退避（plan null）— ゲート開放と退避を混同しない', () => {
    const dir = makeProject({ telops: true, videoInsertItems: insertItems }); // asset を置かない
    try {
      expect(
        planFastCut(dir, { resolution: 'full', quality: 'high' }, '/out/tmp.mp4', planDeps({
          writeFile: () => {},
          capture: captureDeps(),
        })),
      ).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
