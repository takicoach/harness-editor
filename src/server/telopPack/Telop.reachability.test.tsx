/**
 * テロップパック `Telop.tsx` の**描画時クランプが実際に通る経路**を固定する（B-1 ラウンド3 レビュー差し戻し）。
 *
 * レビューの指摘は「clampTelopX の適用はデッドコードでは」だった。半分は正しい:
 * 現行の `project-template/src/テロップテンプレート/TelopPlayer.tsx` は position を剥がしてから
 * `<Telop segment={stripped}/>` を描くので、**この経路では Telop 内のクランプは通らない**
 * （クランプは TelopPlayer 側の全画面ラッパーが担当する）。
 *
 * だが Telop.tsx 自身も「最終 render はここで適用する」（同ファイル 266-268 行のコメント）設計で、
 * segment に position が載ったまま渡ればクランプが効く。これは机上の話ではなく、
 * **自前の TelopPlayer.tsx を持つ既存プロジェクト**（= まだ剥がす実装になっていないもの）に
 * テロップパックだけを導入した組み合わせで実際に起きる。パックは Telop.tsx のみを配り
 * （installTelopPack.ts:122）TelopPlayer.tsx は差し替えないため、この組み合わせは避けられない。
 *
 * よってここでは「position を載せたまま Telop を描く」＝古い TelopPlayer 相当の呼び方をして、
 * 出力 HTML の transform が**クランプ後の値**になっていることを実描画で確かめる。
 * デッドコードなら x=1 がそのまま translate(50%…) として出るので、このテストが落ちる。
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('remotion', async () => await import('../../captureRuntime'));

const { Telop, telopMaxWidthFrac, clampTelopX } = (await import('./Telop')) as {
  Telop: React.ComponentType<{ segment: unknown }>;
  telopMaxWidthFrac: (w: number, h: number) => number;
  clampTelopX: (x: number, containerW: number, elemW: number) => number;
};
const { CaptureFrameProvider } = await import('../../captureRuntime/components');

const VIDEO_CONFIG = { width: 1080, height: 1920, fps: 60, durationInFrames: 600 };

function renderTelop(segment: Record<string, unknown>): string {
  return renderToStaticMarkup(
    React.createElement(
      CaptureFrameProvider,
      { frame: 10, videoConfig: VIDEO_CONFIG },
      React.createElement(Telop, { segment }),
    ),
  );
}

/** 描画結果から translate の X（%）を取り出す。transform 自体が無ければ null。 */
function translateXPercent(html: string): number | null {
  const m = html.match(/translate\((-?[\d.]+)%/);
  return m ? Number(m[1]) : null;
}

const BASE = { text: 'テスト', startFrame: 0, endFrame: 600, template: 1 };

describe('テロップパック Telop の描画時クランプ（実描画で到達性を固定）', () => {
  it('position を載せたまま描くと transform が出る（＝この経路が生きている）', () => {
    const html = renderTelop({ ...BASE, position: { x: 1, y: 0 } });
    expect(translateXPercent(html)).not.toBeNull();
  });

  it('x=1 はそのまま 50% にならず、クランプ後の値で描かれる', () => {
    const html = renderTelop({ ...BASE, position: { x: 1, y: 0 } });
    const worstElemW = VIDEO_CONFIG.width * telopMaxWidthFrac(VIDEO_CONFIG.width, VIDEO_CONFIG.height);
    const expected = clampTelopX(1, VIDEO_CONFIG.width, worstElemW) * 50;

    expect(translateXPercent(html)).toBeCloseTo(expected, 4);
    // クランプが効いていない（＝デッドコード）なら 50 が出る。
    expect(translateXPercent(html)).toBeLessThan(50);
  });

  it('x=-1 も同じくクランプされる（左端）', () => {
    const html = renderTelop({ ...BASE, position: { x: -1, y: 0 } });
    const worstElemW = VIDEO_CONFIG.width * telopMaxWidthFrac(VIDEO_CONFIG.width, VIDEO_CONFIG.height);
    const expected = clampTelopX(-1, VIDEO_CONFIG.width, worstElemW) * 50;

    expect(translateXPercent(html)).toBeCloseTo(expected, 4);
    expect(translateXPercent(html)).toBeGreaterThan(-50);
  });

  it('x=0 は動かさない（クランプが中央を歪めない）', () => {
    const html = renderTelop({ ...BASE, position: { x: 0, y: 0.5 } });
    expect(translateXPercent(html)).toBe(0);
  });
});
