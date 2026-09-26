/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { forwardRef, useEffect } from 'react';
import { Preview } from './Preview';
import { initialEditState } from '../edit/editState';
import type { PlaybackModel } from '../../preview/playbackModel';
import type { EditorProject } from '../../core/types';

vi.mock('../native/useLegacyPreview', () => ({useLegacyPreview: () => ({status:'ready',document:{revision:1},legacyContext:'lease'})}));
vi.mock('../native/EditorLegacyPreview', () => ({EditorLegacyPreview: forwardRef(function Native(props: {onError:(error:unknown)=>void}, _ref) {
  useEffect(() => { props.onError({kind:'render',message:'native draw failed'}); }, []);
  return <section data-testid="native-monitor"><div data-testid="native-pixels"/></section>;
})}));
vi.mock('../preview/PreviewOverlay', () => ({ PreviewOverlay: () => null }));
vi.mock('../preview/ShapeToolbar', () => ({ ShapeToolbar: () => null }));

function makeModel(): PlaybackModel {
  return {
    fps: 30, width: 1080, height: 1920, durationInFrames: 300, playbackDurationInFrames: 300,
    overlaps: [], playbackOverlaps: [], keptSegments: [], telops: [], titles: [], titleStyle: {},
    se: [], images: [], videoInserts: [], bgm: [], shapes: [], sceneTransitions: [], joins: [],
    mainSpeed: 1, speedSegments: null,
  } as unknown as PlaybackModel;
}

const noop = () => {};

function baseProps() {
  return {
    model: makeModel(),
    project: {videoConfig:{},transcript:{}} as EditorProject,
    hasVideo: true,
    projectId: 'p1',
    state: initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    onLive: noop,
    onEdit: noop,
    onDrawingKindChange: noop,
    reloadKey: 0,
    onReloadPreview: noop,
    seLibrary: [] as string[],
    imageLibrary: [] as string[],
    videoLibrary: [] as string[],
    bgmLibrary: [] as string[],
  };
}

/** jsdom には全画面 API が無いので、テストごとに差し替えて後片付けする。 */
function stubFullscreen(element: Element | null, exit: () => Promise<void>) {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true, value: element,
  });
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true, writable: true, value: exit,
  });
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'fullscreenElement');
  Reflect.deleteProperty(document, 'exitFullscreen');
  vi.restoreAllMocks();
});

describe('Preview — 全画面中の native 描画失敗', () => {
  it('全画面なら崩壊時に exitFullscreen を呼ぶ', () => {
    const exit = vi.fn(() => Promise.resolve());
    stubFullscreen(document.body, exit);
    const { getByTestId } = render(<Preview {...baseProps()} />);
    // 存在検査: 崩壊が実際に検知されている（＝復帰パネルが出ている）。
    expect(getByTestId('preview-crash')).not.toBeNull();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('全画面でなければ exitFullscreen を呼ばない', () => {
    const exit = vi.fn(() => Promise.resolve());
    stubFullscreen(null, exit);
    const { getByTestId } = render(<Preview {...baseProps()} />);
    expect(getByTestId('preview-crash')).not.toBeNull();
    expect(exit).not.toHaveBeenCalled();
  });

  it('exitFullscreen の失敗は握りつぶさず console.warn に出す', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.fn(() => Promise.reject(new Error('denied')));
    stubFullscreen(document.body, exit);
    render(<Preview {...baseProps()} />);
    await Promise.resolve();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });
});
