import { describe, it, expect } from 'vitest';
import { resolveTelopLayout, telopTransform, telopMaxWidthFrac, clampTelopX } from './Telop';

// 同梱スタイルは fontSize/bottomOffset を props で受けるが既定が横動画向け(80/80)。
// アダプタはプロジェクトのフォーマット（解像度のアスペクト比）からハーネス形式標準の
// テロップ寸法（videoConfig.ts の TELOP_CONFIG_MAP と一致）を解決して渡す。
describe('resolveTelopLayout（フォーマット別テロップ寸法）', () => {
  it('縦(short) 1080x1920 → fontSize 56 / bottomOffset 200', () => {
    expect(resolveTelopLayout(1080, 1920)).toEqual({ fontSize: 56, bottomOffset: 200 });
  });

  it('横(youtube) 1920x1080 → fontSize 80 / bottomOffset 100', () => {
    expect(resolveTelopLayout(1920, 1080)).toEqual({ fontSize: 80, bottomOffset: 100 });
  });

  it('正方形(square) 1080x1080 → fontSize 66 / bottomOffset 140', () => {
    expect(resolveTelopLayout(1080, 1080)).toEqual({ fontSize: 66, bottomOffset: 140 });
  });
});

// position/scale を CSS transform へ。最終 remotion render でも位置/サイズが反映される。
// x は中心 50%、y はフォーマット連動の縦係数（1 - 2*bottomFrac）。short の bottomOffset=200/1920。
describe('telopTransform（position/scale → CSS transform）', () => {
  const SHORT_VCOEFF = 1 - 2 * (200 / 1920);

  it('position も scale も無ければ undefined', () => {
    expect(telopTransform(undefined, undefined, 1080, 1920)).toBeUndefined();
  });

  it('scale が 1 だけなら undefined（no-op）', () => {
    expect(telopTransform(undefined, 1, 1080, 1920)).toBeUndefined();
  });

  it('position {0,0} は translate(0%, 0%)', () => {
    expect(telopTransform({ x: 0, y: 0 }, undefined, 1080, 1920)).toBe('translate(0%, 0%)');
  });

  it('y は縦係数で換算する', () => {
    const vy = -1 * SHORT_VCOEFF * 100;
    // x=0.5 は下の「描画時クランプ」対象（short の worst 帯幅 92% では 0.5 も丸められる）なので
    // ここでは y の換算だけを x=0（クランプの影響を受けない）で見る。
    expect(telopTransform({ x: 0, y: -1 }, undefined, 1080, 1920)).toBe(`translate(0%, ${vy}%)`);
  });

  it('position と scale を併用', () => {
    const vy = -0.5 * SHORT_VCOEFF * 100;
    expect(telopTransform({ x: 0, y: -0.5 }, 2, 1080, 1920)).toBe(`translate(0%, ${vy}%) scale(2)`);
  });
});

/**
 * telopTransform の描画時クランプ（安全網・B-1 差し戻し対応・2026-09-06 #3）。
 *
 * 前ラウンドのレビュー差し戻し: `src/preview/telopLayout.ts` と project-template 側には
 * 描画時クランプ（telopMaxWidthFrac × clampTelopX）が入ったが、テロップパック
 * （同梱スタイル・installTelopPack が上書きするこのファイル自体）は対象外のまま
 * だったため、パック導入済みプロジェクトはエディタのライブプレビュー・書き出しの両方が
 * 依然 position ±1 で無防備だった。このテストは修正前は fail する
 * （telopTransform が素の `x*50%` を返し、worst 帯幅では画面外へ出るため）。
 */
describe('telopTransform の描画時クランプ（安全網・テロップパック・2026-09-06 #3）', () => {
  function xFracOf(transform: string | undefined): number {
    const m = /^translate\(([-\d.]+)%/.exec(transform ?? '');
    return m ? parseFloat(m[1] ?? '') / 100 : 0;
  }
  function edgesFor(xFrac: number, containerW: number, elemW: number): { left: number; right: number } {
    const shift = xFrac * containerW;
    const left = (containerW - elemW) / 2 + shift;
    return { left, right: left + elemW };
  }

  const FORMATS = [
    { label: 'youtube(横)', width: 1920, height: 1080 },
    { label: 'short(縦)', width: 1080, height: 1920 },
    { label: 'square(正方形)', width: 1080, height: 1080 },
  ] as const;

  for (const { label, width, height } of FORMATS) {
    for (const x of [-1, 0, 1]) {
      it(`${label}: position.x=${x}・scale未指定 は「ありうる最大の帯幅」でも画面内に収まる`, () => {
        const transform = telopTransform({ x, y: 0 }, undefined, width, height);
        const worstElemW = width * telopMaxWidthFrac(width, height);
        const { left, right } = edgesFor(xFracOf(transform), width, worstElemW);
        expect(left).toBeGreaterThanOrEqual(-1e-9);
        expect(right).toBeLessThanOrEqual(width + 1e-9);
      });
    }
  }

  it('回帰の再現: クランプ前の生の x*50%（telopTransform 導入前の式）は同条件で画面外へ出る', () => {
    const width = 1920;
    const worstElemW = width * telopMaxWidthFrac(width, 1080);
    const rawXFrac = -1 * 0.5;
    const { left } = edgesFor(rawXFrac, width, worstElemW);
    expect(left).toBeLessThan(0);
  });

  it('scale が小さいほどクランプが緩む（安全マージンを削り過ぎない）', () => {
    const width = 1920, height = 1080;
    const transformFull = telopTransform({ x: -1, y: 0 }, 1, width, height);
    const transformScaled = telopTransform({ x: -1, y: 0 }, 0.3, width, height);
    const xFull = Math.abs(xFracOf(transformFull));
    const xScaled = Math.abs(xFracOf(transformScaled));
    expect(xScaled).toBeGreaterThan(xFull);
  });
});

describe('clampTelopX（テロップパック側の複製・telopLayout.ts と同式）', () => {
  it('帯幅が広ければ x=-1 を安全域へ丸める', () => {
    const clamped = clampTelopX(-1, 1920, 800);
    expect(clamped).toBeGreaterThan(-1);
    expect(clamped).toBeCloseTo(-(1920 - 800) / 1920, 6);
  });
  it('壊れた入力は 0 を返す', () => {
    expect(clampTelopX(NaN, 1920, 100)).toBe(0);
    expect(clampTelopX(1, 0, 100)).toBe(0);
  });
});
