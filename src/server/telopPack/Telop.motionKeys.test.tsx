/**
 * テロップパック `Telop.tsx` が **キーフレーム（motion.keys）を適用しない**ことの固定（F-1 ラウンド2 差し戻し）。
 *
 * 適用者はラッパー1つ、が F-1 の設計。プレビュー（EditorComposition の TelopLayer）・
 * 高速書き出しの撮影（capturePage の CaptureTelopLayer）・新版 `TelopPlayer.tsx` は
 * いずれも「ラッパーで motion を適用し、segment からは position/scale/motion を外して」
 * Telop を描く。
 *
 * ところが **旧版の TelopPlayer.tsx を持つ既存案件にテロップパックだけを導入した組み合わせ**
 * （パックは Telop.tsx と styles しか配らない）では、旧ラッパーが position/scale は剥がすが
 * motion は剥がさずに渡す。Telop 側がキーを絶対値で適用すると、ラッパーの transform と合成されて
 * **書き出しだけ二重適用**になる（scale=1.2 / x=0.3 のテロップで書き出し scale=2.4 vs プレビュー 2.0）。
 *
 * プリセット（2点アニメ）は base 相対に解決されるため合成しても従来どおりで、F-1 以前からの
 * 挙動なのでそのまま残す。キーだけを「ここでは適用しない」に倒し、旧ラッパー案件では
 * 通常書き出し・高速書き出しの**どちらも静止**（＝ UI の注意書きどおり）に揃える。
 */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('remotion', async () => await import('../../captureRuntime'));

const { Telop } = (await import('./Telop')) as {
  Telop: React.ComponentType<{ segment: unknown }>;
};
const { CaptureFrameProvider } = await import('../../captureRuntime/components');

const VIDEO_CONFIG = { width: 1080, height: 1920, fps: 60, durationInFrames: 600 };

function renderAt(frame: number, segment: Record<string, unknown>): string {
  return renderToStaticMarkup(
    React.createElement(
      CaptureFrameProvider,
      { frame, videoConfig: VIDEO_CONFIG },
      React.createElement(Telop, { segment }),
    ),
  );
}

/**
 * motion 用ラッパーの transform（無ければ null）。
 * スタイル本体も登場アニメで transform を持つため、ラッパーだけが付ける
 * transform-origin を目印に**ラッパーの transform** を取り出す。
 */
function wrapperTransform(html: string): string | null {
  const m = html.match(/transform:([^;"]+);transform-origin:/);
  return m ? m[1]!.trim() : null;
}

const BASE = { text: 'テスト', startFrame: 0, endFrame: 600, template: 1 };

describe('パック Telop はキーフレームを適用しない（旧ラッパーとの二重適用を作らない）', () => {
  // 旧 TelopPlayer 相当の渡し方: position/scale は剥がされ、motion だけが残る。
  const stripped = {
    ...BASE,
    position: undefined,
    scale: undefined,
    motion: {
      preset: 'keyframes',
      keys: [
        { t: 0, x: 0.3, scale: 1.2, opacity: 1 },
        { t: 1, x: 0.3, scale: 2, opacity: 1 },
      ],
    },
  };

  it('区間の途中でも終端でも motion ラッパーの transform が出ない（静止する）', () => {
    for (const frame of [0, 150, 300, 450, 599]) {
      expect(wrapperTransform(renderAt(frame, stripped))).toBeNull();
    }
  });

  it('キー付き motion で描いた絵は motion 無しで描いた絵と同一', () => {
    const noMotion = { ...BASE, position: undefined, scale: undefined };
    for (const frame of [0, 300, 599]) {
      expect(renderAt(frame, stripped)).toBe(renderAt(frame, noMotion));
    }
  });

  it('プリセット（2点アニメ）は従来どおり適用される（非退行）', () => {
    const preset = {
      ...BASE,
      position: undefined,
      scale: undefined,
      motion: { preset: 'zoomIn', intensity: 0.5 },
    };
    const t = wrapperTransform(renderAt(599, preset));
    expect(t).not.toBeNull();
    // zoomIn intensity 0.5 → base.scale(=1) * (1 + 0.8*0.5) = 1.4（base 相対なので合成しても従来どおり）
    const scale = Number(t!.match(/scale\((-?[\d.]+)\)/)?.[1]);
    expect(scale).toBeCloseTo(1.4, 6);
  });
  it('legacy の translate を後置してもラッパー抽出の正規表現は壊れない', () => {
    // wrapperTransform は `transform:…;transform-origin:` を目印にする。legacy は px で後置なので
    // 目印の直前に来る。7 種のいずれかでも抽出できることをここで固定する。
    //
    // **入場窓の中で測る**（事前検査 A の Fix）。このファイルの BASE は startFrame:0 / endFrame:600、
    // VIDEO_CONFIG.fps は 60。frame 35 では slideIn の fadeIn=8 を過ぎて opacity=1、spring も過減衰
    // （ζ = 20 / (2√(100 × 0.5)) ≈ 1.41）で t=0.583s のとき残差 translateY ≈ 2.6e-4 しかない。
    // つまり**浮動小数の残りカスだけがラッパーを生んでいる**状態で、spring の実装が丸めた瞬間に
    // `translateX === 0 && translateY === 0` → `legacyTransform === undefined` かつ opacity===1 →
    // 早期 return でラッパーが消えて赤になる。localFrame=2 なら opacity=2/8=0.25 →（床）0.5、
    // translateY も 30 付近なので、実装の丸めに依存しない。
    const html = renderAt(2, {...BASE, animation: 'slideIn'});
    expect(wrapperTransform(html)).toMatch(/^translate\(0px, -?[\d.e+-]+px\)$/);
    expect(html).toContain('opacity:0.5');
  });
});
