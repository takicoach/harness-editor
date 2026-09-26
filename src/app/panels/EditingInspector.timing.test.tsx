/** @vitest-environment jsdom */
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditingInspector } from './EditingInspector';
import { ImageSettingsTab } from './inspector/ImageSettingsTab';
import type { EditState } from '../edit/editState';
import { toEditorProject } from '../edit/editState';
import type { EditorProject } from '../../core/types';
import { buildPlaybackModel } from '../../preview/playbackModel';

afterEach(cleanup);
function initialState(): EditState {
  return {
    telops: [], cutRegions: [], se: [], videoInserts: [], bgm: [], titles: [], shapes: [],
    images: [{ id: 1, originalStart: 0, originalEnd: 150, file: 'owned.png', type: 'photo' }],
    selection: { kind: 'image', id: 1 }, originalTotalFrames: 2700,
    multiTelopIds: [], nextTelopId: 1, nextSeId: 1, nextImageId: 2, nextVideoInsertId: 1,
    nextBgmId: 1, nextTitleId: 1, nextShapeId: 1, sceneTransitions: [], nextTransitionId: 1,
    ducking: { enabled: true, strength: 'mid' }, mainSpeed: 1, segmentSpeeds: {},
    segmentLayouts: {}, layoutKeyframes: [],
  };
}
function Harness() {
  const [state, setState] = useState(initialState);
  const [history, setHistory] = useState<EditState[]>([]);
  const base: EditorProject = { videoConfig: { format: 'youtube', fps: 30, durationFrames: 2700, videoFile: 'main.mp4', resolution: { width: 320, height: 180 }, orientation: 'landscape', titleStyle: { top: 10, left: 10, fontSize: 20 } }, projectConfig: null, transcript: { durationMs: 90000, words: [], segments: [] }, telops: [], titles: [], images: [], se: [], cutRegions: [], mainSpeed: 1, segmentSpeeds: {}, telopDataSource: '', cutDataSource: null, seDataSource: null, insertImageDataSource: null, titleDataSource: null };
  return <>
    <EditingInspector state={state} fps={30} model={buildPlaybackModel(toEditorProject(state, base))} onFinish={() => {}} onEdit={op => {
      const next = op(state);
      if (next !== state) { setHistory(prev => [...prev, state]); setState(next); }
    }} />
    <output data-testid="saved">{JSON.stringify(state.images[0])}</output>
    <output data-testid="history">{history.length}</output>
    <button onClick={() => { const prev = history.at(-1); if (prev) { setState(prev); setHistory(history.slice(0, -1)); } }}>Undo</button>
  </>;
}
function range() {
  const item = JSON.parse(screen.getByTestId('saved').textContent!);
  return item.timelinePlacement ? [item.timelinePlacement.startFrame, item.timelinePlacement.endFrame] : [item.originalStart, item.originalEnd];
}

it('0–5秒の画像を開始15秒→終了25秒の順に入力して、一度のUndoで戻せる', () => {
  render(<Harness />);
  const start = screen.getByLabelText('開始（完成動画の秒）');
  const end = screen.getByLabelText('終了（完成動画の秒）');
  fireEvent.change(start, { target: { value: '15' } });
  fireEvent.blur(start);
  expect(range()).toEqual([0, 150]);
  expect(screen.getByRole('alert').textContent).toContain('終了');
  fireEvent.change(end, { target: { value: '25' } });
  fireEvent.keyDown(end, { key: 'Enter' });
  fireEvent.blur(end);
  expect(range()).toEqual([450, 750]);
  expect(screen.getByTestId('history').textContent).toBe('1');
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect(range()).toEqual([0, 150]);
});

it('Escapeは未確定入力を破棄し、その後のblurでも変更しない', () => {
  render(<Harness />);
  const end = screen.getByLabelText('終了（完成動画の秒）');
  fireEvent.change(end, { target: { value: '25' } });
  fireEvent.keyDown(end, { key: 'Escape' });
  fireEvent.blur(end);
  expect(range()).toEqual([0, 150]);
  expect(screen.getByTestId('history').textContent).toBe('0');
  expect((screen.getByLabelText('終了（完成動画の秒）') as HTMLInputElement).value).toBe('5');
});

it('有効な開始時刻を確定しても、Tabの移動先である終了欄を破棄しない', () => {
  render(<Harness />);
  const start = screen.getByLabelText('開始（完成動画の秒）');
  const end = screen.getByLabelText('終了（完成動画の秒）');
  start.focus();
  fireEvent.change(start, { target: { value: '1' } });
  fireEvent.blur(start, { relatedTarget: end });
  // Tab resolves its next element before blur commits the first field.
  // Replacing this node makes the browser fall back to the document body.
  end.focus();
  expect(document.activeElement).toBe(screen.getByLabelText('終了（完成動画の秒）'));
  fireEvent.change(end, { target: { value: '8' } });
  fireEvent.keyDown(end, { key: 'Enter' });
  expect(range()).toEqual([30, 240]);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect((screen.getByLabelText('終了（完成動画の秒）') as HTMLInputElement).value).toBe('5');
  expect(range()).toEqual([30, 150]);
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  expect((screen.getByLabelText('開始（完成動画の秒）') as HTMLInputElement).value).toBe('0');
});

it('空欄や動画の範囲外はエラーを出し、保存内容を変えない', () => {
  render(<Harness />);
  const end = screen.getByLabelText('終了（完成動画の秒）');
  for (const value of ['', '100']) {
    fireEvent.change(end, { target: { value } });
    fireEvent.blur(end);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(range()).toEqual([0, 150]);
  }
});

it('仕上げの見出しで463–755フレームを15–25秒へ丸めて見せない', () => {
  const state = initialState();
  const image = { ...state.images[0]!, originalStart: 463, originalEnd: 755 };
  render(<ImageSettingsTab image={image} state={state} fps={30} imageLibrary={['owned.png']} onEdit={() => {}} />);
  const header = screen.getByText(/原素材 15\.433333–25\.166667 秒/);
  expect(header.textContent).toContain('463–755 フレーム（終了は含まない）');
});
