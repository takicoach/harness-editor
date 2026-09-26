/**
 * M3 T2 修正ラウンド: 転換配線（原本 at → 再生 at → overlaps/fades/script）と
 * オーバーレイ合成順（設計判断5）の pin。
 *
 * ここで守る契約は3つ:
 *  1. **C-1 座標系**: `project.sceneTransitions[].at` は**原本フレーム**。正典
 *     （`preview/playbackModel.ts` / `core/project.ts`）と同じく `computeJoins` →
 *     `resolveSceneTransitions` を通して**再生フレーム**へ解決してから ExportTimeline へ渡す。
 *     カットがあると原本と再生がずれるため、素通しすると転換が**どの境界にも付かない**
 *     （= 静かに転換無しの動画が出る）。
 *  2. **C-2 scale 挿入**: 転換ありの script は `[outv][outa]` という並びを持たない
 *     （映像 chain が `[outv];` で終わり音声が別行）。挿入点は「`[outv]` は必ず1個」の
 *     契約に統一し、置換が起きなければ throw する（黙って原寸で書き出さない）。
 *  3. **設計判断5 の z 順**: 色レイヤは**図形鎖の後・撮影 PNG（telop+title）鎖の前**。
 */
import { describe, expect, it } from 'vitest';
import { buildCutOrdering } from '../core/cutOrder';
import type { CutRegion, SceneTransition } from '../core/types';
import { buildTransitionWiring, composeOverlayChains } from './fastCutPlan';
import { assertUniqueFilterOutputLabels, filterOutputLabels, type OverlayLayer } from './nativeExportVideo';
import { xfadeFor } from './transitionFilter';
import { effectiveDirection } from '../core/transitionDirection';

const FPS = 30;
const ORIGINAL = 300;
/**
 * 原本と再生がずれる fixture。カット [50,150) と [200,220) を落とすと
 * 区間は [0,50) / [150,200) / [220,300)、つなぎ目は
 * （原本 50 → 再生 50）と（**原本 200 → 再生 100**）になる。
 * 2 本目のつなぎ目は原本と再生の数値が違うので、素通しの誤りがここで必ず出る。
 */
const CUTS: CutRegion[] = [
  { start: 50, end: 150 },
  { start: 200, end: 220 },
];
const ORDERING = buildCutOrdering(ORIGINAL, CUTS, undefined);
const SOURCE = { width: 3840, height: 2160 };

function wiring(transitions: SceneTransition[], resolution: 'full' | '1080p' = 'full') {
  return buildTransitionWiring({
    fps: FPS,
    originalTotalFrames: ORIGINAL,
    cutRegions: CUTS,
    ordering: ORDERING,
    sceneTransitions: transitions,
    options: { resolution, quality: 'high' },
    source: SOURCE,
  });
}

describe('C-1: sceneTransitions.at は原本フレーム（再生フレームへ解決してから使う）', () => {
  it('原本 200 のつなぎ目（再生 100）に転換が付く＝overlaps が非空', () => {
    const w = wiring([{ id: 1, at: 200, kind: 'crossfade', durationFrames: 16 }]);
    expect(w.overlaps).toEqual([{ afterIndex: 1, frames: 16, kind: 'crossfade', direction: undefined }]);
  });

  it('別の境界（原本 50 / 再生 50）には付かない', () => {
    const w = wiring([{ id: 1, at: 200, kind: 'crossfade', durationFrames: 16 }]);
    expect(w.overlaps.map((o) => o.afterIndex)).toEqual([1]);
    // 総尺は 3 区間の合計（50+50+80=180）から重なり 16 を引いた値。
    expect(w.totalFrames).toBe(180 - 16);
  });

  it('原本にしか存在しない at（つなぎ目でない 120）は落ちる（黙って別境界に付けない）', () => {
    const w = wiring([{ id: 1, at: 120, kind: 'crossfade', durationFrames: 16 }]);
    expect(w.overlaps).toEqual([]);
    expect(w.totalFrames).toBe(180);
  });

  it('fade 系も原本 at を再生→最終座標へ解決する（head/tail は素通し）', () => {
    const w = wiring([
      { id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 8 },
      { id: 2, at: 200, kind: 'fadeWhite', durationFrames: 10 },
      { id: 3, at: 'tail', kind: 'fadeBlack', durationFrames: 6 },
    ]);
    expect(w.sceneFades).toEqual([
      { color: '#000000', at: 'head', durationFrames: 8 },
      // 原本 200 → 再生 100 → （重なり無しなので）最終 100
      { color: '#FFFFFF', at: 100, durationFrames: 10 },
      { color: '#000000', at: 'tail', durationFrames: 6 },
    ]);
  });
});

/**
 * B-0（受入 F・2026-09-02 実測）: エディタは `direction` を永続化していなかったため、実プロジェクトの
 * wipe/slide は **direction 未指定**で保存される。ここが throw すると `planFastCut` が
 * 「シーン転換の配線に失敗（Remotion 経路へ退避）」で丸ごと退避し、native 書き出しから転換が消える。
 */
describe('B-0: direction 未指定の wipe/slide も配線できる（正典の既定方向で描く）', () => {
  it('wipe（direction 未指定）: 配線が成立し xfade は既定方向 left の式', () => {
    const w = wiring([{ id: 1, at: 200, kind: 'wipe', durationFrames: 16 }]);
    expect(w.overlaps).toEqual([{ afterIndex: 1, frames: 16, kind: 'wipe', direction: undefined }]);
    expect(w.script).toContain(`transition=${xfadeFor('wipe', effectiveDirection({}), 16)}`);
    expect(w.script).toContain('W-W*round((1-P)*16)/16'); // left の式（値でも固定）
  });

  it('slide（direction 未指定）: 同じく成立し `slideleft`', () => {
    const w = wiring([{ id: 1, at: 200, kind: 'slide', durationFrames: 16 }]);
    expect(w.script).toContain('transition=slideleft');
  });

  it('明示方向は従来どおりそのまま使う（4方向）', () => {
    for (const [d, expected] of [
      ['left', 'slideleft'], ['right', 'slideright'], ['up', 'slideup'], ['down', 'slidedown'],
    ] as const) {
      const w = wiring([{ id: 1, at: 200, kind: 'slide', durationFrames: 16, direction: d }]);
      expect(w.script).toContain(`transition=${expected}`);
    }
  });
});

describe('C-2: scale 挿入は [outv] 基準（転換ありでも必ず入る）', () => {
  it('転換あり × 1080p で scale が script に入る', () => {
    const w = wiring([{ id: 1, at: 200, kind: 'crossfade', durationFrames: 16 }], '1080p');
    expect(w.script).toContain('scale=1920:1080:flags=lanczos');
    expect(w.script.match(/\[outv\]/g)).toHaveLength(1);
  });

  it('転換なし × 1080p の挿入結果は従来の文字列と同一（受入 E）', () => {
    const w = wiring([], '1080p');
    expect(w.script).toContain('concat=n=3:v=1:a=1[catv][outa];\n[catv]scale=1920:1080:flags=lanczos[outv]');
  });
});

describe('I-4: 転換配線の純関数（overlaps 非空 / scale あり / 総フレーム一致）', () => {
  it('カット有り・転換有り・1080p の1ケースで3点を同時に pin', () => {
    const w = wiring([{ id: 1, at: 200, kind: 'crossfade', durationFrames: 16 }], '1080p');
    expect(w.overlaps.length).toBeGreaterThan(0);
    expect(w.script).toContain('scale=');
    // expectTotalFrames は buildCutFilterScript の中で検算される（不一致なら throw）。
    expect(w.totalFrames).toBe(w.timeline.totalFrames);
    expect(w.segments).toEqual([
      { start: 0, end: 50 },
      { start: 150, end: 200 },
      { start: 220, end: 300 },
    ]);
  });
});

describe('設計判断5: 合成順は 画像 → 図形 → 色レイヤ → 撮影 PNG', () => {
  const image: OverlayLayer = { kind: 'sequence', startFrame: 0, endFrame: 10 };
  const shape: OverlayLayer = { kind: 'static', startFrame: 0, endFrame: 10, durationFrames: 10 };
  const telop: OverlayLayer = { kind: 'sequence', startFrame: 0, endFrame: 10 };
  const fades = [{ color: '#000000' as const, at: 5, durationFrames: 4 }];
  const base = '[v0]concat=n=1:v=1:a=0[outv]\n';

  const composed = (opts: { telop: boolean; fades: boolean }): string =>
    composeOverlayChains({
      script: base,
      fps: FPS,
      imageLayers: [image],
      shapeLayers: [shape],
      telopTitleLayers: opts.telop ? [telop] : [],
      sceneFades: opts.fades ? fades : [],
      imagesBase: 1,
      telopTitleBase: 3,
      size: { width: 8, height: 8 },
      totalFrames: 20,
    });

  it('色レイヤは図形鎖の後・撮影 PNG 鎖の前に入る', () => {
    const out = composed({ telop: true, fades: true });
    const imageAt = out.indexOf('[1:v]');
    const shapeAt = out.indexOf('[2:v]');
    const colorAt = out.indexOf('color=c=0x000000');
    const telopAt = out.indexOf('[3:v]');
    expect(imageAt).toBeGreaterThanOrEqual(0);
    expect(shapeAt).toBeGreaterThan(imageAt);
    expect(colorAt).toBeGreaterThan(shapeAt);
    expect(telopAt).toBeGreaterThan(colorAt);
  });

  it('撮影 PNG 無し／有りのどちらでも [outv] は1個', () => {
    for (const telop of [false, true]) {
      for (const fades of [false, true]) {
        const out = composed({ telop, fades });
        expect(out.match(/\[outv\]/g), `telop=${telop} fades=${fades}`).toHaveLength(1);
      }
    }
  });

  it('色レイヤが無ければ従来どおり1回で積む（ラベルは接頭辞なし＝出力1文字不変）', () => {
    const out = composed({ telop: true, fades: false });
    expect(out).not.toContain('ttshp');
    expect(out).toContain('[shp2]');
  });

  /**
   * I-1: 合成結果の **filter 出力ラベルが一意**であることを pin する。
   *
   * 2回目の overlay 鎖に接頭辞（`tt`）を与えているのは、1回目の鎖と同じ既定ラベル
   * （`shbase`/`shp{i}`/`ov{i}`）が衝突して filter graph が壊れるため。z 順の pin
   * （どの入力が先に現れるか）は接頭辞を落としても緑のままなので、**ラベルの一意性そのもの**を
   * 別の軸として持つ。接頭辞を落とす変異でこの軸が赤になることを同じテストで示す。
   */
  it('出力ラベルは一意（接頭辞 tt を落とす変異で赤になる）', () => {
    for (const telop of [false, true]) {
      for (const fades of [false, true]) {
        const out = composed({ telop, fades });
        const labels = filterOutputLabels(out);
        expect(new Set(labels).size, `telop=${telop} fades=${fades}`).toBe(labels.length);
        expect(() => assertUniqueFilterOutputLabels(out)).not.toThrow();
      }
    }
    // 変異: 2回目の鎖の接頭辞を落とす（`[ttshbase]` → `[shbase]` …）。
    const mutated = composed({ telop: true, fades: true }).replace(/\[tt/g, '[');
    expect(() => assertUniqueFilterOutputLabels(mutated)).toThrow(/出力ラベル/);
    const mutatedLabels = filterOutputLabels(mutated);
    expect(new Set(mutatedLabels).size).toBeLessThan(mutatedLabels.length);
  });
});

/**
 * M4 T2: サブ動画（videoInserts）の合成位置は **画像の後・図形の前**（正典⑦）。
 * z 順は 主映像 → 画像 → サブ動画 → 図形 → 色レイヤ → タイトル → テロップ。
 */
describe('M4 正典⑦: サブ動画は画像の後・図形の前', () => {
  const image: OverlayLayer = { kind: 'sequence', startFrame: 0, endFrame: 10 };
  const video: OverlayLayer = {
    kind: 'video',
    startFrame: 0,
    endFrame: 10,
    sourceInFrame: 0,
    playbackRate: 1,
    placement: { width: 8, height: 8, x: 0, y: 0 },
  };
  const shape: OverlayLayer = { kind: 'static', startFrame: 0, endFrame: 20, durationFrames: 20 };
  const telop: OverlayLayer = { kind: 'sequence', startFrame: 0, endFrame: 10 };
  const fades = [{ color: '#000000' as const, at: 5, durationFrames: 4 }];

  const base = '[v0]concat=n=1:v=1:a=0[outv]\n';
  const composed = (opts: { video: boolean; fades: boolean }): string =>
    composeOverlayChains({
      script: base,
      fps: FPS,
      imageLayers: [image],
      videoLayers: opts.video ? [video] : [],
      shapeLayers: [shape],
      telopTitleLayers: [telop],
      sceneFades: opts.fades ? fades : [],
      imagesBase: 1,
      videosBase: 2,
      telopTitleBase: opts.video ? 4 : 3,
      size: { width: 8, height: 8 },
      totalFrames: 20,
    });

  it('色レイヤ無し: 入力 index は 画像[1:v] → サブ動画[2:v] → 図形[3:v] → 撮影PNG[4:v] の順で現れる', () => {
    const out = composed({ video: true, fades: false });
    const imageAt = out.indexOf('[1:v]format=rgba,settb');
    const videoAt = out.indexOf('[2:v]tpad=');
    const shapeAt = out.indexOf('[3:v]format=rgba,fade=');
    const telopAt = out.indexOf('[4:v]format=rgba,settb');
    expect(imageAt).toBeGreaterThanOrEqual(0);
    expect(videoAt).toBeGreaterThan(imageAt);
    expect(shapeAt).toBeGreaterThan(videoAt);
    expect(telopAt).toBeGreaterThan(shapeAt);
  });

  it('色レイヤ有り: サブ動画は色レイヤより前（正典⑦ の「色レイヤは図形の後」も維持）', () => {
    const out = composed({ video: true, fades: true });
    const videoAt = out.indexOf('[2:v]tpad=');
    const shapeAt = out.indexOf('[3:v]format=rgba,fade=');
    const colorAt = out.indexOf('color=c=0x000000');
    expect(videoAt).toBeGreaterThanOrEqual(0);
    expect(shapeAt).toBeGreaterThan(videoAt);
    expect(colorAt).toBeGreaterThan(shapeAt);
    expect(out.match(/\[outv\]/g)).toHaveLength(1);
  });

  it('受入 E: videoLayers が空なら、フィールドを渡さない従来呼び出しと1文字も変わらない', () => {
    const legacy = composeOverlayChains({
      script: base,
      fps: FPS,
      imageLayers: [image],
      shapeLayers: [shape],
      telopTitleLayers: [telop],
      sceneFades: fades,
      imagesBase: 1,
      telopTitleBase: 3,
      size: { width: 8, height: 8 },
      totalFrames: 20,
    });
    expect(composed({ video: false, fades: true })).toBe(legacy);
    expect(legacy).not.toContain('tpad=');
  });

  it('出力ラベルは一意（サブ動画を挟んでも 2回目の鎖の接頭辞分離が効いている）', () => {
    for (const fades of [false, true]) {
      const out = composed({ video: true, fades });
      const labels = filterOutputLabels(out);
      expect(new Set(labels).size, `fades=${fades}`).toBe(labels.length);
      expect(() => assertUniqueFilterOutputLabels(out)).not.toThrow();
    }
  });

  /**
   * **I-4（中間レビュー）: `videosBase` の検算を必須にする。**
   *
   * 旧実装の検算は `input.videosBase !== undefined` を条件にしていたため、
   * **省略すれば黙って素通り**した——「検算を `if (false)` にする」変異が 1 件も赤にならず
   * 生存する（＝検算が無試験だった）。入力 index の割当が食い違うと
   * **別の入力の絵を合成した動画が静かに出る**ので、省略自体を許さない。
   */
  const composeWith = (over: Partial<Parameters<typeof composeOverlayChains>[0]>): string =>
    composeOverlayChains({
      script: base,
      fps: FPS,
      imageLayers: [image],
      videoLayers: [video],
      shapeLayers: [shape],
      telopTitleLayers: [telop],
      sceneFades: [],
      imagesBase: 1,
      videosBase: 2,
      telopTitleBase: 4,
      size: { width: 8, height: 8 },
      totalFrames: 20,
      ...over,
    });

  it('I-4: サブ動画があるのに videosBase が未指定なら throw（省略を許さない）', () => {
    expect(() => composeWith({ videosBase: undefined })).toThrow(/videosBase/);
  });

  it('I-4 陽性対照: 正しい videosBase（画像群の直後）なら throw しない／誤った値なら throw', () => {
    // 画像 1 件・imagesBase=1 → videosBase は 2 が正。
    expect(() => composeWith({ videosBase: 2 })).not.toThrow();
    expect(() => composeWith({ videosBase: 3 })).toThrow(/videosBase\(3\)/);
    expect(() => composeWith({ videosBase: 1 })).toThrow(/videosBase\(1\)/);
  });

  it('I-4: サブ動画が 0 件なら videosBase は不要（従来呼び出しは throw しない）', () => {
    expect(() => composeWith({ videoLayers: [], videosBase: undefined, telopTitleBase: 3 })).not.toThrow();
  });

  /**
   * **M-4: `telopTitleBase` も検算する。**
   *
   * `videosBase` の fail-loud（I-4）は「画像群の直後」しか見ないが、`computeOverlayInputIndexBase`
   * に `videosCount` を渡し忘れたときに**実際にずれるのは後ろの群**（撮影 PNG）——`videosBase` は
   * 画像群の直後のままなので I-4 は素通りし、撮影 PNG の入力 index だけがサブ動画の本数ぶん
   * 手前を指す＝**別の入力の絵がテロップとして乗る**。4 群の並び
   * `imagesBase → 画像 → サブ動画 → 図形 → 撮影PNG` を最後まで検算する。
   */
  it('M-4: telopTitleBase が 4 群の並びと食い違えば throw（videosCount 渡し忘れの変異）', () => {
    // 画像1・サブ動画1・図形1・imagesBase=1 → telopTitleBase は 4 が正。
    expect(() => composeWith({ telopTitleBase: 4 })).not.toThrow();
    // videosCount を渡し忘れた形（サブ動画 1 本ぶん手前を指す）。
    expect(() => composeWith({ telopTitleBase: 3 })).toThrow(/telopTitleBase\(3\)/);
    expect(() => composeWith({ telopTitleBase: 5 })).toThrow(/telopTitleBase\(5\)/);
  });

  it('M-4: サブ動画が 0 件のときも telopTitleBase を検算する（既存経路の陰性対照）', () => {
    expect(() => composeWith({ videoLayers: [], videosBase: undefined, telopTitleBase: 3 })).not.toThrow();
    expect(() => composeWith({ videoLayers: [], videosBase: undefined, telopTitleBase: 4 })).toThrow(
      /telopTitleBase\(4\)/,
    );
  });
});
