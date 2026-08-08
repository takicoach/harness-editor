/**
 * サブ動画未導入プロジェクトのプレビュー・フォールバック回帰。
 *
 * 背景（2026-08-08 たきコーチ報告「サブ動画がメイン動画の後ろに隠れる」の正体）:
 * プロジェクトに `src/InsertVideo/InsertVideo.tsx` が無いと `useEditorProject` は
 * console.warn だけして `insertVideo=null` で続行し、プレビューはサブ動画レイヤを
 * まるごと描かなかった。タイムラインのクリップと選択枠だけは出るため
 * 「背面に隠れている」と誤認される。実際にはレイヤ順（画像→サブ動画→テロップ）は
 * 設計どおりで、描画自体が黙殺されていた。
 *
 * 対策: 未導入時はエディタ同梱の `videoInsertPayload/InsertVideo` で代替描画する
 * （書き出しには入らないので VideoInsertInstallBanner の警告は残る）。
 */

import { describe, it, expect, vi } from 'vitest';

// EditorComposition.test.ts と同じ理由（node 環境でのバージョン衝突回避）。
vi.mock('@remotion/transitions', () => ({
  TransitionSeries: Object.assign(({ children }: { children: unknown }) => children, {
    Sequence: ({ children }: { children: unknown }) => children,
    Transition: () => null,
    Overlay: () => null,
  }),
  linearTiming: (x: unknown) => x,
}));
vi.mock('@remotion/transitions/fade', () => ({ fade: () => ({ component: null, props: {} }) }));
vi.mock('@remotion/transitions/slide', () => ({ slide: () => ({ component: null, props: {} }) }));
vi.mock('@remotion/transitions/wipe', () => ({ wipe: () => ({ component: null, props: {} }) }));

import { makeEditorComposition, FALLBACK_INSERT_VIDEO, type EditorCompositionInputProps } from './EditorComposition';
import { InsertVideo as BundledInsertVideo } from '../server/videoInsertPayload/InsertVideo';
import type { TelopComponent } from './loadTelopComponent';
import type { InsertVideoComponent } from './loadInsertVideoComponent';

/** React 要素ツリーを再帰的に走査し、述語に合う要素を DFS 順で集める。 */
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

/** 関数コンポーネント要素の名前（レイヤ識別用）。 */
const nameOf = (el: any): string =>
  typeof el?.type === 'function' ? String(el.type.name ?? '') : '';

const DummyTelop: TelopComponent = (() => null) as unknown as TelopComponent;

function baseProps(): EditorCompositionInputProps {
  return {
    videoUrl: '/api/video?id=p',
    hasVideo: true,
    keptSegments: [{ id: 1, originalStart: 0, originalEnd: 300, playbackStart: 0, playbackEnd: 300 }],
    telops: [],
    se: [],
    images: [],
    videoInserts: [
      {
        id: 7,
        playbackStart: 30,
        playbackEnd: 150,
        file: 'sub/cam2.mp4',
        sourceInFrame: 12,
        scale: 1,
        videoUrl: '/api/asset?id=p&path=sub/cam2.mp4',
      },
    ],
  };
}

/** 合成関数を素の関数として呼び、要素ツリーを得る（フックを実行しない＝runtime 不要）。 */
function renderTree(insertVideo: InsertVideoComponent | null, allowFallback = true): unknown {
  const Composition = makeEditorComposition(DummyTelop, null, insertVideo, allowFallback);
  return (Composition as unknown as (p: EditorCompositionInputProps) => unknown)(baseProps());
}

describe('EditorComposition — サブ動画未導入時のプレビュー・フォールバック', () => {
  it('未導入（insertVideo=null）でもサブ動画レイヤが合成へ入り、同梱部品で描かれる', () => {
    const tree = renderTree(null);
    const layers = collect(tree, (el) => nameOf(el) === 'VideoInsertLayer');
    expect(layers).toHaveLength(1);
    expect(layers[0].props.InsertVideo).toBe(FALLBACK_INSERT_VIDEO);
    expect(layers[0].props.videoInserts).toHaveLength(1);
  });

  it('フォールバック部品は同梱 payload の InsertVideo へ segment をそのまま渡す', () => {
    const segment = { id: 7, startFrame: 30, endFrame: 150, file: 'sub/cam2.mp4', sourceInFrame: 12 };
    const el = (FALLBACK_INSERT_VIDEO as unknown as (p: { segment: unknown }) => any)({ segment });
    expect(el.type).toBe(BundledInsertVideo);
    expect(el.props.segment).toBe(segment);
  });

  it('導入済みプロジェクトでは渡された部品を使う（フォールバックしない）', () => {
    const installed = (() => null) as unknown as InsertVideoComponent;
    const layers = collect(renderTree(installed), (el) => nameOf(el) === 'VideoInsertLayer');
    expect(layers).toHaveLength(1);
    expect(layers[0].props.InsertVideo).toBe(installed);
  });

  it('導入済みなのに読み込みに失敗した場合（allowFallback=false）はフォールバックしない', () => {
    // 導入済みプロジェクトで InsertVideo のバンドル/読込が失敗したケース。
    // ここで同梱部品に差し替えると「プレビューには映るが書き出しは壊れている」乖離を
    // 警告ゼロで隠してしまう。未導入バナーも出ない（導入済みなので）ため、
    // フォールバックは未導入のときだけに限定する。
    const layers = collect(renderTree(null, false), (el) => nameOf(el) === 'VideoInsertLayer');
    expect(layers).toHaveLength(0);
  });

  it('レイヤ順は 画像 → サブ動画 → テロップ を保つ（フォールバックでも前面/背面が入れ替わらない）', () => {
    const ordered = collect(
      renderTree(null),
      (el) => nameOf(el) === 'VideoInsertLayer' || nameOf(el) === 'TelopLayer',
    ).map(nameOf);
    expect(ordered).toEqual(['VideoInsertLayer', 'TelopLayer']);
  });
});
