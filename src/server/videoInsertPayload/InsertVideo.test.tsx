import { describe, it, expect, vi } from 'vitest';

// useCurrentFrame を先にモックしてから remotion を import する（Remotion の node 実行時の副作用を回避）。
vi.mock('remotion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('remotion')>()),
  useCurrentFrame: () => 0,
}));

import { OffthreadVideo } from 'remotion';
import { InsertVideo } from './InsertVideo';

/** React 要素ツリーを再帰的に走査し、述語に合う要素を集める。 */
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

describe('InsertVideo — 速度変更（Task 3）', () => {
  // Remotion の OffthreadVideo は endAt(trimAfter) の値を「表示フレーム数」として内側 Sequence の
  // durationInFrames にそのまま使い、playbackRate で割らない（node_modules/remotion .../video/OffthreadVideo.js）。
  // そのため endAt を指定すると、スロー時に表示窓が D_source フレームで切れて途中から透明になる。
  // 速度はソースのシーク（playbackRate）だけで表現し、表示窓は外側 Sequence(尺)に任せる＝endAt は付けない。
  it('playbackRate と startFrom を OffthreadVideo に渡し、endAt は付けない（表示窓は外側 Sequence が規定）', () => {
    const tree = InsertVideo({
      segment: {
        id: 1,
        startFrame: 0,
        endFrame: 120,
        file: 'sub/a.mp4',
        sourceInFrame: 10,
        playbackRate: 0.5,
        videoUrl: '/x',
      },
    });
    const ov = collect(tree, (el) => isType(el, OffthreadVideo))[0];
    expect(ov?.props.playbackRate).toBe(0.5);
    expect(ov?.props.startFrom).toBe(10);
    expect(ov?.props.endAt).toBeUndefined();
  });

  it('playbackRate 未指定（rate=1）でも playbackRate=1 を渡し endAt は付けない', () => {
    const tree = InsertVideo({
      segment: {
        id: 2,
        startFrame: 0,
        endFrame: 100,
        file: 'sub/b.mp4',
        sourceInFrame: 5,
        videoUrl: '/y',
      },
    });
    const ov = collect(tree, (el) => isType(el, OffthreadVideo))[0];
    expect(ov?.props.playbackRate).toBe(1);
    expect(ov?.props.startFrom).toBe(5);
    expect(ov?.props.endAt).toBeUndefined();
  });
});
