/**
 * wrapper が既存 7 種を当てることの単体（最終描画の合成は Task 7 の Telop.composite.test.tsx）。
 * 期待値は `telopStyles.ts` の設定値と `Telop.tsx:474-521` の算式から手で導く（写し同士の
 * 一致では足りない）。導出は各テストの本文に 1 行で書く。
 */
// **`vi.mock('remotion', …)` は書かない**（事前検査 A の Fix）。パック `Telop.tsx:1` が import するのは
// `@harness/frame-runtime` で、`vitest.config.ts:39` の alias が `src/captureRuntime/index.ts` へ落とす。
// `remotion` は node_modules に存在しない（実測）ので、既存 2 本（`Telop.motionKeys.test.tsx:22` /
// `Telop.reachability.test.tsx`）の `vi.mock('remotion')` は**効いていない歴史的遺物**。ここへ写すと
// 「これが差し替えの仕掛け」という誤解を次の実装者へ配ることになる。普通の静的 import で足りる。
import {describe, expect, it} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CaptureFrameProvider} from '../../captureRuntime/components';
import {interpolate} from '../../captureRuntime/interpolate';
import {spring} from '../../captureRuntime/spring';
import {Telop} from './Telop';
import {LEGACY_TELOP_ANIMATION_CONFIG, PACK_LEGACY_TELOP_ANIMATION_IDS, packLegacyTelopAnimationFrame}
  from './telopLegacyAnimation';

const TelopAny = Telop as unknown as React.ComponentType<{segment: unknown}>;
const CONFIG = {width: 1080, height: 1920, fps: 30, durationInFrames: 600};
const BASE = {text: 'ゴルフ上達', startFrame: 30, endFrame: 150, template: 1};
/** 標準尺 30..150 の境界集合（接続ゲートの `CONNECTION_FRAMES` と同じ導出）。 */
const BOUNDARY_FRAMES = [29, 30, 37, 38, 90, 140, 141, 150, 151];

function render(segment: Record<string, unknown>, frame: number): string {
  return renderToStaticMarkup(React.createElement(CaptureFrameProvider,
    {frame, videoConfig: CONFIG}, React.createElement(TelopAny, {segment})));
}
/** ラッパー（transform-origin を持つ唯一の要素）の style を取る。 */
function wrapperStyle(html: string): string | null {
  const match = html.match(/<div style="([^"]*transform-origin[^"]*)"/);
  return match ? match[1]!.replace(/&#x27;/g, "'") : null;
}

describe('no-op（設計 §3.2）', () => {
  // 事前検査 A の Fix: 1 フレーム（40）だけだと「接続ゲートが落ちたとき単体が何も言わない」。
  // no-op が崩れるのは**窓の境界**なので、境界集合で回す。とくに frame 150 は
  // `localFrame === durationFrames` で `packLegacyTelopAnimationFrame` が null を返さず opacity 0 を
  // 返す境界、151 が最初の null。
  it.each([undefined, 'none', 'charByChar', 'popIn', 'まだ無い動き'] as const)(
    'animation=%s はどの境界フレームでもラッパーを増やさない', animation => {
      for (const frame of BOUNDARY_FRAMES)
        expect(wrapperStyle(render({...BASE, ...(animation ? {animation} : {})}, frame)),
          `${animation ?? '未指定'}@${frame}`).toBeNull();
    });

  it('区間外（開始の 1 つ前・終了の 1 つ後）は 7 種でもラッパーを増やさない', () => {
    for (const frame of [29, 151])
      expect(wrapperStyle(render({...BASE, animation: 'slideIn'}, frame))).toBeNull();
  });

  it('7 種の集合は実装（PACK_LEGACY_TELOP_ANIMATION_IDS）と一致する（手書きの取りこぼしを作らない）', () => {
    expect([...PACK_LEGACY_TELOP_ANIMATION_IDS].sort()).toEqual(
      ['fadeBlurFromBottom', 'fadeFromLeft', 'fadeFromRight', 'fadeOnly', 'slideFromLeft', 'slideIn', 'slideLeftFadeBlur']);
  });
});

describe('7 種は wrapper が当たる', () => {
  it('slideIn は translateY が spring で、opacity に床が掛かる', () => {
    // 導出: slideIn は fadeIn=8 / dist=30 / dir='up' / spring{20,100,.5}（telopStyles.ts:56-67）。
    // localFrame=1 → opacity=1/8=0.125 → 床 0.5、translateY=interpolate(spring(1),[0,1],[30,0])。
    const expected = packLegacyTelopAnimationFrame(
      {animation: 'slideIn', localFrame: 1, durationFrames: 120}, {fps: 30, interpolate, spring});
    expect(expected!.opacity).toBe(0.5);
    const style = wrapperStyle(render({...BASE, animation: 'slideIn'}, 31))!;
    expect(style).toContain(`translate(0px, ${expected!.translateY}px)`);
    expect(style).toContain('opacity:0.5');
  });

  it('fadeOnly は移動が 0 なので transform を増やさず opacity だけ動く', () => {
    // 導出: fadeOnly は slideInDistance=0（telopStyles.ts:70-81）→ translateX=translateY=0。
    const style = wrapperStyle(render({...BASE, animation: 'fadeOnly'}, 31))!;
    expect(style).not.toContain('translate(');
    expect(style).toContain('opacity:0.5');
  });

  it('fadeOnly は segment.id を渡しても純粋なフェードのまま（裁定 1・設計 §3.5）', () => {
    // 案件テンプレートは id%6 で 4 種へばらけるが、パックでは 1 種類に固定する。
    const styles = [0, 1, 3, 5].map(id => wrapperStyle(render({...BASE, id, animation: 'fadeOnly'}, 31)));
    expect(new Set(styles).size).toBe(1);
  });

  it('終端では opacity が 0 になる（床は入場窓だけ）', () => {
    // 導出: slideIn は fadeOut=8 → interpolate(120,[0,8,112,120],[0,1,1,0]) = 0。entryFrames=8 < 120。
    expect(wrapperStyle(render({...BASE, animation: 'slideIn'}, 150))!).toContain('opacity:0');
  });

  it('入場の最初のフレームは床 0.5 で出る（裁定 6 の直接の帰結を目に見える形で固定）', () => {
    // 導出: localFrame=0 → 素の opacity は 0。床で 0.5 になり、spring(0)=0 なので translateY=30。
    // **7 種のテロップは 1 フレーム目に 50% で出現する**。ここが製品の見え方を決めるので固定する。
    const style = wrapperStyle(render({...BASE, animation: 'slideIn'}, 30))!;
    expect(style).toContain('opacity:0.5');
    expect(style).toContain('translate(0px, 30px)');
  });
});

describe('合成順（設計 §2.2 の実測。scale の内側に px 移動が入る）', () => {
  /** transform を取り出す。**先に存在を確かめる**（事前検査 A の Fix: `match(...)![1]!` を直接読むと、
   *  transform が出ないケースで失敗理由が「順序が違う」ではなく TypeError になって原因を隠す）。 */
  const transformOf = (style: string, label: string): string => {
    expect(style, `${label}: transform が出ていない`).toContain('transform:');
    const match = style.match(/transform:([^;]+);/);
    expect(match, `${label}: transform の取り出しに失敗`).not.toBeNull();
    return match![1]!;
  };

  it('scale があると `scale(...)` の後ろに legacy の translate が付く', () => {
    const style = wrapperStyle(render({...BASE, animation: 'slideFromLeft', scale: 1.2}, 31))!;
    const transform = transformOf(style, 'scale');
    expect(transform.indexOf('scale(1.2)')).toBeLessThan(transform.indexOf('translate('));
    // 前置してしまうと scale が効かず、案件テンプレート（:679 `${layoutTransform}translate(...)`）と経路差になる。
  });

  it('position があると telopTransform の translate(%) が先、legacy の translate(px) が後', () => {
    const style = wrapperStyle(render({...BASE, animation: 'slideFromLeft', position: {x: 0.2, y: -0.5}}, 31))!;
    const transform = transformOf(style, 'position');
    expect(transform.indexOf('%')).toBeLessThan(transform.indexOf('px'));
  });

  it('transform が出ないケースでも判定器が TypeError にならない（判定器の自己検査）', () => {
    // fadeOnly は移動 0 なので transform を持たない。ここで transformOf を呼ぶと**明示的に**落ちる。
    const style = wrapperStyle(render({...BASE, animation: 'fadeOnly'}, 31))!;
    expect(() => transformOf(style, 'fadeOnly')).toThrow();
  });
});

describe('設定値は 9 種すべて揃っている', () => {
  it('LEGACY_TELOP_ANIMATION_CONFIG に 9 件', () => {
    expect(Object.keys(LEGACY_TELOP_ANIMATION_CONFIG)).toHaveLength(9);
  });
});
