import { describe, it, expect } from 'vitest';
import {
  telopBottomFrac,
  telopVCoeff,
  telopScaleOriginY,
  telopTransform,
  telopMaxWidthFrac,
  clampTelopX,
} from './telopLayout';
import { titleToTelop } from '../app/edit/editState';

describe('telopBottomFrac / telopVCoeff（フォーマット別）', () => {
  it('short(縦) は bottomFrac=200/1920, vCoeff=1-2*それ', () => {
    expect(telopBottomFrac(1080, 1920)).toBeCloseTo(200 / 1920, 9);
    expect(telopVCoeff(1080, 1920)).toBeCloseTo(1 - 2 * (200 / 1920), 9);
  });
  it('youtube(横) は bottomFrac=100/1080', () => {
    expect(telopBottomFrac(1920, 1080)).toBeCloseTo(100 / 1080, 9);
  });
  it('square は bottomFrac=140/1080', () => {
    expect(telopBottomFrac(1080, 1080)).toBeCloseTo(140 / 1080, 9);
  });
});

describe('telopScaleOriginY（下端基準の拡縮原点）', () => {
  it('short は (1 - bottomFrac)*100 ≒ 89.58%', () => {
    expect(telopScaleOriginY(1080, 1920)).toBeCloseTo((1 - 200 / 1920) * 100, 9);
  });
});

describe('telopTransform（position/scale → CSS transform）', () => {
  it('position も scale も無ければ undefined', () => {
    expect(telopTransform(undefined, undefined, 1080, 1920)).toBeUndefined();
  });
  it('scale が 1 だけなら undefined（no-op）', () => {
    expect(telopTransform(undefined, 1, 1080, 1920)).toBeUndefined();
  });
  it('y は縦係数で換算する', () => {
    const vy = -1 * telopVCoeff(1080, 1920) * 100;
    // x=1 は 2026-09-06 #2 の描画時クランプ対象（下の describe で検証）なので
    // ここでは y の換算だけを x=0（クランプの影響を受けない）で見る。
    expect(telopTransform({ x: 0, y: -1 }, undefined, 1080, 1920)).toBe(`translate(0%, ${vy}%)`);
  });
  it('position と scale を併用', () => {
    expect(telopTransform({ x: 0, y: 0 }, 1.5, 1080, 1920)).toBe('translate(0%, 0%) scale(1.5)');
  });
  it('x=1 は描画時クランプで frame 内に収まる値へ丸められる（旧: 素の 50% だった＝不具合）', () => {
    const transform = telopTransform({ x: 1, y: 0 }, undefined, 1080, 1920);
    const m = /^translate\(([-\d.]+)%, 0%\)$/.exec(transform ?? '');
    expect(m).not.toBeNull();
    const xPercent = parseFloat(m![1] ?? '');
    expect(xPercent).toBeLessThan(50); // 素の x*50 のままではない（クランプされている）
    expect(xPercent).toBeGreaterThan(0); // 0 へ倒れ切ってもいない（帯がフレームより広い想定ではない）
  });
});

/**
 * telopTransform の描画時クランプ（安全網・2026-09-06 #2）。
 *
 * 前ラウンドのレビュー差し戻し: position.x がどう作られたか（既存プロジェクトの保存済み値・
 * ドラッグのフォールバック枠・API/JSON 直書き）に関わらず、telopTransform 自身が
 * 「その帯がありうる最大幅」で x をクランプしていなかったため、position ±1 は
 * 依然として無条件で画面外へ出ていた（telopTransform の式自体は前回diffで無変更）。
 *
 * この安全網は「実際の帯幅」までは知らないので、TELOP_CONFIG.maxWidth の標準値
 * （telopMaxWidthFrac）× scale を「ありうる最大」とみなして保守的にクランプする。
 * 実際の帯がこれより狭ければ、その分だけ余裕を残して丸める（＝はみ出しには倒れない）。
 */
describe('telopTransform の描画時クランプ（安全網・2026-09-06 #2）', () => {
  /** telopTransform の translate(x%, ...) から x（0.5 が position.x=1 相当）を取り出す。 */
  function xFracOf(transform: string | undefined): number {
    const m = /^translate\(([-\d.]+)%/.exec(transform ?? '');
    return m ? parseFloat(m[1] ?? '') / 100 : 0;
  }
  /** xFrac（= position.x * 0.5）・コンテナ幅・帯幅から左右端を求める。 */
  function edgesFor(xFrac: number, containerW: number, elemW: number): { left: number; right: number } {
    const shift = xFrac * containerW;
    const left = (containerW - elemW) / 2 + shift;
    return { left, right: left + elemW };
  }

  const FORMATS = [
    { label: 'youtube(横)', compW: 1920, compH: 1080 },
    { label: 'short(縦)', compW: 1080, compH: 1920 },
    { label: 'square(正方形)', compW: 1080, compH: 1080 },
  ] as const;

  for (const { label, compW, compH } of FORMATS) {
    for (const x of [-1, 0, 1]) {
      it(`${label}: position.x=${x}・scale未指定 は「ありうる最大の帯幅」でも画面内に収まる`, () => {
        const transform = telopTransform({ x, y: 0 }, undefined, compW, compH);
        const worstElemW = compW * telopMaxWidthFrac(compW, compH);
        const { left, right } = edgesFor(xFracOf(transform), compW, worstElemW);
        expect(left).toBeGreaterThanOrEqual(-1e-9);
        expect(right).toBeLessThanOrEqual(compW + 1e-9);
      });
    }
  }

  it('回帰の再現: クランプ前の生の x*50%（telopTransform 導入前の式）は同条件で画面外へ出る', () => {
    // telopTransform を経由せず、修正前と同じ「生の x*50%」を再現して比較対象にする。
    const compW = 1920;
    const worstElemW = compW * telopMaxWidthFrac(compW, 1080); // youtube
    const rawXFrac = -1 * 0.5; // position.x = -1 の生の shift 比率
    const { left } = edgesFor(rawXFrac, compW, worstElemW);
    expect(left).toBeLessThan(0);
  });

  it('scale が小さいほど「ありうる最大の帯幅」も小さくなり、クランプが緩む', () => {
    const compW = 1920, compH = 1080;
    const transformFull = telopTransform({ x: -1, y: 0 }, 1, compW, compH);
    const transformScaled = telopTransform({ x: -1, y: 0 }, 0.3, compW, compH);
    const xFull = Math.abs(xFracOf(transformFull));
    const xScaled = Math.abs(xFracOf(transformScaled));
    expect(xScaled).toBeGreaterThan(xFull); // 縮小時は元の x=-1 により近づける（安全マージンを削り過ぎない）
  });
});

/**
 * 変換済みタイトルが画面外へはみ出さないことの回帰検査（2026-09-04 の不具合）。
 *
 * transform は AbsoluteFill（フレーム全面）へ掛かるため `translate(x%)` の 100% は
 * 「フレーム幅」であって要素幅ではない。テロップ本体はその中で中央寄せされるので、
 * x=-1 は「中央寄せされた文字の中心を左端へ動かす」＝左半分が画面外になる。
 * 幅が分からない以上、どんな文字列でも必ず収まる x は 0 だけである。
 */
describe('タイトル変換位置の画面内保証', () => {
  /** position を与えたときのテロップ本体の左右端（px）。elemW はテロップ本体の幅。 */
  function telopEdges(x: number, compW: number, elemW: number): { left: number; right: number } {
    // AbsoluteFill が compW * x * 0.5 だけ動き、その中で elemW が中央寄せされる。
    const shift = x * 0.5 * compW;
    const left = (compW - elemW) / 2 + shift;
    return { left, right: left + elemW };
  }

  it('x=-1 は本体を画面外へ出す（不具合の再現）', () => {
    const { left } = telopEdges(-1, 1920, 800);
    expect(left).toBeLessThan(0);
  });

  it('変換済みタイトルの x は、本体がフレーム全幅でも収まる値である', () => {
    const x = titleToTelop(
      { id: 1, originalStart: 0, originalEnd: 30, text: '章タイトル' },
      1,
    ).position?.x;
    expect(x).toBeDefined();
    // 最悪ケース（本体がフレーム全幅）でも両端が枠内に収まること。
    for (const elemW of [200, 800, 1920]) {
      const { left, right } = telopEdges(x as number, 1920, elemW);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(1920);
    }
  });
});

/**
 * 変換済みタイトルが縦方向にもフレーム内へ収まることの回帰検査（2026-09-05 の実測）。
 *
 * テロップは下端固定で描かれ、y=-1 は「テロップの**下端**を上下対称の余白位置へ動かす」。
 * 帯の高さが余白（bottomOffset）より大きいと、下端が合っても上が画面外へ出る。
 * C0123（1920x1080・TELOP_CONFIG.fontSize=136・titleFontSize=42）の実測値:
 *   縮小なし → 帯 高さ170px・top -71px・bottom 99px（上へ 71px はみ出す）
 * 元のタイトル帯と同じ大きさ（42/136）へ縮めれば、同じ y=-1 のまま収まる。
 */
describe('タイトル変換の縦方向の画面内保証（実測 fixture）', () => {
  const COMP_H = 1080;
  /**
   * 帯の下端（フレーム座標・**実測**）。公称の bottomOffset は 100 なので 980 になるはずだが、
   * ブラウザで測った箱の下端は 979（y=-1 の平行移動 880px を戻すと 99+880=979）。
   * 1px の差は DOM の箱と実際に塗られる帯の縁の差。モデルは実測に合わせる
   * （公称値でモデルを組むと 1px ずれて、何を測っているのか分からなくなる）。
   */
  const ANCHOR_BOTTOM = 979;
  const UNSCALED_HEIGHT = 170;    // 実測: fontSize 136 の帯の高さ
  const TELOP_FONT = 136;         // 実測: プロジェクトが描くテロップのフォント
  const TITLE_FONT = 42;          // TELOP_CONFIG.titleFontSize

  /**
   * y と scale を与えたときの帯の上端・下端（フレーム座標）。
   * 拡縮は下端基準（transformOrigin = telopScaleOriginY）なので、下端は動かず上端だけ縮む。
   * そのあと y による平行移動が乗る。
   */
  function bandEdges(y: number, scale: number): { top: number; bottom: number } {
    const anchorBottom = ANCHOR_BOTTOM;                       // 縮小の基準＝帯の下端（実測）
    const scaledTop = anchorBottom - UNSCALED_HEIGHT * scale;
    const shift = y * telopVCoeff(1920, COMP_H) * COMP_H;     // y=-1 で上へ
    return { top: scaledTop + shift, bottom: anchorBottom + shift };
  }

  it('縮小しないと上端からはみ出す（不具合の再現）', () => {
    const { top, bottom } = bandEdges(-1, 1);
    expect(Math.round(top)).toBe(-71);
    expect(Math.round(bottom)).toBe(99);
    expect(top).toBeLessThan(0);
  });

  it('元のタイトル帯と同じ比率へ縮めればフレーム内に収まる', () => {
    const scale = TITLE_FONT / TELOP_FONT;
    const { top, bottom } = bandEdges(-1, scale);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(COMP_H);
  });

  it('titleToTelop はその縮小率を scale として持たせる', () => {
    const t = titleToTelop(
      { id: 1, originalStart: 0, originalEnd: 30, text: '挫折した人向け？' },
      1,
      { titleFontSize: TITLE_FONT, telopFontSize: TELOP_FONT },
    );
    expect(t.scale).toBeCloseTo(TITLE_FONT / TELOP_FONT, 6);
    const { top, bottom } = bandEdges(t.position!.y, t.scale as number);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(COMP_H);
  });

  it('フォントサイズが読めないときは縮小しない（従来どおり・後方互換）', () => {
    const t = titleToTelop({ id: 1, originalStart: 0, originalEnd: 30, text: 'x' }, 1);
    expect(t.scale).toBeUndefined();
  });
});

/**
 * 左上寄せ（2026-09-05・たきコーチ指示）。
 *
 * position.x は帯の**中心**を動かす（translate は AbsoluteFill=フレーム全面に掛かる）ため、
 * 左端を titleLeft に揃えるには帯の幅が要る。幅は文字ごとに違い（CJK ≒1.0em / ASCII ≒0.55em）
 * 文字数からの概算では最大 18px ばらつくので、ブラウザの実測幅を使う。
 * 測れない環境（Node・フォント未読込）では中央（x=0）へ倒す＝はみ出さない側に倒す。
 */
describe('タイトル変換の左上寄せ', () => {
  const COMP_W = 1920;
  const TELOP_FONT = 136;
  const TITLE_FONT = 42;
  const TITLE_LEFT = 60;
  const BAND_PADDING_X = 24; // GoldGradBg の padding: "0 24px"

  /** x を与えたときの帯の左右端（フレーム座標）。 */
  function bandX(x: number, textWidth: number): { left: number; right: number } {
    const scale = TITLE_FONT / TELOP_FONT;
    const w = (textWidth + BAND_PADDING_X * 2) * scale;
    const left = (COMP_W - w) / 2 + x * (COMP_W / 2);
    return { left, right: left + w };
  }

  const ctx = (measured: number | null) => ({
    titleFontSize: TITLE_FONT,
    telopFontSize: TELOP_FONT,
    titleLeft: TITLE_LEFT,
    compWidth: COMP_W,
    measureTextWidth: () => measured,
  });

  it('実測幅があれば帯の左端が titleLeft に載る（実測値 1035.9 = 「挫折した人向け?」）', () => {
    const t = titleToTelop(
      { id: 1, originalStart: 0, originalEnd: 30, text: '挫折した人向け?' },
      1,
      ctx(1035.9),
    );
    const { left, right } = bandX(t.position!.x, 1035.9);
    expect(left).toBeCloseTo(TITLE_LEFT, 6);
    expect(right).toBeLessThanOrEqual(COMP_W);
  });

  it('長いタイトルでも左端は titleLeft のまま（実測値 1443.9 = 「編集を編集していない?」）', () => {
    const t = titleToTelop(
      { id: 2, originalStart: 0, originalEnd: 30, text: '編集を編集していない?' },
      2,
      ctx(1443.9),
    );
    const { left, right } = bandX(t.position!.x, 1443.9);
    expect(left).toBeCloseTo(TITLE_LEFT, 6);
    expect(right).toBeLessThanOrEqual(COMP_W);
  });

  it('帯がフレームより広ければクランプして画面外へ出さない', () => {
    const huge = 20000;
    const t = titleToTelop({ id: 3, originalStart: 0, originalEnd: 30, text: 'x' }, 3, ctx(huge));
    expect(t.position!.x).toBe(0); // 収まらないなら中央（左右の見切れを対称にする）
  });

  it('実測できなければ中央のまま（Node・フォント未読込の安全側）', () => {
    const t = titleToTelop({ id: 4, originalStart: 0, originalEnd: 30, text: 'x' }, 4, ctx(null));
    expect(t.position!.x).toBe(0);
  });

  it('titleLeft や compWidth が無ければ中央のまま', () => {
    const t = titleToTelop({ id: 5, originalStart: 0, originalEnd: 30, text: 'x' }, 5, {
      titleFontSize: TITLE_FONT,
      telopFontSize: TELOP_FONT,
      measureTextWidth: () => 500,
    });
    expect(t.position!.x).toBe(0);
  });
});

/**
 * clampTelopX（ドラッグで生成する position.x の安全域・2026-09-06 汎化）。
 *
 * B-1（2026-09-05 のタイトルの不具合）で紫化・画面外はみ出しは titleToTelop（自動変換）側は
 * 対策済みだが、**利用者が手でテロップをドラッグして x=±1 に置く一般ケース**は telopTransform
 * の式（x*50% は AbsoluteFill＝フレーム全幅基準）がそのままなので、帯が広ければ今も画面外へ
 * 出る。position.x を作る側（ドラッグ・API 双方）でこの関数を通し、実測（またはそれに準ずる）
 * 帯幅を渡して安全域へ丸める。
 */
describe('clampTelopX（帯幅を与えたときの安全な position.x）', () => {
  /** telopTransform の実式（x*0.5*containerW を AbsoluteFill へ適用・帯は中央寄せ）と同じ前提で、
   * 与えた x・帯幅から実際の左右端を求める（telopEdges の汎用版）。 */
  function edgesFor(x: number, containerW: number, elemW: number): { left: number; right: number } {
    const shift = x * 0.5 * containerW;
    const left = (containerW - elemW) / 2 + shift;
    return { left, right: left + elemW };
  }

  it('回帰: x=-1 をそのまま使うと、そこそこの幅の帯でも画面外へ出る（不具合の再現・修正前は該当箇所が無くこのテストは書けなかった）', () => {
    // 1920 幅に対し 800px（本文が短めのテロップ相当）でも、素の x=-1 では左端が大きく画面外。
    const { left } = edgesFor(-1, 1920, 800);
    expect(left).toBeLessThan(0);
  });

  it('clampTelopX を通せば、同じ帯幅で左右とも画面内に収まる', () => {
    const clamped = clampTelopX(-1, 1920, 800);
    expect(clamped).toBeGreaterThan(-1); // 実際に丸められている（素通しではない）
    const { left, right } = edgesFor(clamped, 1920, 800);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(1920);
  });

  it('x=+1・帯幅 800 でも同様に収まる（左右対称）', () => {
    const clamped = clampTelopX(1, 1920, 800);
    const { left, right } = edgesFor(clamped, 1920, 800);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(1920);
  });

  it('帯幅が狭ければ元の x に近い値まで許す（安全マージンを過剰に削らない）', () => {
    // 帯幅 100px（短い一言）なら、ほぼ端まで動かせるはず。
    const clamped = clampTelopX(1, 1920, 100);
    expect(clamped).toBeCloseTo((1920 - 100) / 1920, 6);
  });

  it('x=0 は帯幅に関わらず 0 のまま（中央は常に安全）', () => {
    expect(clampTelopX(0, 1920, 1920)).toBe(0);
    expect(clampTelopX(0, 1920, 1)).toBe(0);
  });

  it('帯がコンテナ以上に広ければ 0（中央）へ倒す', () => {
    expect(clampTelopX(1, 1920, 1920)).toBe(0);
    expect(clampTelopX(-1, 1920, 3000)).toBe(0);
  });

  it('壊れた入力（containerW<=0・NaN）は 0 を返す（安全側）', () => {
    expect(clampTelopX(1, 0, 100)).toBe(0);
    expect(clampTelopX(NaN, 1920, 100)).toBe(0);
  });
});
