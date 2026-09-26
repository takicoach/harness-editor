/**
 * @vitest-environment jsdom
 *
 * 撮影ページのレイヤ描画が**本番（プレビュー＝書き出し）の規約と一致する**ことの pin
 * （R1 修正）。素通し描画では transform が落ちる/二重適用される・Ken Burns やフェードの
 * 位相がずれる、という形で無言に本番と食い違うため、ここで規約を固定する。
 *
 * 'remotion' を captureRuntime バレルへ差し替えるのは撮影ページの importmap と同じ構造
 * （本番の TitleLayer / Telop 部品もこの面の上で動く）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { FONTS, fontStack } from '../core/fonts';

vi.mock('remotion', async () => await import('../captureRuntime'));

const { CaptureFrameProvider, useCurrentFrame, useVideoConfig, interpolate, spring } = await import(
  '../captureRuntime'
);
const { renderCaptureLayer } = await import('./layers');
const { telopScaleOriginY, telopTransform } = await import('../preview/telopLayout');
const { motionProgress, sampleMotion } = await import('../core/motion');
import type { CaptureSpec } from './protocol';
import type { TelopSegment } from '../core/types';

afterEach(cleanup);

const VIDEO_CONFIG = { width: 1080, height: 1920, fps: 30, durationInFrames: 300 };

function mount(spec: CaptureSpec, frame: number, loaded: Parameters<typeof renderCaptureLayer>[1]) {
  return render(
    <CaptureFrameProvider frame={frame} videoConfig={VIDEO_CONFIG}>
      {renderCaptureLayer(spec, loaded)}
    </CaptureFrameProvider>,
  );
}

function specOf(layer: CaptureSpec['layer'], data: unknown): CaptureSpec {
  return { layer, projectId: 'p1', videoConfig: VIDEO_CONFIG, data };
}

// ---------------------------------------------------------------------------
// テロップ: TelopLayer 規約
// ---------------------------------------------------------------------------

const TELOPS: TelopSegment[] = [
  {
    id: 1,
    startFrame: 10,
    endFrame: 40,
    text: 'いちまいめ',
    position: { x: 0.2, y: -0.3 },
    scale: 1.4,
  } as TelopSegment,
  { id: 2, startFrame: 60, endFrame: 90, text: 'にまいめ' } as TelopSegment,
  {
    id: 3,
    startFrame: 10,
    endFrame: 40,
    text: 'どうじひょうじ',
    motion: { preset: 'zoomIn' },
  } as TelopSegment,
];

/** 受け取った segment を記録するプローブ部品。 */
function makeTelopProbe(): {
  Telop: (props: { segment: unknown }) => React.ReactElement;
  seen: Record<string, unknown>[];
} {
  const seen: Record<string, unknown>[] = [];
  const Telop = ({ segment }: { segment: unknown }): React.ReactElement => {
    seen.push(segment as Record<string, unknown>);
    return <span data-testid="telop-probe">{(segment as { text: string }).text}</span>;
  };
  return { Telop, seen };
}

describe('テロップレイヤ（EditorComposition.tsx TelopLayer 規約）', () => {
  it('表示中のテロップを全件描く（activeTelopsAt と同じ窓）', () => {
    const { Telop, seen } = makeTelopProbe();
    const { container } = mount(specOf('telop', { telops: TELOPS }), 20, {
      Telop,
      InsertImage: null,
    });
    expect(seen.map((s) => s['id'])).toEqual([1, 3]);
    expect(container.querySelectorAll('[data-sme-kind="telop"]')).toHaveLength(2);
  });

  it('表示区間外では何も描かない（endFrame は排他）', () => {
    const { Telop, seen } = makeTelopProbe();
    const { container } = mount(specOf('telop', { telops: TELOPS }), 40, {
      Telop,
      InsertImage: null,
    });
    expect(seen).toEqual([]);
    expect(container.querySelector('[data-sme-kind="telop"]')).toBeNull();
  });

  it('position/scale はラッパーの transform に載り、segment からは外して渡す（二重適用の防止）', () => {
    const { Telop, seen } = makeTelopProbe();
    const { container } = mount(specOf('telop', { telops: [TELOPS[0]!] }), 20, {
      Telop,
      InsertImage: null,
    });
    const wrapper = container.querySelector('[data-sme-id="1"]') as HTMLElement;
    // 期待値は本番と同じ共有関数から独立に計算する（数式をテストで再実装しない）。
    const expected = telopTransform(
      { x: 0.2, y: -0.3 },
      1.4,
      VIDEO_CONFIG.width,
      VIDEO_CONFIG.height,
    );
    expect(expected).toBeDefined();
    expect(wrapper.style.transform).toBe(expected);
    expect(wrapper.style.transformOrigin).toBe(
      `50% ${telopScaleOriginY(VIDEO_CONFIG.width, VIDEO_CONFIG.height)}%`,
    );
    const passed = seen[0]!;
    expect(passed['position']).toBeUndefined();
    expect(passed['scale']).toBeUndefined();
    expect(passed['motion']).toBeUndefined();
    // 位置以外の中身は落とさない。
    expect(passed['text']).toBe('いちまいめ');
    expect(passed['id']).toBe(1);
  });

  it('motion 付きは進行度で補間した位置・不透明度になる（sampleMotion と一致）', () => {
    const { Telop } = makeTelopProbe();
    const frame = 25;
    const segment = TELOPS[2]!;
    const { container } = mount(specOf('telop', { telops: [segment] }), frame, {
      Telop,
      InsertImage: null,
    });
    const sampled = sampleMotion(
      segment.motion,
      { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 },
      motionProgress(frame, segment.startFrame, segment.endFrame),
    );
    const wrapper = container.querySelector('[data-sme-id="3"]') as HTMLElement;
    const expected = telopTransform(
      sampled.x !== 0 || sampled.y !== 0 ? { x: sampled.x, y: sampled.y } : undefined,
      sampled.scale,
      VIDEO_CONFIG.width,
      VIDEO_CONFIG.height,
    );
    expect(expected).toBeDefined();
    // motion が効いていることの分離検査（恒等パラメータ禁止 #194）。
    expect(sampled.scale).not.toBe(1);
    expect(wrapper.style.transform).toBe(expected);
  });

  it('部品未ロードは captureRuntime: 接頭辞で fail-loud', () => {
    expect(() => renderCaptureLayer(specOf('telop', { telops: TELOPS }), { Telop: null, InsertImage: null }))
      .toThrow(/^captureRuntime:/);
  });
});

// ---------------------------------------------------------------------------
// 画像: InsertImageLayer 規約（Sequence でセグメント相対フレーム）
// ---------------------------------------------------------------------------

const IMAGES = [
  { id: 11, startFrame: 30, endFrame: 90, file: 'a.png', type: 'zukai' as const },
  { id: 12, startFrame: 200, endFrame: 200, file: 'b.png', type: 'photo' as const },
];

function makeImageProbe(): {
  InsertImage: (props: { segment: unknown }) => React.ReactElement;
  frames: { id: number; frame: number; duration: number }[];
} {
  const frames: { id: number; frame: number; duration: number }[] = [];
  const InsertImage = ({ segment }: { segment: unknown }): React.ReactElement => {
    // 部品側は自分の Sequence 内のローカルフレームを読む（本番 InsertImage.tsx と同じ）。
    const s = segment as { id: number };
    const frame = useCurrentFrame();
    const { durationInFrames } = useVideoConfig();
    frames.push({ id: s.id, frame, duration: durationInFrames });
    return <span data-testid="image-probe" />;
  };
  return { InsertImage, frames };
}

describe('画像レイヤ（EditorComposition.tsx InsertImageLayer 規約）', () => {
  it('Sequence で包み、部品にはセグメント相対フレームを渡す（位相ずれの防止）', () => {
    const { InsertImage, frames } = makeImageProbe();
    mount(specOf('image', { images: IMAGES }), 45, { Telop: null, InsertImage });
    expect(frames).toEqual([{ id: 11, frame: 45 - 30, duration: 90 - 30 }]);
  });

  it('区間の先頭フレームは 0（絶対フレームを素通ししていない証拠）', () => {
    const { InsertImage, frames } = makeImageProbe();
    mount(specOf('image', { images: IMAGES }), 30, { Telop: null, InsertImage });
    expect(frames[0]?.frame).toBe(0);
  });

  it('区間外は描かない（endFrame は排他）', () => {
    const { InsertImage, frames } = makeImageProbe();
    const { container } = mount(specOf('image', { images: IMAGES }), 90, {
      Telop: null,
      InsertImage,
    });
    expect(frames).toEqual([]);
    expect(container.querySelector('[data-sme-kind="image"]')).toBeNull();
  });

  it('縮退区間（endFrame <= startFrame）は1フレームも描かない', () => {
    const { InsertImage, frames } = makeImageProbe();
    mount(specOf('image', { images: IMAGES }), 200, { Telop: null, InsertImage });
    expect(frames).toEqual([]);
  });

  it('部品未ロードは captureRuntime: 接頭辞で fail-loud', () => {
    expect(() =>
      renderCaptureLayer(specOf('image', { images: IMAGES }), { Telop: null, InsertImage: null }),
    ).toThrow(/^captureRuntime:/);
  });
});

// ---------------------------------------------------------------------------
// タイトル: 本番 TitleLayer をそのまま使う
// ---------------------------------------------------------------------------

describe('タイトルレイヤ（CaptureTitleLayer: preview/TitleLayer.tsx の TitleClip を同順で再現）', () => {
  it('本番の TitleLayer が描いた帯が出る', () => {
    const titles = [{ id: 21, startFrame: 0, endFrame: 60, text: 'たいとる' }];
    const { getByText } = mount(specOf('title', { titles }), 10, {
      Telop: null,
      InsertImage: null,
    });
    expect(getByText('たいとる')).toBeTruthy();
  });

  it('titleStyle.fontFamily を選ぶとプレビューと同じ帯にそのまま反映される（T16）', () => {
    const titles = [{ id: 23, startFrame: 0, endFrame: 60, text: 'フォント選択' }];
    const { getByText } = mount(specOf('title', { titles, titleStyle: { top: 10, left: 10, fontSize: 40, fontFamily: 'Zen Kaku Gothic New' } }), 10, {
      Telop: null,
      InsertImage: null,
    });
    expect(getByText('フォント選択').style.fontFamily).toContain('Zen Kaku Gothic New');
  });

  // M-4: telop（NativeInspector の fontStack）と同じフォールバック鎖にする。
  it('明朝系の title は明朝へフォールバックする（telop と同じ鎖・M-4）', () => {
    const titles = [{ id: 1, text: '明朝タイトル', startFrame: 0, endFrame: 30 }];
    const { getByText } = mount(specOf('title', { titles, titleStyle: { top: 10, left: 10, fontSize: 40, fontFamily: 'Noto Serif JP' } }), 10, {
      Telop: null, InsertImage: null,
    });
    // DOM は引用符を " に正規化するので、比較の前に揃える。
    const family = getByText('明朝タイトル').style.fontFamily;
    expect(family.replaceAll('"', "'")).toBe(fontStack(FONTS.find(font => font.family === 'Noto Serif JP')!));
    expect(family).toContain('Mincho');
    expect(family).not.toContain('Hiragino Kaku Gothic ProN');
  });

  it('titleStyle.fontFamily 未指定の旧案件は既定 family のまま描く（回帰防止）', () => {
    const titles = [{ id: 24, startFrame: 0, endFrame: 60, text: '旧案件' }];
    const { getByText } = mount(specOf('title', { titles }), 10, {
      Telop: null,
      InsertImage: null,
    });
    expect(getByText('旧案件').style.fontFamily).toBe('"Noto Sans JP", "Hiragino Kaku Gothic ProN", sans-serif');
  });

  it('opacity/translateX は preview/TitleLayer.tsx の TitleClip と同じ数式（interpolate+spring）で計算される', () => {
    const frame = 4; // フェードイン窓（0..8）の途中。plateau（8..52）を選ぶと恒等 opacity=1 になる。
    const segment = { id: 22, startFrame: 0, endFrame: 60, text: 'ずれ検知' };
    const { getByText } = mount(specOf('title', { titles: [segment] }), frame, {
      Telop: null,
      InsertImage: null,
    });
    const p = getByText('ずれ検知');
    const gradientWrapper = p.parentElement as HTMLElement;
    const outer = gradientWrapper.parentElement as HTMLElement;

    // 期待値は preview/TitleLayer.tsx の TitleClip と同じ共有ランタイム関数（captureRuntime の
    // interpolate/spring）から独立に計算する（数式をここで再実装しない）。
    const duration = segment.endFrame - segment.startFrame;
    const expectedOpacity = interpolate(frame, [0, 8, duration - 8, duration], [0, 1, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    const slideIn = spring({ frame, fps: VIDEO_CONFIG.fps, config: { damping: 20, stiffness: 100, mass: 0.5 } });
    const expectedTranslateX = interpolate(slideIn, [0, 1], [-50, 0]);

    // motion が効いていることの分離検査（恒等パラメータ禁止 #194）。
    expect(expectedOpacity).not.toBe(1);
    expect(outer.style.opacity).toBe(String(expectedOpacity));
    expect(outer.style.transform).toBe(`translateX(${expectedTranslateX}px)`);
  });
});

// ---------------------------------------------------------------------------
// telop+title 統合レイヤ（設計判断3: z 順 telop 下・title 上 = EditorComposition.tsx:586-588）
// ---------------------------------------------------------------------------

describe('telop+title 統合レイヤ（CaptureTelopTitleLayer）', () => {
  const COMPOSITE_TELOPS: TelopSegment[] = [
    { id: 31, startFrame: 0, endFrame: 60, text: 'てろっぷ' } as TelopSegment,
  ];
  const COMPOSITE_TITLES = [{ id: 32, startFrame: 0, endFrame: 60, text: 'たいとる合成' }];

  it('z 順は telop が先・title が後（DOM 順 = 描画順で title が上に乗る）', () => {
    const { Telop } = makeTelopProbe();
    const { container, getByText } = mount(
      specOf('telop-title', { telops: COMPOSITE_TELOPS, titles: COMPOSITE_TITLES }),
      10,
      { Telop, InsertImage: null },
    );
    const telopNode = container.querySelector('[data-sme-kind="telop"]');
    const titleNode = getByText('たいとる合成');
    expect(telopNode).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING(4): telopNode は titleNode より前（＝telop が下に描かれ、
    // title が後発 = 上に乗る）。
    expect(telopNode!.compareDocumentPosition(titleNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('telop・title の両方が空でも例外なく描く（何も出ない）', () => {
    const { Telop } = makeTelopProbe();
    const { container } = mount(specOf('telop-title', { telops: [], titles: [] }), 10, {
      Telop,
      InsertImage: null,
    });
    expect(container.querySelector('[data-sme-kind="telop"]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('telop のみ（titles 空）は telop だけ描く', () => {
    const { Telop } = makeTelopProbe();
    const { container, queryByText } = mount(
      specOf('telop-title', { telops: COMPOSITE_TELOPS, titles: [] }),
      10,
      { Telop, InsertImage: null },
    );
    expect(container.querySelector('[data-sme-kind="telop"]')).not.toBeNull();
    expect(queryByText('たいとる合成')).toBeNull();
  });

  it('title のみ（telops 空）は title だけ描く', () => {
    const { Telop } = makeTelopProbe();
    const { container, getByText } = mount(
      specOf('telop-title', { telops: [], titles: COMPOSITE_TITLES }),
      10,
      { Telop, InsertImage: null },
    );
    expect(container.querySelector('[data-sme-kind="telop"]')).toBeNull();
    expect(getByText('たいとる合成')).toBeTruthy();
  });

  it('Telop 未ロードは captureRuntime: 接頭辞で fail-loud（title のみでも Telop 未ロードなら弾く）', () => {
    expect(() =>
      renderCaptureLayer(specOf('telop-title', { telops: [], titles: COMPOSITE_TITLES }), {
        Telop: null,
        InsertImage: null,
      }),
    ).toThrow(/^captureRuntime:/);
  });
});
