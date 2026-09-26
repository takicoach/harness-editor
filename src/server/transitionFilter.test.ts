/**
 * M3 T2: シーン転換の filter graph 組み立て（映像 xfade 群 + concat・fade 色レイヤ・音声 amix）。
 *
 * ここで pin する文字列は **T1 スパイクが実 ffmpeg で焼いた形と同値**であること
 * （スパイク由来の値: wipe の custom expr 4 方向・`format=gbrp`・`adelay=…S:all=1`・
 *  `amix=…:normalize=0:dropout_transition=0`）。
 */
import { describe, expect, it, vi } from 'vitest';
import { buildCutFilterScript, type KeptSegment } from './fastCutRender';
import {
  assertAudioGroupSamples,
  sceneFadeWindow,
  buildAudioChain,
  buildVideoChain,
  chainLayout,
  deriveSceneFadeSpecs,
  deriveTransitionOverlaps,
  ffmpegColorOrNull,
  normalizeSegment,
  sceneFadeAlphaExpr,
  segmentsInXfadeGroups,
  sceneFadeLayer,
  wipeExpr,
  wipeBoundaryIndex,
  xfadeFor,
  type TransitionOverlapSpec,
} from './transitionFilter';
import { applySceneFadeLayers } from './nativeExportVideo';
import { buildExportTimeline } from '../core/exportTimeline';
import { finalTotalFrames } from '../core/transitionEngine';
import { edgeOverlayOpacityAt, joinOverlayOpacityAt } from '../core/transitionStyle';
import { effectiveDirection } from '../core/transitionDirection';

const FPS = 30;

/** T1 スパイクの crossfade-d7 と同じ諸元（len=14・D=7・B は原本 120 から）。 */
const SEGS: KeptSegment[] = [
  { start: 0, end: 14 },
  { start: 120, end: 134 },
];

/**
 * ffmpeg の式を JS で評価するテスト専用の写し（`clip` / `abs` / `N` だけを扱う）。
 * 生成側の式が線形式そのままであることを、値で検算するために使う（文字列 pin だけだと
 * 「それらしい式」が通ってしまう）。
 */
function evalFfmpegExpr(expr: string, n: number): number {
  const js = expr
    .replace(/\bclip\(/g, 'CLIP(')
    .replace(/\babs\(/g, 'Math.abs(')
    .replace(/\bN\b/g, `(${n})`);
  // eslint-disable-next-line no-new-func
  return new Function('CLIP', `return ${js};`)((v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v)),
  ) as number;
}

describe('既存経路の不変（受入 E）', () => {
  it('overlaps 空なら従来の buildCutFilterScript 出力と1文字同一', () => {
    const legacy =
      '[0:v]fps=30,trim=start=0.000000:end=0.466667,setpts=PTS-STARTPTS[v0];\n' +
      '[0:a]atrim=start=0.000000:end=0.466667,asetpts=PTS-STARTPTS[a0];\n' +
      '[0:v]fps=30,trim=start=4.000000:end=4.466667,setpts=PTS-STARTPTS[v1];\n' +
      '[0:a]atrim=start=4.000000:end=4.466667,asetpts=PTS-STARTPTS[a1];\n' +
      '[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]\n';
    expect(buildCutFilterScript(SEGS, FPS)).toBe(legacy);
    expect(buildCutFilterScript(SEGS, FPS, [])).toBe(legacy);
  });
});

describe('区間の正規化', () => {
  it('xfade 群の内側は trim → format=gbrp → settb=1/fps → setpts=N（T1: yuv420p のまま xfade すると床超え画素が出る）', () => {
    expect(normalizeSegment(0, SEGS[0]!, FPS, { gbrp: true })).toBe(
      '[0:v]fps=30,trim=start=0.000000:end=0.466667,setpts=PTS-STARTPTS,format=gbrp,settb=1/30,setpts=N[v0];',
    );
  });

  it('群の外の区間には gbrp を入れない（適用範囲は xfade 群の内側のみ）', () => {
    expect(normalizeSegment(1, SEGS[1]!, FPS, { gbrp: false })).toBe(
      '[0:v]fps=30,trim=start=4.000000:end=4.466667,setpts=PTS-STARTPTS,settb=1/30,setpts=N[v1];',
    );
  });

  it('gbrp を掛ける区間は xfade 群に触れる区間だけ', () => {
    // 区間 0-1 に転換・2 は単独・3-4 に転換
    expect(
      segmentsInXfadeGroups(5, [
        { afterIndex: 0, frames: 2, kind: 'crossfade' },
        { afterIndex: 3, frames: 2, kind: 'crossfade' },
      ]),
    ).toEqual([true, true, false, true, true]);
  });
});

describe('xfade の種別・方向（T1 の採否表どおり）', () => {
  it('crossfade は stock fade', () => {
    expect(xfadeFor('crossfade', undefined, 7)).toBe('fade');
  });

  it('slide は stock slide{方向}・名前は恒等写像（T1 正典表⑥）', () => {
    expect(xfadeFor('slide', 'left', 16)).toBe('slideleft');
    expect(xfadeFor('slide', 'right', 16)).toBe('slideright');
    expect(xfadeFor('slide', 'up', 16)).toBe('slideup');
    expect(xfadeFor('slide', 'down', 16)).toBe('slidedown');
  });

  it('wipe は custom expr（D を定数展開・k はフレーム格子へ吸着・先に掛けてから割る）', () => {
    expect(xfadeFor('wipe', 'left', 3)).toBe(
      'custom:expr=if(gte(X\\,W-W*round((1-P)*3)/3)\\,B\\,A)',
    );
    expect(xfadeFor('wipe', 'right', 3)).toBe('custom:expr=if(lt(X\\,W*round((1-P)*3)/3)\\,B\\,A)');
    expect(xfadeFor('wipe', 'up', 16)).toBe(
      'custom:expr=if(gte(Y\\,H-H*round((1-P)*16)/16)\\,B\\,A)',
    );
    expect(xfadeFor('wipe', 'down', 16)).toBe('custom:expr=if(lt(Y\\,H*round((1-P)*16)/16)\\,B\\,A)');
  });

  it('wipeExpr は W/D が非整数の D でも「先に掛けてから割る」形を保つ（T1 の罠2）', () => {
    // 720*(1-1/3) = 480.00000000000006 の丸めを踏まないため W-W*k/D と書く。
    expect(wipeExpr('left', 7)).toContain('W-W*round((1-P)*7)/7');
    expect(wipeExpr('left', 7)).not.toContain('(1-round');
  });

  /**
   * `wipeBoundaryIndex`（幾何軸の期待値）と `wipeExpr`（実際に ffmpeg が評価する式）の**同値 pin**
   * （B-1・T5 レビュー C-1）。式を JS で実評価して、全画素の A/B 帰属が helper の
   * 「[0,index) と [index,size) の 2 区間」と 1 画素も違わないことを見る。
   * 片方だけ直すと必ず赤（写し崩れ・丸めの向き違いが検出できる）。
   */
  it('wipeBoundaryIndex は wipeExpr を評価した A/B 帰属と全画素一致（幾何軸の期待値の出所）', () => {
    const size = { width: 1280, height: 720 };
    /** ffmpeg 式 → JS 関数（`\,` の解除・`gte`/`lt`/`if` の置換だけ）。 */
    const evaluator = (expr: string): ((v: { X: number; Y: number; P: number }) => 'A' | 'B') => {
      const js = expr
        .replace(/\\,/g, ',')
        .replace(/gte\(([^,]+),([^)]+)\)/g, '($1>=$2)')
        .replace(/lt\(([^,]+),([^)]+)\)/g, '($1<$2)')
        .replace(/if\(([\s\S]+),B,A\)/, "(($1)?'B':'A')")
        .replace(/round/g, 'Math.round');
      // eslint-disable-next-line no-new-func
      const fn = new Function('X', 'Y', 'P', 'W', 'H', `return ${js};`) as (
        X: number, Y: number, P: number, W: number, H: number,
      ) => 'A' | 'B';
      return (v) => fn(v.X, v.Y, v.P, size.width, size.height);
    };
    let checked = 0;
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      for (const d of [2, 3, 7, 16, 60]) {
        const evaluate = evaluator(wipeExpr(direction, d));
        for (let k = 0; k <= d; k++) {
          // xfade の P は 1→0（P=1 が転換開始）。式側は round((1−P)*D) でフレーム格子へ吸着する。
          const P = 1 - k / d;
          const b = wipeBoundaryIndex(direction, k, d, size);
          const extent = b.axis === 'x' ? size.width : size.height;
          for (let i = 0; i < extent; i++) {
            const actual = evaluate(b.axis === 'x' ? { X: i, Y: 0, P } : { X: 0, Y: i, P });
            const expected = (i < b.index) === b.firstIsA ? 'A' : 'B';
            expect(actual, `${direction} D=${d} k=${k} i=${i}`).toBe(expected);
          }
          checked++;
        }
      }
    }
    // 空振り防止（対象 0 件で緑にならない）。
    expect(checked).toBe(4 * (3 + 4 + 8 + 17 + 61));
  });

  /**
   * B-0（2026-09-02）: direction 未指定は**正典と同じ既定方向**で描く（旧実装は throw）。
   * エディタは長らく direction を保存しておらず、実プロジェクトの wipe/slide は必ず未指定。
   * throw のままだと転換が丸ごと Remotion 経路へ退避していた（受入 F の実測）。
   */
  it('slide/wipe の direction 欠落は正典の既定方向（left）で描く', () => {
    expect(xfadeFor('slide', undefined, 8)).toBe(xfadeFor('slide', effectiveDirection({}), 8));
    expect(xfadeFor('slide', undefined, 8)).toBe('slideleft');
    expect(xfadeFor('wipe', undefined, 8)).toBe(xfadeFor('wipe', effectiveDirection({}), 8));
    expect(xfadeFor('wipe', undefined, 8)).toBe(`custom:expr=${wipeExpr('left', 8)}`);
    // 弁別: 別方向は別の式（上の一致が恒真でないこと）。
    expect(xfadeFor('wipe', 'right', 8)).not.toBe(xfadeFor('wipe', undefined, 8));
  });
});

describe('区間レイアウトと総尺検算', () => {
  it('overlaps ぶんだけ finalStart が前へ詰み、総フレームが縮む', () => {
    const layout = chainLayout(
      [
        { start: 0, end: 14 },
        { start: 120, end: 134 },
        { start: 240, end: 250 },
      ],
      [{ afterIndex: 0, frames: 7, kind: 'crossfade' }],
    );
    expect(layout.finalStarts).toEqual([0, 7, 21]);
    expect(layout.totalFrames).toBe(14 + 14 + 10 - 7);
  });

  it('重なりが区間長以上なら throw（fail-loud・非恒等 fixture）', () => {
    expect(() =>
      chainLayout(
        [
          { start: 0, end: 6 },
          { start: 120, end: 140 },
        ],
        [{ afterIndex: 0, frames: 6, kind: 'crossfade' }],
      ),
    ).toThrow(/重なり/);
  });

  /**
   * C-7 M-2: 片側ずつの検査（`D < len`）を両方通っても、**左右の和**が区間長を超える形は
   * xfade の入力が負の長さになる。正典（cap = floor(len/2)）はこの形を作らないので、
   * ここへ来たら呼び出し側の写し崩れ——黙って壊れた filter を出さずに throw する。
   */
  it('左右の重なりの和が区間長を超えたら throw（片側ずつは通る形）', () => {
    const three = [
      { start: 0, end: 10 },
      { start: 100, end: 110 },
      { start: 200, end: 210 },
    ];
    // 片側だけなら 6 < 10 で通る（＝この形は片側検査では捕まらない）。
    expect(() => chainLayout(three, [{ afterIndex: 0, frames: 6, kind: 'crossfade' }])).not.toThrow();
    expect(() =>
      chainLayout(three, [
        { afterIndex: 0, frames: 6, kind: 'crossfade' },
        { afterIndex: 1, frames: 6, kind: 'crossfade' },
      ]),
    ).toThrow(/食い尽くされ/);
    // 等号（正典の接触ケース `D_l + D_r = len`）は通る。
    expect(() =>
      chainLayout(three, [
        { afterIndex: 0, frames: 5, kind: 'crossfade' },
        { afterIndex: 1, frames: 5, kind: 'crossfade' },
      ]),
    ).not.toThrow();
  });

  it('afterIndex が範囲外・重複なら throw', () => {
    expect(() => chainLayout(SEGS, [{ afterIndex: 1, frames: 2, kind: 'crossfade' }])).toThrow();
    expect(() =>
      chainLayout(SEGS, [
        { afterIndex: 0, frames: 2, kind: 'crossfade' },
        { afterIndex: 0, frames: 3, kind: 'crossfade' },
      ]),
    ).toThrow();
  });

  it('buildCutFilterScript は総尺が期待値と違えば throw（Remotion 退避の引き金）', () => {
    expect(() =>
      buildCutFilterScript(SEGS, FPS, [{ afterIndex: 0, frames: 7, kind: 'crossfade' }], {
        expectTotalFrames: 22, // 正しくは 21
      }),
    ).toThrow(/総フレーム/);
    expect(() =>
      buildCutFilterScript(SEGS, FPS, [{ afterIndex: 0, frames: 7, kind: 'crossfade' }], {
        expectTotalFrames: 21,
      }),
    ).not.toThrow();
  });
});

describe('映像 chain（xfade 群 + concat）', () => {
  it('転換 1 箇所: offset=(lenA-D)/fps・duration=D/fps（T1 スパイクの crossfade-d7 と同値）', () => {
    expect(buildVideoChain(SEGS, [{ afterIndex: 0, frames: 7, kind: 'crossfade' }], FPS).chainLines).toEqual([
      '[v0][v1]xfade=transition=fade:duration=0.233333333:offset=0.233333333[x1];',
      '[x1]format=yuv420p[outv];',
    ]);
  });

  it('群 + concat 混在（A–B 転換 / B–C 無し / C–D 転換）: 群の出口だけ yuv420p へ戻して concat', () => {
    const segs: KeptSegment[] = [
      { start: 0, end: 30 },
      { start: 120, end: 150 },
      { start: 240, end: 270 },
      { start: 300, end: 330 },
    ];
    const overlaps: TransitionOverlapSpec[] = [
      { afterIndex: 0, frames: 10, kind: 'crossfade' },
      { afterIndex: 2, frames: 6, kind: 'slide', direction: 'up' },
    ];
    const chain = buildVideoChain(segs, overlaps, FPS);
    expect(chain.chainLines).toEqual([
      '[v0][v1]xfade=transition=fade:duration=0.333333333:offset=0.666666667[x1];',
      '[x1]format=yuv420p[g0];',
      '[v2][v3]xfade=transition=slideup:duration=0.200000000:offset=0.800000000[x3];',
      '[x3]format=yuv420p[g2];',
      '[g0][g2]concat=n=2:v=1:a=0[outv];',
    ]);
    expect(chain.chainLines.join('\n').match(/\[outv\]/g)).toHaveLength(1);
  });

  it('転換に関与しない区間は gbrp も群出口の変換も通らない（A–B 転換 / C 単独）', () => {
    const segs: KeptSegment[] = [
      { start: 0, end: 30 },
      { start: 120, end: 150 },
      { start: 240, end: 270 },
    ];
    const chain = buildVideoChain(segs, [{ afterIndex: 0, frames: 10, kind: 'crossfade' }], FPS);
    expect(chain.segmentLines[2]).not.toContain('format=gbrp');
    expect(chain.chainLines).toEqual([
      '[v0][v1]xfade=transition=fade:duration=0.333333333:offset=0.666666667[x1];',
      '[x1]format=yuv420p[g0];',
      '[g0][v2]concat=n=2:v=1:a=0[outv];',
    ]);
  });

  it('連続転換（A–B・B–C の両方）は 1 群の chained xfade・2本目の offset は群の累積尺基準', () => {
    // len 30 / 30 / 30・D=10 と D=6 → 2本目の offset は (30+30-10-6)/30 秒
    const segs: KeptSegment[] = [
      { start: 0, end: 30 },
      { start: 120, end: 150 },
      { start: 240, end: 270 },
    ];
    const chain = buildVideoChain(
      segs,
      [
        { afterIndex: 0, frames: 10, kind: 'crossfade' },
        { afterIndex: 1, frames: 6, kind: 'wipe', direction: 'down' },
      ],
      FPS,
    );
    expect(chain.chainLines).toEqual([
      '[v0][v1]xfade=transition=fade:duration=0.333333333:offset=0.666666667[x1];',
      '[x1][v2]xfade=transition=custom:expr=if(lt(Y\\,H*round((1-P)*6)/6)\\,B\\,A):' +
        'duration=0.200000000:offset=1.466666667[x2];',
      '[x2]format=yuv420p[outv];',
    ]);
  });

  it('D_left + D_right = L の境界（L 偶数・両方 L/2）でも成立し、総尺は finalTotalFrames と一致', () => {
    const segs: KeptSegment[] = [
      { start: 0, end: 32 },
      { start: 120, end: 152 },
      { start: 240, end: 272 },
    ];
    const overlaps: TransitionOverlapSpec[] = [
      { afterIndex: 0, frames: 16, kind: 'crossfade' },
      { afterIndex: 1, frames: 16, kind: 'crossfade' },
    ];
    // 期待値は正本（transitionEngine.finalTotalFrames）から導く（自前式で書かない）。
    const expected = finalTotalFrames(96, [
      { boundary: 32, overlap: 16 },
      { boundary: 64, overlap: 16 },
    ]);
    expect(chainLayout(segs, overlaps).totalFrames).toBe(expected);
    expect(buildVideoChain(segs, overlaps, FPS).chainLines).toEqual([
      '[v0][v1]xfade=transition=fade:duration=0.533333333:offset=0.533333333[x1];',
      '[x1][v2]xfade=transition=fade:duration=0.533333333:offset=1.066666667[x2];',
      '[x2]format=yuv420p[outv];',
    ]);
  });

  it('転換が無ければ concat だけ（xfade は duration>0 必須なので置かない）', () => {
    expect(buildVideoChain(SEGS, [], FPS).chainLines).toEqual(['[v0][v1]concat=n=2:v=1:a=0[outv];']);
  });
});

describe('音声 chain（重なり窓は合算・T1 正典表③・群構造は映像と同型）', () => {
  it('atrim → aresample=48000 → adelay=…S:all=1 → amix（channel_layouts は触らない）', () => {
    expect(buildAudioChain(SEGS, [{ afterIndex: 0, frames: 7, kind: 'crossfade' }], FPS)).toEqual({
      segmentLines: [
        '[0:a]atrim=start=0.000000:end=0.466667,asetpts=PTS-STARTPTS,aresample=48000[a0];',
        '[0:a]atrim=start=4.000000:end=4.466667,asetpts=PTS-STARTPTS,aresample=48000,adelay=11200S:all=1[a1];',
      ],
      chainLines: ['[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0:duration=longest[outa]'],
    });
  });

  it('adelay のサンプル数は群内相対 finalStart×48000/fps（T1: 16 フレーム → 25600S）', () => {
    const segs: KeptSegment[] = [
      { start: 0, end: 32 },
      { start: 120, end: 152 },
    ];
    const chain = buildAudioChain(segs, [{ afterIndex: 0, frames: 16, kind: 'crossfade' }], FPS);
    expect(chain.segmentLines[1]).toContain('adelay=25600S:all=1');
  });

  /**
   * I-2: 重なりに触れない区間は amix に入れず concat する（映像と同じ群構造）。
   * 全区間を1つの amix に入れると、区間数に比例して合算の実行コストが増え、
   * 300 区間規模で書き出し時間が跳ね上がる（report の実測表）。
   */
  it('重なりに触れない区間は concat・xfade 群の内側だけ amix', () => {
    const segs: KeptSegment[] = [
      { start: 0, end: 30 },
      { start: 120, end: 150 },
      { start: 240, end: 270 },
    ];
    // 境界 1（区間1–2）だけに転換。区間0 は群の外。
    const chain = buildAudioChain(segs, [{ afterIndex: 1, frames: 10, kind: 'crossfade' }], FPS);
    expect(chain.segmentLines[0]).not.toContain('adelay');
    // 群内 2 本目の遅延は**群の先頭からの相対**（30-10=20 フレーム相当ではなく、群内 20 フレーム）。
    expect(chain.segmentLines[2]).toContain('adelay=32000S:all=1');
    expect(chain.chainLines).toEqual([
      '[a1][a2]amix=inputs=2:normalize=0:dropout_transition=0:duration=longest[ga1];',
      '[a0][ga1]concat=n=2:v=0:a=1[outa]',
    ]);
  });

  it('転換が無ければ amix を通さず concat だけ', () => {
    const chain = buildAudioChain(SEGS, [], FPS);
    expect(chain.chainLines).toEqual(['[a0][a1]concat=n=2:v=0:a=1[outa]']);
    expect(chain.segmentLines.join('\n')).not.toContain('adelay');
  });

  /** M-1: 群の総サンプル数がフレーム数から求めた期待値と一致することを検算する。 */
  it('群の総サンプル数が期待値とずれたら throw（丸め 1 サンプルまで許容）', () => {
    const segs: KeptSegment[] = [
      { start: 0, end: 30 },
      { start: 120, end: 150 },
    ];
    // 正常系は throw しない。
    expect(() => buildAudioChain(segs, [{ afterIndex: 0, frames: 10, kind: 'crossfade' }], FPS)).not.toThrow();
    // 検算そのものの発火（緩和が発火しない #200 対策）: 2 フレーム = 3200 サンプル。
    expect(() => assertAudioGroupSamples(0, 2, FPS, 3201)).not.toThrow();
    expect(() => assertAudioGroupSamples(0, 2, FPS, 3205)).toThrow(/サンプル/);
  });
});

describe('全体スクリプト（映像 + 音声）', () => {
  it('転換ありのスクリプトは [outv] / [outa] を各1個持ち、末尾に ; を付けない', () => {
    const script = buildCutFilterScript(SEGS, FPS, [{ afterIndex: 0, frames: 7, kind: 'crossfade' }]);
    expect(script).toBe(
      '[0:v]fps=30,trim=start=0.000000:end=0.466667,setpts=PTS-STARTPTS,format=gbrp,settb=1/30,setpts=N[v0];\n' +
        '[0:a]atrim=start=0.000000:end=0.466667,asetpts=PTS-STARTPTS,aresample=48000[a0];\n' +
        '[0:v]fps=30,trim=start=4.000000:end=4.466667,setpts=PTS-STARTPTS,format=gbrp,settb=1/30,setpts=N[v1];\n' +
        '[0:a]atrim=start=4.000000:end=4.466667,asetpts=PTS-STARTPTS,aresample=48000,adelay=11200S:all=1[a1];\n' +
        '[v0][v1]xfade=transition=fade:duration=0.233333333:offset=0.233333333[x1];\n' +
        '[x1]format=yuv420p[outv];\n' +
        '[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0:duration=longest[outa]\n',
    );
    expect(script.match(/\[outv\]/g)).toHaveLength(1);
    expect(script.match(/\[outa\]/g)).toHaveLength(1);
    expect(script.trimEnd().endsWith(';')).toBe(false);
  });
});

describe('fade 色レイヤ（alpha を geq で駆動・T1 正典表②で最前面）', () => {
  const TOTAL = 60;

  it('head/tail/join の式 pin', () => {
    expect(sceneFadeAlphaExpr('head', 16, TOTAL)).toBe('255*clip(1-N/16,0,1)');
    expect(sceneFadeAlphaExpr('tail', 16, TOTAL)).toBe('255*clip((N-44)/16,0,1)');
    expect(sceneFadeAlphaExpr(30, 16, TOTAL)).toBe('255*clip(1-abs(N-30)/(16/2),0,1)');
  });

  it.each([2, 3, 16])('D=%i の head 式が edgeOverlayOpacityAt と全フレーム一致', (d) => {
    const expr = sceneFadeAlphaExpr('head', d, TOTAL);
    for (let n = 0; n < TOTAL; n++) {
      expect(evalFfmpegExpr(expr, n) / 255).toBeCloseTo(edgeOverlayOpacityAt(n, 'head', TOTAL, d), 12);
    }
  });

  it.each([2, 3, 16])('D=%i の tail 式が edgeOverlayOpacityAt と全フレーム一致', (d) => {
    const expr = sceneFadeAlphaExpr('tail', d, TOTAL);
    for (let n = 0; n < TOTAL; n++) {
      expect(evalFfmpegExpr(expr, n) / 255).toBeCloseTo(edgeOverlayOpacityAt(n, 'tail', TOTAL, d), 12);
    }
  });

  it.each([2, 3, 16])('D=%i の join 式が joinOverlayOpacityAt と全フレーム一致', (d) => {
    const expr = sceneFadeAlphaExpr(30, d, TOTAL);
    for (let n = 0; n < TOTAL; n++) {
      expect(evalFfmpegExpr(expr, n) / 255).toBeCloseTo(joinOverlayOpacityAt(n, 30, d), 12);
    }
  });

  it('数点の値を直接検算（D=16・join=30）', () => {
    const expr = sceneFadeAlphaExpr(30, 16, TOTAL);
    expect(evalFfmpegExpr(expr, 30)).toBeCloseTo(255, 9); // 中心で不透明
    expect(evalFfmpegExpr(expr, 26)).toBeCloseTo(255 * 0.5, 9); // 半分の距離で 0.5
    expect(evalFfmpegExpr(expr, 22)).toBeCloseTo(0, 9); // 窓端で 0
    expect(evalFfmpegExpr(expr, 10)).toBeCloseTo(0, 9); // 窓外は 0
  });

  /**
   * C-3: 色ソースは**窓長だけ**作る。全尺の `color` に `geq` を掛けると、窓外の
   * 「alpha=0 と分かっているフレーム」まで 1 画素ずつ式を評価することになり、
   * 実データ規模（300 秒）で書き出しが桁で遅くなる（report の実測: 104s → 8.6s）。
   */
  it('窓の範囲 pin（join は [J−D/2, J+D/2)・head は [0,D)・tail は [total−D,total)）', () => {
    expect(sceneFadeWindow(30, 16, TOTAL)).toEqual({ startFrame: 22, frames: 16 });
    expect(sceneFadeWindow('head', 16, TOTAL)).toEqual({ startFrame: 0, frames: 16 });
    expect(sceneFadeWindow('tail', 16, TOTAL)).toEqual({ startFrame: TOTAL - 16, frames: 16 });
    // 奇数 D は alpha>0 のフレームを過不足なく覆う（D=3・J=30 → 29,30,31）。
    expect(sceneFadeWindow(30, 3, TOTAL)).toEqual({ startFrame: 29, frames: 3 });
    // 端で切れる窓は総尺内へクリップする。
    expect(sceneFadeWindow(4, 16, TOTAL)).toEqual({ startFrame: 0, frames: 12 });
  });

  it('窓外は正典の不透明度が 0（＝色ソースを窓に切っても絵が変わらない）', () => {
    for (const [at, d] of [[30, 16], [30, 3], ['head', 16], ['tail', 16]] as const) {
      const win = sceneFadeWindow(at, d, TOTAL);
      for (let n = 0; n < TOTAL; n++) {
        if (n >= win.startFrame && n < win.startFrame + win.frames) continue;
        const op = at === 'head' || at === 'tail'
          ? edgeOverlayOpacityAt(n, at, TOTAL, d)
          : joinOverlayOpacityAt(n, at, d);
        expect(op, `at=${at} D=${d} n=${n}`).toBe(0);
      }
    }
  });

  it('窓内の式は原点シフト後も正典と全フレーム一致', () => {
    for (const [at, d] of [[30, 16], [30, 3], ['head', 16], ['tail', 16]] as const) {
      const win = sceneFadeWindow(at, d, TOTAL);
      const expr = sceneFadeAlphaExpr(at, d, TOTAL, win.startFrame);
      for (let k = 0; k < win.frames; k++) {
        const n = win.startFrame + k;
        const expected = at === 'head' || at === 'tail'
          ? edgeOverlayOpacityAt(n, at, TOTAL, d)
          : joinOverlayOpacityAt(n, at, d);
        expect(evalFfmpegExpr(expr, k) / 255, `at=${at} D=${d} k=${k}`).toBeCloseTo(expected, 12);
      }
    }
  });

  it('色レイヤの1行 pin（窓長の color ソース + rgba + setpts=N+窓開始 + geq alpha）', () => {
    expect(
      sceneFadeLayer({ color: '#000000', at: 30, durationFrames: 16 }, 0, FPS, { width: 1280, height: 720 }, TOTAL),
    ).toBe(
      'color=c=0x000000:s=1280x720:r=30:d=0.533333,format=rgba,settb=1/30,setpts=N+22,' +
        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(1-abs(N-8)/(16/2),0,1)'[fd0];",
    );
  });

  it('色は #RRGGBB / #RGB / CSS 基本 16 色を受ける（それ以外は throw）', () => {
    // C-1: 正典（プレビュー）は CSS 色文字列をそのまま描くので、名前色・短縮形も native で描く。
    expect(
      sceneFadeLayer({ color: 'red', at: 'head', durationFrames: 4 }, 0, FPS, { width: 8, height: 8 }, TOTAL),
    ).toContain('color=c=0xFF0000:');
    expect(() =>
      sceneFadeLayer({ color: 'rgb(255,0,0)', at: 'head', durationFrames: 4 }, 0, FPS, { width: 8, height: 8 }, TOTAL),
    ).toThrow(/色/);
  });

  /**
   * C-1: 変換表は **CSS Level 1 の 16 色に限定**する（拡張色まで手写しすると正典＝ブラウザの
   * 色解決と乖離したときに黙って別の色を描く）。ここに無い名前は null＝Remotion 退避。
   */
  describe('ffmpegColorOrNull（C-1）', () => {
    it('CSS 基本 16 色の全件を pin する（1 件でも表から落ちると赤）', () => {
      const expected: Record<string, string> = {
        black: '0x000000', silver: '0xC0C0C0', gray: '0x808080', white: '0xFFFFFF',
        maroon: '0x800000', red: '0xFF0000', purple: '0x800080', fuchsia: '0xFF00FF',
        green: '0x008000', lime: '0x00FF00', olive: '0x808000', yellow: '0xFFFF00',
        navy: '0x000080', blue: '0x0000FF', teal: '0x008080', aqua: '0x00FFFF',
      };
      for (const [name, hex] of Object.entries(expected)) {
        expect(ffmpegColorOrNull(name), name).toBe(hex);
        expect(ffmpegColorOrNull(name.toUpperCase()), name.toUpperCase()).toBe(hex);
      }
      expect(Object.keys(expected)).toHaveLength(16);
    });

    it('#RRGGBB は大小そのまま・#RGB は展開・それ以外は null', () => {
      expect(ffmpegColorOrNull('#0a84ff')).toBe('0x0a84ff'); // 既存 script のバイト不変
      expect(ffmpegColorOrNull('#0A84FF')).toBe('0x0A84FF');
      expect(ffmpegColorOrNull('#fff')).toBe('0xFFFFFF');
      expect(ffmpegColorOrNull('#0a8')).toBe('0x00AA88');
      // 拡張色（X11）・関数記法・空文字は退避側。
      expect(ffmpegColorOrNull('coral')).toBeNull();
      expect(ffmpegColorOrNull('rgb(255,0,0)')).toBeNull();
      expect(ffmpegColorOrNull('#12345')).toBeNull();
      expect(ffmpegColorOrNull('')).toBeNull();
    });
  });

  it('applySceneFadeLayers は [outv] を付け替えて色レイヤ鎖を足す（窓の enable つき）', () => {
    const base = '[v0]something[outv]\n';
    const out = applySceneFadeLayers(
      base,
      [{ color: '#FFFFFF', at: 'head', durationFrames: 4 }],
      FPS,
      { width: 8, height: 8 },
      TOTAL,
    );
    expect(out).toBe(
      '[v0]something[fdraw];\n' +
        '[fdraw]settb=1/30,setpts=N[fdbase];\n' +
        'color=c=0xFFFFFF:s=8x8:r=30:d=0.133333,format=rgba,settb=1/30,setpts=N,' +
        "geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(1-N/4,0,1)'[fd0];\n" +
        "[fdbase][fd0]overlay=x=0:y=0:eof_action=pass:enable='gte(t,-0.016667)*lt(t,0.116667)'[outv]\n",
    );
    expect(out.match(/\[outv\]/g)).toHaveLength(1);
  });

  it('レイヤが空なら script は1文字も変わらない', () => {
    const base = '[v0]something[outv]\n';
    expect(applySceneFadeLayers(base, [], FPS, { width: 8, height: 8 }, TOTAL)).toBe(base);
  });
});

describe('ExportTimeline からの導出（設計判断7: playbackToFinal を独自に呼ばない）', () => {
  const transitions = [
    { id: 1, at: 14, kind: 'crossfade' as const, durationFrames: 7 },
    { id: 2, at: 'head' as const, kind: 'fadeBlack' as const, durationFrames: 16 },
    { id: 3, at: 28, kind: 'fadeColor' as const, durationFrames: 10 },
  ];
  const timeline = buildExportTimeline({
    fps: FPS,
    segments: [
      { originalStart: 0, originalEnd: 14 },
      { originalStart: 120, originalEnd: 134 },
      { originalStart: 240, originalEnd: 254 },
    ],
    transitions,
  });

  it('重なり量は finalEnd(i) − finalStart(i+1) から取る', () => {
    expect(deriveTransitionOverlaps(timeline, transitions)).toEqual([
      { afterIndex: 0, frames: 7, kind: 'crossfade', direction: undefined },
    ]);
    // ExportTimeline 自身の総尺と一致していること（検算の分母）
    expect(timeline.totalFrames).toBe(14 * 3 - 7);
  });

  it('fade 系は最終座標の join フレームへ写す（playbackToFinal を呼ばない）', () => {
    expect(deriveSceneFadeSpecs(timeline, transitions)).toEqual([
      { color: '#000000', at: 'head', durationFrames: 16 },
      // 再生 28 は crossfade(7) の後ろなので最終 21
      { color: '#FF3B30', at: 21, durationFrames: 10 },
    ]);
  });

  it('境界に一致しない at の fade は捨てる（黙って別位置に置かない）が、warn を1回出す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(deriveSceneFadeSpecs(timeline, [{ id: 9, at: 13, kind: 'fadeWhite', durationFrames: 4 }])).toEqual(
        [],
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('シーン転換');
    } finally {
      warn.mockRestore();
    }
  });

  /** M-4: 同じつなぎ目に重なり系の転換が2つある入力は throw（どちらを採るか黙って決めない）。 */
  it('同一境界に重なり系の転換が2つあれば throw', () => {
    const dup = [
      { id: 1, at: 14, kind: 'crossfade' as const, durationFrames: 7 },
      { id: 2, at: 14, kind: 'wipe' as const, durationFrames: 7, direction: 'left' as const },
    ];
    expect(() => deriveTransitionOverlaps(timeline, dup)).toThrow(/2つ|複数/);
  });
});
