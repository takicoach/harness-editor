/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EditorProject } from '../../core/types';
import { buildPlaybackModel } from '../../preview/playbackModel';
import { createEditState, toEditorProject } from '../edit/editState';
import { ASSET_KEYS, type AssetKind } from '../edit/assetPlacementOps';
import { Inspector } from './Inspector';

vi.mock('./VideoSyncWaveform', () => ({ VideoSyncWaveform: ({ durationFrames }: { durationFrames: number }) => <output data-testid="source-window">{durationFrames}</output> }));
vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));
afterEach(cleanup);

function fixture() {
  const span = { id: 1, originalStart: 0, originalEnd: 120 };
  const p: EditorProject = {
    videoConfig: { format: 'youtube', fps: 30, durationFrames: 900, videoFile: 'main.mp4',
      resolution: { width: 1920, height: 1080 }, orientation: 'landscape', titleStyle: { top: 60, left: 30, fontSize: 30 } },
    projectConfig: null, transcript: { durationMs: 30000, words: [], segments: [] },
    telops: [{ ...span, text: '字幕' }], titles: [{ ...span, text: 'タイトル' }],
    images: [{ ...span, file: 'overlay.png', type: 'photo' }],
    videoInserts: [{ ...span, file: 'sub.mp4', sourceInFrame: 12, playbackRate: 1.5 }],
    se: [{ ...span, file: 'se.wav', volume: 1 }],
    bgm: [{ ...span, file: 'bgm.wav', volume: 1, fadeInFrames: 0, fadeOutFrames: 0 }],
    shapes: [{ ...span, kind: 'rect', color: '#fff', thickness: 'medium', opacity: 1, x1: 0, y1: 0, x2: 1, y2: 1 }],
    cutRegions: [], mainSpeed: 2, segmentSpeeds: {},
    telopDataSource: '', titleDataSource: null, cutDataSource: null, seDataSource: null, insertImageDataSource: null,
  };
  return { p, state: { ...createEditState(p), telops: p.telops, titles: p.titles, nextTelopId: 2, nextTitleId: 2 } };
}

function show(kind: AssetKind, independent = true) {
  const { p, state } = fixture();
  const key = ASSET_KEYS[kind];
  if (independent) Object.assign(state[key][0]!, { timelinePlacement: { startFrame: 150, endFrame: 300 } });
  state.selection = { kind, id: 1 };
  const onEdit = vi.fn();
  const result = render(<Inspector state={state} finalModel={buildPlaybackModel(toEditorProject(state, p))}
    fps={30} seLibrary={[]} imageLibrary={[]} videoLibrary={[]} projectId="p1"
    telopPackInstalled videoInsertInstalled bgmInstalled shapeInstalled installing={null} installErrors={{}}
    dirty={false} componentRevision={null} previewWidth={1920} previewHeight={1080} onInstall={() => {}}
    onLive={() => {}} onEdit={onEdit} playerRef={{ current: null }} />);
  return { ...result, state, key, onEdit };
}

it.each(Object.keys(ASSET_KEYS) as AssetKind[])('finishing %s fields edit the same final placement without changing original anchors', kind => {
  const { getByLabelText, onEdit, key, state } = show(kind);
  const start = getByLabelText('開始（完成動画の秒）') as HTMLInputElement;
  const end = getByLabelText('終了（完成動画の秒）') as HTMLInputElement;
  expect(start.value).toBe('5'); expect(end.value).toBe('10');
  fireEvent.change(end, { target: { value: '11' } });
  fireEvent.keyDown(end, { key: 'Enter' });
  fireEvent.blur(end);
  expect(onEdit).toHaveBeenCalledTimes(1);
  const next = onEdit.mock.calls[0]![0];
  expect(next[key][0]).toMatchObject({ originalStart: 0, originalEnd: 120, timelinePlacement: { startFrame: 150, endFrame: 330 } });
  expect(next.cutRegions).toBe(state.cutRegions);
});

it('subvideo waveform shows the source window consumed at the effective main-video speed', () => {
  const { getByTestId, getByLabelText } = show('videoInsert', false);
  expect((getByLabelText('終了（完成動画の秒）') as HTMLInputElement).value).toBe('2');
  // Four source seconds at 1.5x consume 180 frames even when main speed
  // compresses the visible clip to two seconds (effective playback is 3x).
  expect(getByTestId('source-window').textContent).toBe('180');
});
