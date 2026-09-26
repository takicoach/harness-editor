/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { forwardRef, useEffect } from 'react';
import { Preview } from './Preview';
import { initialEditState } from '../edit/editState';
import type { PlaybackModel } from '../../preview/playbackModel';
import type { EditorProject } from '../../core/types';

const preview = vi.hoisted(() => ({status:'ready'}));
vi.mock('../native/useLegacyPreview', () => ({useLegacyPreview: () => ({status:preview.status,document:{revision:1},legacyContext:'lease'})}));
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

afterEach(() => {cleanup();preview.status='ready';});

/** Preview の必須 props（テスト対象と無関係な部分）。 */
function baseProps({ onReloadPreview }: { onReloadPreview: () => void }) {
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
    onReloadPreview,
    seLibrary: [] as string[],
    imageLibrary: [] as string[],
    videoLibrary: [] as string[],
    bgmLibrary: [] as string[],
  };
}

describe('Preview — native 描画失敗の復帰', () => {
  it('does not cover preparation failure with the previous renderer crash panel', () => {
    const input = baseProps({onReloadPreview:noop}), view = render(<Preview {...input}/>);
    expect(view.getByTestId('preview-crash')).toBeTruthy();
    preview.status = 'failed'; view.rerender(<Preview {...input}/>);
    expect(view.queryByTestId('preview-crash')).toBeNull();
  });
  it('絵文字ではなく文章と再読み込みボタンが出る', () => {
    const onReloadPreview = vi.fn();
    const { getByTestId } = render(<Preview {...baseProps({ onReloadPreview })} />);
    const panel = getByTestId('preview-crash');
    expect(panel.textContent).toContain('プレビューを表示できませんでした');
    expect(panel.textContent).toContain('編集内容は失われません');
    fireEvent.click(getByTestId('preview-crash-reload'));
    expect(onReloadPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps the recovery panel outside the native pixel surface', () => {
    const { getByTestId, container } = render(<Preview {...baseProps({onReloadPreview:noop})}/>);
    const monitor = getByTestId('native-monitor'), panel = getByTestId('preview-crash');
    expect(monitor.contains(panel)).toBe(false);
    expect(panel.parentElement).toBe(container.querySelector('.pv-stage'));
  });
});
