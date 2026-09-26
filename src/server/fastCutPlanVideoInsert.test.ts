/**
 * サブ動画インサート（videoInserts）の**製品配線**（M4 T3）。
 *
 * 検証対象は `planFastCutImpl` の配線そのもの——「どの入力 index に何を挿すか」「filter
 * script のどの位置に鎖が入るか」「plan が成立しない条件で黙って近似せず退避するか」。
 * 画素同値は e2e（`nativeExportVideoInsertPlan.e2e.test.ts`）が実 ffmpeg で測る。
 *
 * ## ゲート（M4 T5 で開放済み）
 * T3 の時点では `src/shared/cutsOnly.ts` の `videoInserts` 行が生きていたので、このファイルは
 * **ゲート判定モジュールだけ**を `vi.mock` で差し替えて配線を検査していた。T5 でゲートを開けた
 * （型 `NativeUnsupportedReason` から `'videoInserts'` を削除）ため、モックは撤去して
 * **製品の `planFastCut` をそのまま**通している。ゲート機構が生きていることの pin は
 * `fastCutPlan.test.ts` の「M4 T5: … 統合 plan」と「サブ動画あり + 速度変更あり → plan null」が持つ。
 */
import { describe, it, expect } from 'vitest';
import type { ResolveChromiumResult } from './resolveChromium';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { planFastCut, projectVideoInsertPlayback } = await import('./fastCutPlan');
const { buildCutOrdering } = await import('../core/cutOrder');
const { videoInsertPlacement, assertUniqueFilterOutputLabels } = await import('./nativeExportVideo');
type EditorProject = import('../core/types').EditorProject;

/** fixture の composition（= videoConfig.RESOLUTION）。 */
const COMP = { width: 3840, height: 2160 };
const SOURCE_SIZE = { width: COMP.width, height: COMP.height, exact: true } as const;
const OPTIONS = { resolution: 'full', quality: 'high' } as const;

interface VideoInsertFixture {
  id: number;
  startFrame: number;
  endFrame: number;
  file: string;
  sourceInFrame: number;
  playbackRate?: number;
  scale?: number;
  position?: { x: number; y: number };
  enter?: { kind: string; frames: number; direction?: string };
  exit?: { kind: string; frames: number; direction?: string };
}

/** サブ動画付きの最小プロジェクト（テロップ等なし＝非撮影経路）。 */
function makeProject(opts: {
  videoInserts: VideoInsertFixture[];
  /** public/ 配下に実体（0 バイトのダミー）を置くファイル名。既定は videoInserts の file 全部。 */
  assets?: string[];
  se?: boolean;
  shapes?: boolean;
  /** 挿入画像（撮影経路に入れるため）。 */
  images?: { id: number; startFrame: number; endFrame: number; file: string }[];
  /** テロップ（撮影経路に入れるため）。 */
  telops?: { id: number; startFrame: number; endFrame: number; text: string }[];
  transitions?: { id: number; at: number | 'head' | 'tail'; kind: string; durationFrames: number }[];
}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sme-m4-plan-')));
  mkdirSync(join(dir, 'src', 'テロップテンプレート'), { recursive: true });
  mkdirSync(join(dir, 'src', 'InsertVideo'), { recursive: true });
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
      `  youtube: { width: ${COMP.width}, height: ${COMP.height} },`,
      '  short: { width: 1080, height: 1920 },',
      '  square: { width: 1080, height: 1080 },',
      '} as const;',
      'export const RESOLUTION = RESOLUTION_MAP[FORMAT];',
    ].join('\n'),
  );
  const telopItems = opts.telops ?? [];
  writeFileSync(
    join(dir, 'src', 'テロップテンプレート', 'telopData.ts'),
    [
      'export const FPS = 30;',
      'export const TOTAL_FRAMES = 300;',
      `export const telopData = [${telopItems
        .map((t) => `{ id: ${t.id}, startFrame: ${t.startFrame}, endFrame: ${t.endFrame}, text: ${JSON.stringify(t.text)}, template: 1 }`)
        .join(', ')}];`,
    ].join('\n'),
  );
  if (opts.images !== undefined && opts.images.length > 0) {
    mkdirSync(join(dir, 'src', 'InsertImage'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'InsertImage', 'insertImageData.ts'),
      'export const insertImageData = [\n' +
        opts.images
          .map((i) => `  { id: ${i.id}, startFrame: ${i.startFrame}, endFrame: ${i.endFrame}, file: ${JSON.stringify(i.file)}, type: 'photo' },`)
          .join('\n') +
        '\n];\n',
    );
  }
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
  writeFileSync(
    join(dir, 'src', 'InsertVideo', 'insertVideoData.ts'),
    'export const insertVideoData = [\n' +
      opts.videoInserts
        .map(
          (v) =>
            `  { id: ${v.id}, startFrame: ${v.startFrame}, endFrame: ${v.endFrame}, ` +
            `file: ${JSON.stringify(v.file)}, sourceInFrame: ${v.sourceInFrame}` +
            (v.playbackRate === undefined ? '' : `, playbackRate: ${v.playbackRate}`) +
            (v.scale === undefined ? '' : `, scale: ${v.scale}`) +
            (v.position === undefined ? '' : `, position: { x: ${v.position.x}, y: ${v.position.y} }`) +
            (v.enter === undefined ? '' : `, enter: { kind: ${JSON.stringify(v.enter.kind)}, frames: ${v.enter.frames}${v.enter.direction === undefined ? '' : `, direction: ${JSON.stringify(v.enter.direction)}`} }`) +
            (v.exit === undefined ? '' : `, exit: { kind: ${JSON.stringify(v.exit.kind)}, frames: ${v.exit.frames}${v.exit.direction === undefined ? '' : `, direction: ${JSON.stringify(v.exit.direction)}`} }`) +
            ' },',
        )
        .join('\n') +
      '\n];\n',
  );
  for (const f of opts.assets ?? opts.videoInserts.map((v) => v.file)) {
    const abs = join(dir, 'public', f);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, '');
  }
  if (opts.se === true) {
    mkdirSync(join(dir, 'src', 'SoundEffects'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'SoundEffects', 'seData.ts'),
      "export const seData = [\n  { id: 1, startFrame: 10, endFrame: 20, file: 'chime.mp3' },\n];\n",
    );
    mkdirSync(join(dir, 'public', 'se'), { recursive: true });
    writeFileSync(join(dir, 'public', 'se', 'chime.mp3'), '');
  }
  if (opts.shapes === true) {
    mkdirSync(join(dir, 'src', 'InsertShape'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'InsertShape', 'shapeData.ts'),
      "export const shapeData = [\n  { id: 1, startFrame: 40, endFrame: 80, kind: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#fff', thickness: 'thin' },\n];\n",
    );
  }
  if (opts.transitions !== undefined) {
    mkdirSync(join(dir, 'src', 'Transition'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'Transition', 'transitionData.ts'),
      'export const transitionData = [\n' +
        opts.transitions
          .map(
            (t) =>
              `  { id: ${t.id}, at: ${typeof t.at === 'number' ? t.at : JSON.stringify(t.at)}, ` +
              `kind: ${JSON.stringify(t.kind)}, durationFrames: ${t.durationFrames} },`,
          )
          .join('\n') +
        '\n];\n',
    );
  }
  return dir;
}

interface Planned {
  args: string[];
  script: string;
  totalFrames: number;
}

/** 製品の planFastCut を通し、書き出された filter script と args を取る。 */
function plan(dir: string, extra: Record<string, unknown> = {}): Planned | null {
  let script = '';
  const p = planFastCut(dir, OPTIONS, join(dir, 'out', 'x.mp4'), {
    hardware: true,
    writeFile: (_path: string, data: string) => { script = data; },
    writeBinaryFile: () => { /* 図形 PNG の中身は本ファイルの検証対象外 */ },
    rasterizeShape: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    probeRates: () => ({ r: 30, avg: 30 }),
    probeUniform: () => true,
    probeSize: () => SOURCE_SIZE,
    // I-1 / M-3: サブ動画の素材諸元（本 fixture は 0 バイトのダミーなので実 probe は使えない）。
    // 1/15360 は既存の合成 fixture と同じ time_base で、倍率 1 ＝ settb は入らない（受入 E）。
    probeSubVideo: () => ({ timeBaseDen: 15360, sar: 1 }),
    ...extra,
  });
  return p === null ? null : { args: p.args, script, totalFrames: p.totalFrames };
}

/** args から `-i` の対象を出現順に並べる（入力 index の順序 = z 順の一次資料）。 */
function inputsOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '-i') out.push(args[i + 1]!);
  return out;
}

describe('planFastCut のサブ動画配線（M4 T3）', () => {
  it('サブ動画の入力は「音声 extraInputs の後・図形 PNG の前」に入り、filter の入力 index と 1 対 1', () => {
    const dir = makeProject({
      videoInserts: [
        { id: 1, startFrame: 10, endFrame: 40, file: 'sub-a.mp4', sourceInFrame: 3, playbackRate: 0.7 },
        { id: 2, startFrame: 20, endFrame: 60, file: 'sub-b.mp4', sourceInFrame: 0 },
      ],
      se: true,
      shapes: true,
    });
    try {
      const got = plan(dir)!;
      expect(got).not.toBeNull();
      const inputs = inputsOf(got.args);
      // main → SE → サブ動画2本 → 図形 PNG。**この順序が入力 index の割当そのもの**。
      expect(inputs[0]).toBe(join(dir, 'public', 'main.mp4'));
      expect(inputs[1]).toBe(join(dir, 'public', 'se', 'chime.mp3'));
      expect(inputs[2]).toBe(join(dir, 'public', 'sub-a.mp4'));
      expect(inputs[3]).toBe(join(dir, 'public', 'sub-b.mp4'));
      expect(inputs[4]).toMatch(/\.shape-0-.*\.png$/);
      expect(inputs).toHaveLength(5);
      // filter 側も同じ index を読む（サブ動画は [2:v]/[3:v]・図形は [4:v]）。
      expect(got.script).toContain('[2:v]tpad=stop=-1:stop_mode=clone,');
      expect(got.script).toContain('[3:v]tpad=stop=-1:stop_mode=clone,');
      expect(got.script).toContain('[4:v]format=rgba,fade=');
      // z 順（正典⑦）: overlay 鎖はサブ動画 → 図形の順で積む。
      const overlayOrder = [...got.script.matchAll(/\[(?:shbase|ov\d+)\]\[shp(\d+)\]overlay/g)].map((m) => m[1]);
      expect(overlayOrder).toEqual(['0', '1', '2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('サブ動画だけ（音声・図形なし）でも overlay 鎖が張られ、入力は main の直後', () => {
    const dir = makeProject({ videoInserts: [{ id: 1, startFrame: 5, endFrame: 25, file: 'sub.mp4', sourceInFrame: 2 }] });
    try {
      const got = plan(dir)!;
      expect(inputsOf(got.args)).toEqual([join(dir, 'public', 'main.mp4'), join(dir, 'public', 'sub.mp4')]);
      expect(got.script).toContain('[1:v]tpad=stop=-1:stop_mode=clone,');
      // 窓 [5,25) が enable に入る（正典④・sec() は半フレーム手前で刻む）。
      expect(got.script).toMatch(/overlay=x=0:y=0:eof_action=pass:format=rgb:enable='gte\(t,0\.150000\)\*lt\(t,0\.816667\)'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('既定値は呼び出し側で実値に解決される（playbackRate=1・scale=1・position=中央）', () => {
    const dir = makeProject({ videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0 }] });
    try {
      const got = plan(dir)!;
      // rate 既定 1（`/1)*30` の形で canon 写像に現れる）
      expect(got.script).toContain('/1)*30-1e-6');
      // scale 既定 1 → 全画面・position 既定 (0,0) → x=0:y=0
      expect(got.script).toContain(`scale=${COMP.width}:${COMP.height}:force_original_aspect_ratio=decrease`);
      expect(got.script).toContain('overlay=x=0:y=0:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('position / scale / playbackRate の実値が正典⑤・① の式へ流れる', () => {
    const dir = makeProject({
      videoInserts: [
        { id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 7, playbackRate: 2, scale: 0.5, position: { x: 0.4, y: -0.25 } },
      ],
    });
    try {
      const got = plan(dir)!;
      const p = videoInsertPlacement(COMP, { x: 0.4, y: -0.25 }, 0.5);
      expect(p).toEqual({ width: 1920, height: 1080, x: 1728, y: 270 });
      expect(got.script).toContain(`scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease`);
      expect(got.script).toContain(`overlay=x=${p.x}:y=${p.y}:`);
      expect(got.script).toContain('-7/30)/2)*30-1e-6');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重なり系転換があっても窓は**最終座標**で刻まれる（collapse が通電している証拠）', () => {
    /**
     * `insertVideoData.ts` は**最終座標**で保存されている（core/project.ts:154 の
     * `uncollapseStartEnd` が読み込み時に再生座標へ戻す）。したがって
     * ファイル値 [110,140) → 読込で再生 [140,170) → plan の collapse で最終 [110,140) と
     * **往復して戻る**のが正しい配線。
     * **collapse を落とすと再生座標のまま [140,170) が焼かれる**（enable が 1 秒後ろへずれる）
     * ので、この 2 行が `attachVideoInserts` の有無を弁別する。
     * crossfade @原本100（= 区間境界）D=30 → overlap 30・totalFrames 200-30=170。
     */
    const dir = makeProject({
      videoInserts: [{ id: 1, startFrame: 110, endFrame: 140, file: 'sub.mp4', sourceInFrame: 0 }],
      transitions: [{ id: 1, at: 100, kind: 'crossfade', durationFrames: 30 }],
    });
    try {
      const got = plan(dir)!;
      expect(got.totalFrames).toBe(170);
      // 最終 [110,140) → enable は gte(t,(110-0.5)/30) * lt(t,(140-0.5)/30)
      expect(got.script).toContain("enable='gte(t,3.650000)*lt(t,4.650000)'");
      expect(got.script).toContain('setpts=N+110[shp0]');
      // collapse 無しなら再生座標 [140,170) が出る＝この 2 行が弁別点。
      expect(got.script).not.toContain('lt(t,5.650000)');
      expect(got.script).not.toContain('setpts=N+140[shp0]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('退避（plan null → Remotion 経路）', () => {
    it('サブ動画のファイルが public/ に無ければ退避する（黙って欠落した動画を出さない）', () => {
      const dir = makeProject({
        videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'missing.mp4', sourceInFrame: 0 }],
        assets: [],
      });
      try {
        expect(plan(dir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('2 本のうち 1 本だけ欠けても退避する（残りだけで近似しない）', () => {
      const dir = makeProject({
        videoInserts: [
          { id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0 },
          { id: 2, startFrame: 30, endFrame: 60, file: 'missing.mp4', sourceInFrame: 0 },
        ],
        assets: ['sub.mp4'],
      });
      try {
        expect(plan(dir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it.each([
      ['playbackRate=0', { playbackRate: 0 }],
      ['playbackRate 負', { playbackRate: -1 }],
      ['scale=0', { scale: 0 }],
      ['scale 負', { scale: -0.5 }],
    ])('%s は退避する', (_label, patch) => {
      const dir = makeProject({
        videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0, ...patch }],
      });
      try {
        expect(plan(dir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * **T3 の暫定退避を T4 で置き換えた箇所**（旧: enter/exit があれば無条件で Remotion 退避）。
     * 5 種すべてを native で描くので退避しない——「描けるのに退避する」も
     * 「描けないのに黙って無アニメを出す」も、どちらも起きていないことをここで押さえる。
     */
    it.each([
      ['enter=fade', { enter: { kind: 'fade', frames: 8 } }, 7],
      ['enter=zoom', { enter: { kind: 'zoom', frames: 8 } }, 7],
      ['enter=pop', { enter: { kind: 'pop', frames: 8 } }, 7],
      ['enter=slideIn', { enter: { kind: 'slideIn', frames: 8, direction: 'up' } }, 7],
      ['exit=slideIn', { exit: { kind: 'slideIn', frames: 8, direction: 'right' } }, 7],
      ['exit=pop', { exit: { kind: 'pop', frames: 8 } }, 7],
    ])('%s は退避せず native で描かれる（正典⑥ 5 種を T4 で実装済み）', (_label, patch, animFrames) => {
      const dir = makeProject({
        videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0, ...patch }],
      });
      try {
        const got = plan(dir);
        expect(got).not.toBeNull();
        // canon 写像（＝素材のデコード）は 1 本のまま、アニメぶんだけ split される。
        expect(got!.script.match(/tpad=stop=-1/g)).toHaveLength(1);
        expect(got!.script).toContain(`split=${animFrames + 1}`);
        // アニメの段には alpha が付く（不透明のまま描いて「アニメ無しの絵」を出していない）。
        expect(got!.script.match(/colorchannelmixer=aa=/g)!.length).toBeGreaterThan(0);
        assertUniqueFilterOutputLabels(got!.script);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('enter/exit 両方に付くと段は enter + exit + 平坦部（種別ごとの段数を実値で pin）', () => {
      const dir = makeProject({
        videoInserts: [
          {
            id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0,
            enter: { kind: 'fade', frames: 6 }, exit: { kind: 'zoom', frames: 4 },
          },
        ],
      });
      try {
        const got = plan(dir)!;
        // enter: k=1..5（k=0 は opacity 0 で不可視）→ 5 段 / 平坦部 1 段 / exit: k=27,28,29 → 3 段。
        expect(got.script).toContain('split=9');
        expect(got.script).toContain('trim=start_frame=1:end_frame=2,setpts=N+1,');
        expect(got.script).toContain('trim=start_frame=6:end_frame=27,setpts=N+6,');
        expect(got.script).toContain('trim=start_frame=29:end_frame=30,setpts=N+29,');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('アニメの段が上限を超えるプロジェクトは退避する（黙って近似しない）', () => {
      const dir = makeProject({
        videoInserts: [
          {
            id: 1, startFrame: 0, endFrame: 100, file: 'sub.mp4', sourceInFrame: 0,
            enter: { kind: 'fade', frames: 50 }, exit: { kind: 'fade', frames: 50 },
          },
        ],
      });
      try {
        expect(plan(dir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('陽性対照: 同じ窓長で段が上限内なら成立する（上の退避が「窓が長いと必ず null」ではない）', () => {
      const dir = makeProject({
        videoInserts: [
          {
            id: 1, startFrame: 0, endFrame: 100, file: 'sub.mp4', sourceInFrame: 0,
            enter: { kind: 'fade', frames: 30 }, exit: { kind: 'fade', frames: 30 },
          },
        ],
      });
      try {
        expect(plan(dir)).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("enter/exit が 'none' や frames=0 なら鎖はアニメ無しと1文字も変わらない（受入 E・M-6 1 の過剰退避も解消）", () => {
      const plain = makeProject({
        videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0 }],
      });
      const noneAnim = makeProject({
        videoInserts: [
          { id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0, enter: { kind: 'none', frames: 8 }, exit: { kind: 'none', frames: 8 } },
        ],
      });
      const zeroFrames = makeProject({
        videoInserts: [
          { id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0, enter: { kind: 'fade', frames: 0 }, exit: { kind: 'pop', frames: 0 } },
        ],
      });
      try {
        const base = plan(plain)!.script;
        expect(base).not.toContain('split=');
        expect(plan(noneAnim)!.script).toBe(base);
        expect(plan(zeroFrames)!.script).toBe(base);
      } finally {
        for (const d of [plain, noneAnim, zeroFrames]) rmSync(d, { recursive: true, force: true });
      }
    });

    /**
     * **I-1: 素材 time_base を plan 段で probe して canon 鎖へ渡す。**
     *
     * canon 写像の PTS はタイムベース単位の整数なので、粗い素材（`den` が合成 fps に近い）では
     * 「スロット中心」が表現できず**全フレームが 1 スロット後ろ**へずれる。plan 段で実値を渡し、
     * 足りない分だけ**素材 time_base の整数倍**へ引き上げる（`settb`）。
     */
    it('I-1: 粗い time_base の素材は canon 鎖の先頭に settb（素材 time_base の整数倍）が入る', () => {
      const dir = makeProject({ videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0 }] });
      try {
        // 1/30 の素材 × 合成 30fps → 1 スロット 8 単位を確保する最小の整数倍は 8（= 1/240）。
        const coarse = plan(dir, { probeSubVideo: () => ({ timeBaseDen: 30, sar: 1 }) })!.script;
        expect(coarse).toContain('settb=1/240,tpad=stop=-1:stop_mode=clone');
        // 受入 E: 実素材（1/15360・1/600・1/90000 …）は倍率 1 ＝ 1 文字も変わらない。
        const fine = plan(dir)!.script;
        expect(fine).not.toContain('settb=1/240');
        expect(fine).toContain('[1:v]tpad=stop=-1:stop_mode=clone');
        expect(plan(dir, { probeSubVideo: () => ({ timeBaseDen: 600, sar: 1 }) })!.script).toBe(fine);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('I-1: 素材の time_base / SAR を読めなければ退避する（分からないまま canon 写像を掛けない）', () => {
      const dir = makeProject({ videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0 }] });
      try {
        expect(plan(dir, { probeSubVideo: () => null })).toBeNull();
        expect(plan(dir)).not.toBeNull(); // 陽性対照
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    /**
     * **M-3: SAR≠1（アナモルフィック）は退避する。** 正典（`objectFit: contain`）は表示アスペクト比で
     * 内接させるが、`force_original_aspect_ratio=decrease` は標本寸法で内接させるので、
     * 非正方画素だと黙って縦横比の違う絵が出る。SAR が読めない場合も同じ扱い（安全側）。
     */
    it('M-3: SAR≠1 のサブ動画は退避する（黙って縦横比の違う絵を出さない）', () => {
      const dir = makeProject({ videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0 }] });
      try {
        expect(plan(dir, { probeSubVideo: () => ({ timeBaseDen: 15360, sar: 2 }) })).toBeNull();
        expect(plan(dir, { probeSubVideo: () => ({ timeBaseDen: 15360, sar: 0.5 }) })).toBeNull();
        // 未指定（N/A）は正方画素扱い＝退避しない（libx264 で焼いた普通の mp4 がこれ）。
        expect(plan(dir, { probeSubVideo: () => ({ timeBaseDen: 15360, sar: null }) })).not.toBeNull();
        // 陽性対照: SAR 1:1 なら同じ fixture で成立する。
        expect(plan(dir, { probeSubVideo: () => ({ timeBaseDen: 15360, sar: 1 }) })).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("enter/exit が明示 'none' なら plan は成立する（退避条件が「指定の有無」ではなく「種別」で効く）", () => {
      const dir = makeProject({
        videoInserts: [
          { id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0, enter: { kind: 'none', frames: 0 }, exit: { kind: 'none', frames: 0 } },
        ],
      });
      try {
        expect(plan(dir)).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('陽性対照: 同じ fixture で不正値だけを正常値へ戻すと plan は成立する（上の退避が無条件 null でない証明）', () => {
      const dir = makeProject({
        videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0, playbackRate: 1, scale: 1 }],
      });
      try {
        expect(plan(dir)).not.toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('退避しても図形 PNG の残骸を残さない（書き出し前に判定している）', () => {
      const dir = makeProject({
        videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'missing.mp4', sourceInFrame: 0 }],
        assets: [],
        shapes: true,
      });
      try {
        const written: string[] = [];
        expect(
          plan(dir, { writeBinaryFile: (p: string) => { written.push(p); } }),
        ).toBeNull();
        expect(written).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  /**
   * **撮影経路**（挿入画像・テロップがある経路）の配線。非撮影経路とは合成の入口が別
   * （`prepareCapture` の中で `composeOverlayChains` が 4 群を1回で積む）なので、
   * 片方だけ緑にしても他方は無防備になる——実際、`videosCount` を渡し忘れる変異は
   * 非撮影経路のテストだけでは検出できなかった。
   *
   * 撮影は Chromium を起動せず、`captureRunPlanner` / `captureDriver` /
   * `captureSequenceInput` を fake に差し替えて配線だけを通す（既存 fastCutPlan.test.ts と同流儀）。
   */
  it('撮影経路: 入力順は 画像連番 → サブ動画 → 図形 PNG → telop 連番（正典⑦）で、filter の index と 1 対 1', async () => {
    const dir = makeProject({
      videoInserts: [{ id: 1, startFrame: 10, endFrame: 40, file: 'sub.mp4', sourceInFrame: 0 }],
      images: [{ id: 5, startFrame: 0, endFrame: 20, file: 'a.png' }],
      telops: [{ id: 7, startFrame: 50, endFrame: 70, text: 'あ' }],
      shapes: true,
      /**
       * 色レイヤ（fadeBlack）を1つ入れて overlay 鎖を**2本に割る**（`composeOverlayChains` が
       * 画像+サブ動画+図形 → 色レイヤ → telop+title の順で積む経路）。
       * この経路でだけ `telopTitleBase` が実際に使われる——サブ動画の本数を
       * `computeOverlayInputIndexBase` へ渡し忘れると telop 連番の入力 index が1つ手前へずれ、
       * **図形 PNG の絵をテロップとして合成した動画**が静かに出る。
       * 尺不変の fade 系なので totalFrames は変わらない（時間軸の変異は混ぜない）。
       */
      transitions: [{ id: 1, at: 100, kind: 'fadeBlack', durationFrames: 10 }],
    });
    try {
      let script = '';
      const p = planFastCut(dir, OPTIONS, join(dir, 'out', 'x.mp4'), {
        hardware: true,
        writeFile: (_path: string, data: string) => { script = data; },
        writeBinaryFile: () => {},
        rasterizeShape: () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        probeRates: () => ({ r: 30, avg: 30 }),
        probeUniform: () => true,
        probeSize: () => SOURCE_SIZE,
        probeSubVideo: () => ({ timeBaseDen: 15360, sar: 1 }),
        resolveChromium: (): ResolveChromiumResult => ({ ok: true, bin: '/fake/chrome-headless-shell', source: 'tools' }),
        capture: {
          projectId: 'proj-1',
          serverOrigin: () => 'http://127.0.0.1:2129',
          planCaptureRuns: ((opts: { spans: { start: number; end: number }[] }) => ({
            runs: opts.spans.map((sp) => ({ representativeFrame: sp.start, startFrame: sp.start, endFrame: sp.end })),
            distinctFrames: opts.spans.length,
            totalFrames: opts.spans.reduce((a, sp) => a + (sp.end - sp.start), 0),
          })) as never,
          captureSpecifiedRuns: (async (req: { runs: { startFrame: number; endFrame: number }[]; outDir: string }) => ({
            ok: true as const,
            manifest: {
              runs: req.runs.map((r, i) => ({ pngFileIndex: i, startFrame: r.startFrame, endFrame: r.endFrame })),
              pngFiles: req.runs.map((_r, i) => join(req.outDir, `00000${i}.png`)),
            },
          })) as never,
          buildCaptureSequenceInput: ((
            runs: readonly { startFrame: number; endFrame: number }[],
            _png: readonly string[],
            o: { dir: string; fps: number; startNumber?: number },
          ) => ({
            dir: o.dir,
            framerate: o.fps,
            startNumber: o.startNumber ?? 0,
            frameCount: runs[runs.length - 1]!.endFrame - runs[0]!.startFrame,
            linkMs: 0,
          })) as never,
          loadComponents: () => ({ Telop: (() => null) as never, InsertImage: (() => null) as never }),
          removeDir: () => {},
        },
      });
      expect(p).not.toBeNull();
      expect(p!.prepareCapture).toBeTypeOf('function');
      const outcome = await p!.prepareCapture!(() => {});
      expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
      if (!outcome.ok) throw new Error(outcome.reason);
      const inputs = inputsOf(outcome.args);
      // main → 画像連番 → サブ動画 → 図形 PNG → telop 連番（音声 extraInputs は無い fixture）。
      expect(inputs[0]).toBe(join(dir, 'public', 'main.mp4'));
      expect(inputs[1]).toMatch(/\.capture-image-.*-seq0[/\\]%06d\.png$/);
      expect(inputs[2]).toBe(join(dir, 'public', 'sub.mp4'));
      expect(inputs[3]).toMatch(/\.shape-0-.*\.png$/);
      expect(inputs[4]).toMatch(/\.capture-telop-title-.*-seq0[/\\]%06d\.png$/);
      expect(inputs).toHaveLength(5);
      // filter 側の index（画像 [1:v] → サブ動画 [2:v] → 図形 [3:v] → telop [4:v]）
      expect(script).toContain('[1:v]format=rgba,settb=');
      expect(script).toContain('[2:v]tpad=stop=-1:stop_mode=clone,');
      expect(script).toContain('[3:v]format=rgba,fade=');
      // telop 連番は色レイヤの**後段**の鎖（接頭辞 tt）で読まれる。ここが [3:v] になったら
      // 図形 PNG をテロップとして重ねている＝ videosCount の渡し忘れ。
      expect(script).toContain('[4:v]format=rgba,settb=1/30,setpts=N+50[ttshp0];');
      expect(script).not.toContain('[3:v]format=rgba,settb=');
      // z 順: 1本目の鎖が 画像 → サブ動画 → 図形、色レイヤを挟んで 2本目が telop。
      const order = [...script.matchAll(/\[(?:shbase|ov\d+)\]\[shp(\d+)\]overlay/g)].map((m) => m[1]);
      expect(order).toEqual(['0', '1', '2']);
      expect(script).toContain('[ttshbase][ttshp0]overlay=');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * **M-4（中間レビュー）: 非撮影経路 × 色レイヤ × サブ動画 × 図形**の組み合わせ。
   *
   * 撮影経路（画像・テロップあり）の色レイヤ入り fixture は既にあるが、**撮影オーバーレイが
   * 無いまま色レイヤで鎖が 2 本に割れる**組み合わせは無試験だった。現状はレビュアーが手で通して
   * 正しい graph が出ることを確認済み（バグ無し）——このテストは **T4 の alpha 追加で
   * 壊れたときに検出できるようにする**ための固定。
   */
  it('M-4: 非撮影経路でも 色レイヤ × サブ動画 × 図形 の z 順と入力 index が正典⑦ どおり', () => {
    const dir = makeProject({
      videoInserts: [{ id: 1, startFrame: 10, endFrame: 40, file: 'sub.mp4', sourceInFrame: 0 }],
      shapes: true,
      // 尺不変の fade 系（時間軸の変異を混ぜない）。色レイヤが入ると composeOverlayChains は
      // 「画像+サブ動画+図形 → 色レイヤ → telop+title」の 2 本鎖になる。
      transitions: [{ id: 1, at: 100, kind: 'fadeBlack', durationFrames: 10 }],
    });
    try {
      const got = plan(dir)!;
      expect(got).not.toBeNull();
      // 撮影オーバーレイが無いので入力は main → サブ動画 → 図形 PNG の3本だけ。
      const inputs = inputsOf(got.args);
      expect(inputs[0]).toBe(join(dir, 'public', 'main.mp4'));
      expect(inputs[1]).toBe(join(dir, 'public', 'sub.mp4'));
      expect(inputs[2]).toMatch(/\.shape-0-.*\.png$/);
      expect(inputs).toHaveLength(3);
      // filter 側の index（サブ動画 [1:v] → 図形 [2:v]）。ここが入れ替わると図形の絵が
      // サブ動画として時間写像を掛けられる。
      expect(got.script).toContain('[1:v]tpad=stop=-1:stop_mode=clone,');
      expect(got.script).toContain('[2:v]format=rgba,fade=');
      // z 順: overlay 鎖は サブ動画 → 図形 の順、色レイヤはその**後**（正典⑦）。
      const videoAt = got.script.indexOf('[1:v]tpad=');
      const shapeAt = got.script.indexOf('[2:v]format=rgba,fade=');
      const colorAt = got.script.indexOf('color=c=0x000000');
      expect(videoAt).toBeGreaterThanOrEqual(0);
      expect(shapeAt).toBeGreaterThan(videoAt);
      expect(colorAt).toBeGreaterThan(shapeAt);
      const order = [...got.script.matchAll(/\[(?:shbase|ov\d+)\]\[shp(\d+)\]overlay/g)].map((m) => m[1]);
      expect(order).toEqual(['0', '1']);
      // 色レイヤ鎖まで含めて出力ラベルは一意・[outv] は1個（2本鎖の接頭辞分離が効いている）。
      expect(got.script.match(/\[outv\]/g)).toHaveLength(1);
      expect(() => assertUniqueFilterOutputLabels(got.script)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('受入 E: videoInserts が無いプロジェクトの args と filter script は 1 文字も変わらない', () => {
    // 同一 fixture の videoInserts 有無だけを振る（有りは配線が入り、無しは従来出力）。
    const withVi = makeProject({ videoInserts: [{ id: 1, startFrame: 0, endFrame: 30, file: 'sub.mp4', sourceInFrame: 0 }], se: true, shapes: true });
    const without = makeProject({ videoInserts: [], se: true, shapes: true });
    try {
      const a = plan(withVi)!;
      const b = plan(without)!;
      // 無し側は従来経路（サブ動画の鎖が 1 文字も現れない）
      expect(b.script).not.toContain('tpad=stop=-1');
      expect(b.script).not.toContain('format=rgb:');
      expect(inputsOf(b.args)).toHaveLength(3); // main + SE + 図形 PNG
      // 有り側は実際に変わっている（比較が無感でないことの実証）
      expect(a.script).not.toBe(b.script);
      // 図形の入力 index は videoInserts の本数だけ後ろへずれる（黙って同じ index を読まない）
      expect(b.script).toContain('[2:v]format=rgba,fade=');
      expect(a.script).toContain('[3:v]format=rgba,fade=');
    } finally {
      rmSync(withVi, { recursive: true, force: true });
      rmSync(without, { recursive: true, force: true });
    }
  });
});

describe('projectVideoInsertPlayback（プレビューと同一の射影列）', () => {
  const cutRegions = [{ start: 40, end: 60 }];
  const ordering = buildCutOrdering(200, cutRegions, undefined);
  const project = (videoInserts: EditorProject['videoInserts']): EditorProject =>
    ({ cutRegions, videoInserts } as unknown as EditorProject);

  it('カット区間に端が落ちたサブ動画は clamp で区間外へ寄る（clamp を外すと 0 へ寄って赤）', () => {
    const out = projectVideoInsertPlayback(
      project([{ id: 1, originalStart: 50, originalEnd: 90, file: 'a.mp4', sourceInFrame: 4 }]),
      ordering,
    );
    // clamp: originalStart 50（カット [40,60) 内）→ 60。project: 60→40 / 90→70。
    expect(out).toEqual([
      { id: 1, playbackStart: 40, playbackEnd: 70, file: 'a.mp4', sourceInFrame: 4, position: undefined, scale: 1, enter: undefined, exit: undefined, playbackRate: undefined },
    ]);
  });

  it('カット区間に完全に飲まれたサブ動画は縮退除外される（他は残る）', () => {
    const out = projectVideoInsertPlayback(
      project([
        { id: 1, originalStart: 45, originalEnd: 55, file: 'a.mp4', sourceInFrame: 0 },
        { id: 2, originalStart: 0, originalEnd: 30, file: 'b.mp4', sourceInFrame: 0 },
      ]),
      ordering,
    );
    expect(out.map((v) => v.id)).toEqual([2]);
  });

  it('scale 未指定は 1 へ解決される（InsertVideo.tsx の `scale ?? 1` と同値）', () => {
    const out = projectVideoInsertPlayback(
      project([
        { id: 1, originalStart: 0, originalEnd: 10, file: 'a.mp4', sourceInFrame: 0 },
        { id: 2, originalStart: 10, originalEnd: 20, file: 'b.mp4', sourceInFrame: 0, scale: 0.25 },
      ]),
      ordering,
    );
    expect(out.map((v) => v.scale)).toEqual([1, 0.25]);
  });
});
