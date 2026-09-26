/**
 * 共有式そのものの単体。parity（写し 3 者の一致）と source（1 バイト一致）は
 * 「3 者が同じ」ことしか言わないので、**値が式から導けるか**をここで別に固定する。
 * 期待値はすべて `Telop.tsx:474-521` の算式から手で導いた数（実行結果の転記ではない）。
 */
import { describe, expect, it } from 'vitest';
import { interpolate } from '../captureRuntime/interpolate';
import { spring } from '../captureRuntime/spring';
import {
  LEGACY_TELOP_ANIMATION_CONFIG, LEGACY_TELOP_ENTRY_OPACITY_FLOOR,
  PACK_LEGACY_TELOP_ANIMATION_IDS, legacyTelopAnimationFrame,
  packLegacyTelopAnimationFrame, resolveLegacyTelopAnimation,
} from './telopLegacyAnimation';

const deps = (fps = 30) => ({ fps, interpolate, spring });
const bare = (id: 'slideIn' | 'fadeOnly' | 'none' | 'charByChar' | 'fadeFromRight',
  localFrame: number, durationFrames = 120, fps = 30) =>
  legacyTelopAnimationFrame(LEGACY_TELOP_ANIMATION_CONFIG[id], { localFrame, durationFrames }, deps(fps));

describe('opacity は fadeIn/fadeOut の折れ線', () => {
  it('slideIn / dur=120: fadeIn = min(8, 40) = 8 なので 1 フレーム目は 1/8', () => {
    expect(bare('slideIn', 1).opacity).toBe(0.125);
    expect(bare('slideIn', 4).opacity).toBe(0.5);
    expect(bare('slideIn', 8).opacity).toBe(1);
    expect(bare('slideIn', 60).opacity).toBe(1);
  });

  it('slideIn / dur=120: 退場は duration-8 = 112 から 120 で 1 → 0', () => {
    expect(bare('slideIn', 112).opacity).toBe(1);
    expect(bare('slideIn', 116).opacity).toBe(0.5);
    expect(bare('slideIn', 120).opacity).toBe(0);
  });

  it('区間外は clamp（下は 0、上は 0。extrapolate を extend にしていない）', () => {
    expect(bare('slideIn', -5).opacity).toBe(0);
    expect(bare('slideIn', 200).opacity).toBe(0);
  });

  it('短尺は duration/3 で潰れる: dur=7 なら fadeIn = min(8, 7/3) = 2.333…', () => {
    // 折れ点は max(1, 7/3) = 2.333…。1 フレーム目は 1 / 2.333… = 0.428571…
    expect(bare('slideIn', 1, 7).opacity).toBeCloseTo(3 / 7, 12);
    expect(bare('slideIn', 7 / 3, 7).opacity).toBeCloseTo(1, 12);
  });

  it('none は fadeIn も fadeOut も 0 ＝ hasAnimation が false なので常に不透明', () => {
    for (const frame of [-2, 0, 60, 120, 200]) expect(bare('none', frame).opacity).toBe(1);
  });

  it('charByChar は fadeIn 0 だが fadeOut 8 ＝ hasAnimation は true（片側だけでも折れ線が効く）', () => {
    // 折れ点は max(1, min(0, 40)) = 1。0 フレーム目は 0、1 フレーム目で 1 に達する。
    expect(bare('charByChar', 0).opacity).toBe(0);
    expect(bare('charByChar', 1).opacity).toBe(1);
    expect(bare('charByChar', 120).opacity).toBe(0);
  });
});

describe('translate は slideInDistance と向きから決まる', () => {
  it('slideInDistance が 0 の種（fadeOnly / none）は両軸 0', () => {
    for (const frame of [0, 3, 60]) {
      expect(bare('fadeOnly', frame)).toMatchObject({ translateX: 0, translateY: 0 });
      expect(bare('none', frame)).toMatchObject({ translateX: 0, translateY: 0 });
    }
  });

  it('frame 0 は spring が 0 ＝ 距離いっぱい、向きで符号が決まる', () => {
    // up は +、down は -、left は -、right は + （`Telop.tsx:504-518` の switch）
    expect(bare('slideIn', 0)).toMatchObject({ translateX: 0, translateY: 30 });          // up / 30
    expect(bare('charByChar', 0)).toMatchObject({ translateX: 0, translateY: -25 });      // down / 25
    expect(bare('fadeFromRight', 0)).toMatchObject({ translateX: 40, translateY: 0 });    // right / 40
    expect(legacyTelopAnimationFrame(LEGACY_TELOP_ANIMATION_CONFIG.slideFromLeft,
      { localFrame: 0, durationFrames: 120 }, deps())).toMatchObject({ translateX: -50, translateY: 0 }); // left / 50
  });

  it('時間とともに 0 へ寄る（spring が効いている）', () => {
    expect(Math.abs(bare('slideIn', 20).translateY)).toBeLessThan(Math.abs(bare('slideIn', 3).translateY));
  });

  it('fps を変えると spring の出力が変わる（fps が本当に使われている）', () => {
    expect(bare('slideIn', 5, 120, 59.94).translateY).not.toBe(bare('slideIn', 5, 120, 30).translateY);
  });
});

describe('パック入口の床と no-op 集合', () => {
  it('入場窓だけ 0.5 で下支えし、退場側には張らない（非対称）', () => {
    const enter = packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 1, durationFrames: 120 }, deps());
    expect(enter!.opacity).toBe(LEGACY_TELOP_ENTRY_OPACITY_FLOOR);            // max(0.125, 0.5)
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 8, durationFrames: 120 }, deps())!.opacity).toBe(1);
    // entryFrames = 8 < 116 なので退場側は素通し（床が掛かれば 0.5 になってしまう）
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 116, durationFrames: 120 }, deps())!.opacity).toBe(0.5);
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 118, durationFrames: 120 }, deps())!.opacity).toBe(0.25);
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 120, durationFrames: 120 }, deps())!.opacity).toBe(0);
  });

  it('床は translate に触らない（素の式と同じ値を返す）', () => {
    const input = { localFrame: 1, durationFrames: 120 };
    const packed = packLegacyTelopAnimationFrame({ animation: 'slideIn', ...input }, deps())!;
    const raw = bare('slideIn', 1);
    expect(packed.translateX).toBe(raw.translateX);
    expect(packed.translateY).toBe(raw.translateY);
    expect(packed.opacity).not.toBe(raw.opacity);   // opacity だけが違う
  });

  it('7 種以外は null（現行の描画を 1 バイトも変えない）', () => {
    for (const animation of ['none', 'charByChar', undefined, 'popIn', 'blurOutFocus', 'なにか'])
      expect(packLegacyTelopAnimationFrame({ animation, localFrame: 5, durationFrames: 120 }, deps()), String(animation)).toBeNull();
    for (const id of PACK_LEGACY_TELOP_ANIMATION_IDS)
      expect(packLegacyTelopAnimationFrame({ animation: id, localFrame: 5, durationFrames: 120 }, deps()), id).not.toBeNull();
  });

  it('区間外は null（空箱を増やさない）', () => {
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: -1, durationFrames: 120 }, deps())).toBeNull();
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 121, durationFrames: 120 }, deps())).toBeNull();
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 0, durationFrames: 120 }, deps())).not.toBeNull();
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 120, durationFrames: 120 }, deps())).not.toBeNull();
  });

  it('短尺でも床は入場窓の実長に追随する（entryFrames = max(1, min(fadeIn, dur/3))）', () => {
    // dur=7 / slideIn: fadeIn = fadeOut = min(8, 7/3) = 2.333…、折れ点は [0, 2.333…, 4.666…, 7]。
    // 入場側 frame 1 は 1 / 2.333… = 3/7 ≈ 0.4286 で床を下回る → 0.5 へ押し上げられる。
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 1, durationFrames: 7 }, deps())!.opacity)
      .toBe(LEGACY_TELOP_ENTRY_OPACITY_FLOOR);
    // 退場側 frame 6 は (7-6) / 2.333… = 3/7 で**同じ値**だが、6 > entryFrames 2.333… なので床は掛からない。
    // 入場と退場で同値なのに結果が割れる＝窓が尺相対に効いていることの直接証拠。
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 6, durationFrames: 7 }, deps())!.opacity)
      .toBeCloseTo(3 / 7, 12);
    // 入場窓の内側でも、素の値が床を超えていれば素通し（床は max であって代入ではない）。
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 2, durationFrames: 7 }, deps())!.opacity)
      .toBeCloseTo(6 / 7, 12);
  });
});

describe('種の判別', () => {
  it('既存 9 種は非 null、新 8 種・未指定・未知は null', () => {
    for (const id of Object.keys(LEGACY_TELOP_ANIMATION_CONFIG))
      expect(resolveLegacyTelopAnimation(id), id).toBe(id);
    for (const id of ['popIn', 'wipeReveal', 'typeCursor', 'underlineGrow', 'bandLeadsText',
      'jumpPop', 'stampPress', 'blurOutFocus', undefined, '', 'なにか'])
      expect(resolveLegacyTelopAnimation(id), String(id)).toBeNull();
  });

  it('fadeOnly は segmentId を渡したときだけ id%6 でばらける（裁定 1）', () => {
    expect(resolveLegacyTelopAnimation('fadeOnly')).toBe('fadeOnly');
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(id => resolveLegacyTelopAnimation('fadeOnly', id)))
      .toEqual(['fadeOnly', 'fadeFromLeft', 'fadeOnly', 'slideFromLeft', 'fadeOnly', 'slideLeftFadeBlur',
        'fadeOnly', 'fadeFromLeft']);   // 6 で 1 周する
    // ばらけ先に「右からの動き」は入らない（`getVariedAnimation` のコメントどおり）
    expect([0, 1, 2, 3, 4, 5].map(id => resolveLegacyTelopAnimation('fadeOnly', id))).not.toContain('fadeFromRight');
  });

  it('segmentId は fadeOnly 以外には効かない', () => {
    for (const id of [0, 1, 3, 5]) expect(resolveLegacyTelopAnimation('slideIn', id)).toBe('slideIn');
  });
});

describe('設定表', () => {
  it('9 件ちょうど。charDelay を持つのは charByChar だけ', () => {
    const ids = Object.keys(LEGACY_TELOP_ANIMATION_CONFIG);
    expect(ids).toHaveLength(9);
    expect(ids.filter(id => LEGACY_TELOP_ANIMATION_CONFIG[id as 'none'].charDelay !== undefined)).toEqual(['charByChar']);
    expect(LEGACY_TELOP_ANIMATION_CONFIG.charByChar.charDelay).toBe(2);
  });

  it('パックが当てるのは 7 種（none と charByChar を除いた既存種）', () => {
    expect([...PACK_LEGACY_TELOP_ANIMATION_IDS].sort())
      .toEqual(Object.keys(LEGACY_TELOP_ANIMATION_CONFIG).filter(id => id !== 'none' && id !== 'charByChar').sort());
  });
});

describe('尺 3 未満は wrapper が no-op（Codex P1）', () => {
  // 尺 1〜2 の字幕では `[0, max(1, fadeIn), duration - max(1, fadeOut), duration]` が
  // `[0,1,0,1]`／`[0,1,1,2]` になり、`interpolate` が
  // `inputRange must be strictly monotonically increasing` を投げる。
  // 旧パックは wrapper が式を呼ばなかったので到達しなかった入力域。
  const ends = (duration: number): number[] => [0, duration];   // 端フレーム（区間内の両端）

  it.each([...PACK_LEGACY_TELOP_ANIMATION_IDS])('尺 1・2・3 × 端フレームで例外を投げない: %s', animation => {
    for (const durationFrames of [1, 2, 3])
      for (const localFrame of ends(durationFrames))
        expect(() => packLegacyTelopAnimationFrame({ animation, localFrame, durationFrames }, deps()),
          `${animation} dur=${durationFrames} lf=${localFrame}`).not.toThrow();
  });

  it.each([...PACK_LEGACY_TELOP_ANIMATION_IDS])('尺 1・2 は null（描画を 1 バイトも変えない）: %s', animation => {
    for (const durationFrames of [1, 2])
      for (const localFrame of ends(durationFrames))
        expect(packLegacyTelopAnimationFrame({ animation, localFrame, durationFrames }, deps()),
          `${animation} dur=${durationFrames} lf=${localFrame}`).toBeNull();
  });

  it.each([...PACK_LEGACY_TELOP_ANIMATION_IDS])('尺 3 は非 null（ガードが必要以上に広くない）: %s', animation => {
    for (const localFrame of ends(3))
      expect(packLegacyTelopAnimationFrame({ animation, localFrame, durationFrames: 3 }, deps()),
        `${animation} lf=${localFrame}`).not.toBeNull();
  });

  it('尺 3 の端は素の式どおり（no-op 化が尺 3 まで食い込んでいない）', () => {
    // dur=3 → fadeIn = fadeOut = min(8, 1) = 1 → inputRange [0, 1, 2, 3]。
    // lf=0 は素の 0 だが入場窓 max(1, 1) = 1 の内側なので床 0.5、lf=3 は退場終端で 0。
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 0, durationFrames: 3 }, deps())!.opacity)
      .toBe(LEGACY_TELOP_ENTRY_OPACITY_FLOOR);
    expect(packLegacyTelopAnimationFrame({ animation: 'slideIn', localFrame: 3, durationFrames: 3 }, deps())!.opacity)
      .toBe(0);
  });

  it('本体（`legacyTelopAnimationFrame`）は触っていない＝同じ入力で今も例外（案件テンプレートの旧挙動）', () => {
    // ガードはパック入口だけが持つ（床の非対称と同じ理由）。本体を変えると 864 ケースの一致が壊れる。
    expect(() => legacyTelopAnimationFrame(LEGACY_TELOP_ANIMATION_CONFIG.slideIn,
      { localFrame: 0, durationFrames: 1 }, deps())).toThrow(/monotonically increasing/);
  });
});
