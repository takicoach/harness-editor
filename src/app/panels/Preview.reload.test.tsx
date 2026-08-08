/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { forwardRef, useEffect } from 'react';
import { Preview } from './Preview';
import { initialEditState } from '../edit/editState';
import type { PlaybackModel } from '../../preview/playbackModel';

// @remotion/player の Player は実動画デコードを要するため、マウント回数だけ数える軽量スタブに差し替える。
let playerMountCount = 0;
vi.mock('@remotion/player', () => ({
  Player: forwardRef(function FakePlayer(_props: unknown, _ref: unknown) {
    useEffect(() => {
      playerMountCount += 1;
    }, []);
    return null;
  }),
}));

// Composition 生成・オーバーレイ・図形ツールバーは本テストの対象外（重い合成を避ける）。
vi.mock('../../preview/EditorComposition', () => ({
  makeEditorComposition: () => () => null,
}));
vi.mock('../preview/PreviewOverlay', () => ({ PreviewOverlay: () => null }));
vi.mock('../preview/ShapeToolbar', () => ({ ShapeToolbar: () => null }));

function makeModel(): PlaybackModel {
  return {
    fps: 30,
    width: 1080,
    height: 1920,
    durationInFrames: 300,
    playbackDurationInFrames: 300,
    overlaps: [],
    playbackOverlaps: [],
    keptSegments: [],
    telops: [],
    titles: [],
    titleStyle: {},
    se: [],
    images: [],
    videoInserts: [],
    bgm: [],
    shapes: [],
    sceneTransitions: [],
    joins: [],
    mainSpeed: 1,
    speedSegments: null,
  } as unknown as PlaybackModel;
}

const noop = () => {};

afterEach(() => {
  cleanup();
});

describe('Preview — 再読み込みボタン（C-4）', () => {
  it('ボタンにブラックアウト/停止時向けの説明ツールチップが付いている', () => {
    playerMountCount = 0;
    const state = initialEditState({ mainSpeed: 1, segmentSpeeds: {} });
    const { getByRole } = render(
      <Preview
        model={makeModel()}
        telop={null as never}
        insertImage={null}
        insertVideo={null}
        allowInsertVideoFallback={false}
        videoUrl="/api/video?id=p1&file=main.mp4"
        hasVideo
        projectId="p1"
        seLibrary={[]}
        imageLibrary={[]}
        videoLibrary={[]}
        bgmLibrary={[]}
        state={state}
        onLive={noop}
        onEdit={noop}
        onDrawingKindChange={noop}
        reloadKey={0}
        onReloadPreview={noop}
      />,
    );
    const btn = getByRole('button', { name: 'プレビューを再読み込み' });
    expect(btn.title).toContain('黒くなった');
    expect(btn.title).toContain('編集内容は失われません');
  });

  it('reloadKey が変わると Player だけが再マウントされる', () => {
    playerMountCount = 0;
    const state = initialEditState({ mainSpeed: 1, segmentSpeeds: {} });
    const props = {
      model: makeModel(),
      telop: null as never,
      insertImage: null,
      insertVideo: null,
      allowInsertVideoFallback: false,
      videoUrl: '/api/video?id=p1&file=main.mp4',
      hasVideo: true,
      projectId: 'p1',
      seLibrary: [],
      imageLibrary: [],
      videoLibrary: [],
      bgmLibrary: [],
      state,
      onLive: noop,
      onEdit: noop,
      onDrawingKindChange: noop,
      onReloadPreview: noop,
    };

    const { rerender } = render(<Preview {...props} reloadKey={0} />);
    expect(playerMountCount).toBe(1);

    // reloadKey 不変の再レンダーでは remount されない。
    rerender(<Preview {...props} reloadKey={0} />);
    expect(playerMountCount).toBe(1);

    // reloadKey が変わると Player が remount される。
    rerender(<Preview {...props} reloadKey={1} />);
    expect(playerMountCount).toBe(2);
  });

  it('再読み込みボタン押下で onReloadPreview が呼ばれる（編集状態には触れない）', () => {
    const state = initialEditState({ mainSpeed: 1, segmentSpeeds: {} });
    const onReloadPreview = vi.fn();
    const { getByRole } = render(
      <Preview
        model={makeModel()}
        telop={null as never}
        insertImage={null}
        insertVideo={null}
        allowInsertVideoFallback={false}
        videoUrl="/api/video?id=p1&file=main.mp4"
        hasVideo
        projectId="p1"
        seLibrary={[]}
        imageLibrary={[]}
        videoLibrary={[]}
        bgmLibrary={[]}
        state={state}
        onLive={noop}
        onEdit={noop}
        onDrawingKindChange={noop}
        reloadKey={0}
        onReloadPreview={onReloadPreview}
      />,
    );
    fireEvent.click(getByRole('button', { name: 'プレビューを再読み込み' }));
    expect(onReloadPreview).toHaveBeenCalledTimes(1);
  });
});
