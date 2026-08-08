import { describe, it, expect, vi } from 'vitest';
import { Sequence, OffthreadVideo } from 'remotion';

// @remotion/transitions は node 環境でバージョン衝突エラーになるため先にモックする。
// makeEditorComposition のテストは overlaps=[] (hasOverlap=false) パスのみ通るため、
// TransitionSeries の実挙動検証は integration/e2e で行う。
vi.mock('@remotion/transitions', () => ({
  TransitionSeries: Object.assign(
    ({ children }: { children: unknown }) => children,
    {
      Sequence: ({ children }: { children: unknown }) => children,
      Transition: () => null,
      Overlay: () => null,
    },
  ),
  linearTiming: (x: unknown) => x,
}));
vi.mock('@remotion/transitions/fade', () => ({ fade: () => ({ component: null, props: {} }) }));
vi.mock('@remotion/transitions/slide', () => ({ slide: () => ({ component: null, props: {} }) }));
vi.mock('@remotion/transitions/wipe', () => ({ wipe: () => ({ component: null, props: {} }) }));

import { makeEditorComposition, type EditorCompositionInputProps, type ShapeInput } from './EditorComposition';
import { segmentPlaybackRate } from './EditorComposition';
import { buildTransitionSeriesChildren } from './transitionSeriesChildren';
import type { CutSegment, SceneTransition } from '../core/types';
import type { Join } from '../core/joinEngine';

/** React 要素ツリーを再帰的に走査し、述語に合う要素を集める（純データなので runtime 不要）。 */
function collect(node: unknown, pred: (el: any) => boolean, out: any[] = []): any[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const c of node) collect(c, pred, out);
    return out;
  }
  const el = node as any;
  if (pred(el)) out.push(el);
  if (el.props?.children != null) collect(el.props.children, pred, out);
  return out;
}

const isType = (el: any, type: unknown): boolean =>
  el != null && typeof el === 'object' && 'type' in el && el.type === type;

describe('EditorComposition のカット区間プレビュー', () => {
  // カットが 1 箇所（区間 1 と区間 2 の間で原本フレーム 100→200 を削除）あるケース。
  const keptSegments: CutSegment[] = [
    { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
    { id: 2, originalStart: 200, originalEnd: 350, playbackStart: 100, playbackEnd: 250 },
  ];
  const inputProps: EditorCompositionInputProps = {
    videoUrl: '/api/asset?id=test&path=main.mp4',
    hasVideo: true,
    keptSegments,
    telops: [],
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    shapes: [],
  };

  it('各カット区間の Sequence が premountFor を持つ（境界の黒チラつき防止）', () => {
    const Composition = makeEditorComposition(() => null, null, null);
    const tree = Composition(inputProps);
    // OffthreadVideo（ベース動画）を内包する Sequence ＝ カット区間。
    const videoSequences = collect(
      tree,
      (el) => isType(el, Sequence) && collect(el, (c) => isType(c, OffthreadVideo)).length > 0,
    );
    expect(videoSequences.length).toBe(keptSegments.length);
    for (const seq of videoSequences) {
      // premountFor が無い／0 だと、境界で次区間の動画要素がシーク完了するまで黒が透ける。
      expect(seq.props.premountFor).toBeGreaterThan(0);
    }
  });
});

describe('EditorComposition — ShapeLayer', () => {
  const keptSegments: CutSegment[] = [
    { id: 1, originalStart: 0, originalEnd: 300, playbackStart: 0, playbackEnd: 300 },
  ];

  it('shapes が存在するとき ShapeLayer コンポーネントを描画し、shapes props を正しく渡す', () => {
    const shapes: ShapeInput[] = [
      {
        id: 1,
        playbackStart: 0,
        playbackEnd: 100,
        kind: 'rect',
        x1: 0.1, y1: 0.2, x2: 0.5, y2: 0.6,
        color: '#ff0000',
        thickness: 'medium',
      },
      {
        id: 2,
        playbackStart: 50,
        playbackEnd: 200,
        kind: 'arrow',
        x1: 0.0, y1: 0.0, x2: 1.0, y2: 1.0,
        color: '#00ff00',
        thickness: 'thin',
      },
    ];
    const props: EditorCompositionInputProps = {
      videoUrl: '/api/video',
      hasVideo: true,
      keptSegments,
      telops: [],
      se: [],
      images: [],
      videoInserts: [],
      bgm: [],
      shapes,
    };
    const Composition = makeEditorComposition(() => null, null, null);
    const tree = Composition(props);
    // ShapeLayer はサブコンポーネントで、AbsoluteFill の children に含まれる。
    // ツリーを再帰的に走査して shapes prop を持つ要素を探す。
    const shapeLayerNodes = collect(
      tree,
      (el) =>
        el != null &&
        typeof el === 'object' &&
        'props' in el &&
        Array.isArray(el.props?.shapes),
    );
    expect(shapeLayerNodes.length).toBeGreaterThan(0);
    const shapeLayerNode = shapeLayerNodes[0];
    expect(shapeLayerNode?.props.shapes).toHaveLength(2);
    expect(shapeLayerNode?.props.shapes[0]?.id).toBe(1);
    expect(shapeLayerNode?.props.shapes[1]?.id).toBe(2);
  });

  it('縮退区間（playbackEnd <= playbackStart）の図形は描かない', () => {
    const shapes: ShapeInput[] = [
      {
        id: 1,
        playbackStart: 100,
        playbackEnd: 100,  // duration = 0 → 縮退
        kind: 'line',
        x1: 0, y1: 0, x2: 1, y2: 1,
        color: '#fff',
        thickness: 'thin',
      },
    ];
    const props: EditorCompositionInputProps = {
      videoUrl: '/api/video',
      hasVideo: true,
      keptSegments,
      telops: [],
      se: [],
      images: [],
      videoInserts: [],
      bgm: [],
      shapes,
    };
    const Composition = makeEditorComposition(() => null, null, null);
    const tree = Composition(props);
    // from=100, durationInFrames=0 に該当する Sequence は存在しない（縮退除外）
    const collapsed = collect(
      tree,
      (el) => isType(el, Sequence) && el.props.from === 100 && el.props.durationInFrames === 0,
    );
    expect(collapsed.length).toBe(0);
  });

  it('shapes が空のとき Sequence を生成しない', () => {
    const props: EditorCompositionInputProps = {
      videoUrl: '/api/video',
      hasVideo: true,
      keptSegments,
      telops: [],
      se: [],
      images: [],
      videoInserts: [],
      bgm: [],
      shapes: [],
    };
    const Composition = makeEditorComposition(() => null, null, null);
    const tree = Composition(props);
    // shapes Sequence は 0 件（動画 Sequence のみ）
    const shapeSeqs = collect(
      tree,
      (el) =>
        isType(el, Sequence) &&
        el.props.from === 0 &&
        !collect(el, (c) => isType(c, OffthreadVideo)).length,
    );
    expect(shapeSeqs.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// segmentPlaybackRate の純関数テスト
// ─────────────────────────────────────────────────────────

describe('segmentPlaybackRate', () => {
  it('segmentRates にあればそれ', () => {
    expect(segmentPlaybackRate(2, { 2: 0.5 }, 1)).toBe(0.5);
  });
  it('無ければ mainSpeed', () => {
    expect(segmentPlaybackRate(9, { 2: 0.5 }, 1)).toBe(1);
    expect(segmentPlaybackRate(9, undefined, 0.5)).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────
// buildTransitionSeriesChildren の純関数テスト
// ─────────────────────────────────────────────────────────

const segsForTSC: CutSegment[] = [
  { id: 1, originalStart: 0, originalEnd: 100, playbackStart: 0, playbackEnd: 100 },
  { id: 2, originalStart: 150, originalEnd: 250, playbackStart: 100, playbackEnd: 200 },
];
const joinsForTSC: Join[] = [{ atOriginal: 100, playbackFrame: 100 }];

describe('buildTransitionSeriesChildren', () => {
  it('重なる系なし＝Sequence 2 つ・Transition なし', () => {
    const ch = buildTransitionSeriesChildren(segsForTSC, [], joinsForTSC);
    expect(ch.filter((c) => c.type === 'sequence')).toHaveLength(2);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });

  it('クロスフェード＝間に Transition 1 つ・overlap クランプ済み', () => {
    const t: SceneTransition[] = [{ id: 9, at: 100, kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    const trans = ch.filter((c) => c.type === 'transition');
    expect(trans).toHaveLength(1);
    expect(trans[0]!.overlap).toBe(20);
  });

  it('クロスフェード＝Sequence/Transition/Sequence の順', () => {
    const t: SceneTransition[] = [{ id: 9, at: 100, kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch[0]!.type).toBe('sequence');
    expect(ch[1]!.type).toBe('transition');
    expect(ch[2]!.type).toBe('sequence');
  });

  it('クロスフェードの overlap は buildOverlaps と同じクランプ（隣接区間の短い方の半分）', () => {
    // 区間長 100/100 → 上限 50。durationFrames 80 → 50 へクランプ
    const t: SceneTransition[] = [{ id: 1, at: 100, kind: 'slide', durationFrames: 80 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    const trans = ch.filter((c) => c.type === 'transition');
    expect(trans[0]!.overlap).toBe(50);
  });

  it('fade 系は Transition を差し込まない（重なる系でない）', () => {
    const t: SceneTransition[] = [{ id: 9, at: 100, kind: 'fadeBlack', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });

  it('重なる系でも head/tail は Transition に変換しない', () => {
    const t: SceneTransition[] = [{ id: 9, at: 'head', kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });

  it('各 sequence の seg は元の CutSegment と一致する', () => {
    const ch = buildTransitionSeriesChildren(segsForTSC, [], joinsForTSC);
    const seqs = ch.filter((c) => c.type === 'sequence');
    expect(seqs[0]!.seg.id).toBe(1);
    expect(seqs[1]!.seg.id).toBe(2);
  });

  it('joins に対応する at がない場合は Transition なし', () => {
    // joins は atOriginal=100 だが sceneTransitions は at=999 で一致しない
    const t: SceneTransition[] = [{ id: 9, at: 999, kind: 'crossfade', durationFrames: 20 }];
    const ch = buildTransitionSeriesChildren(segsForTSC, t, joinsForTSC);
    expect(ch.filter((c) => c.type === 'transition')).toHaveLength(0);
  });
});
