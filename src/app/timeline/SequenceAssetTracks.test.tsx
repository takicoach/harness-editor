/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildPlaybackModel } from '../../preview/playbackModel';
import type { EditorProject } from '../../core/types';
import { SequenceAssetTracks } from './SequenceAssetTracks';
import { TRACK_LABEL_GUTTER_PX as GUTTER } from './timelineGeometry';

afterEach(cleanup);
function setup() {
  const project: EditorProject = { videoConfig: { format: 'youtube', fps: 30, durationFrames: 120, videoFile: 'main.mp4', resolution: { width: 320, height: 180 }, orientation: 'landscape', titleStyle: { top: 10, left: 10, fontSize: 20 } }, projectConfig: null, transcript: { durationMs: 4000, words: [], segments: [] }, telops: [], titles: [], images: [], se: [], cutRegions: [], mainSpeed: 1, segmentSpeeds: {}, telopDataSource: '', cutDataSource: null, seDataSource: null, insertImageDataSource: null, titleDataSource: null };
  project.images = [{ id: 1, file: 'a.png', type: 'photo', originalStart: 10, originalEnd: 30 }];
  const onPlace = vi.fn(), onSelect = vi.fn();
  render(<SequenceAssetTracks model={buildPlaybackModel(project)} pxPerFrame={2} playerFrame={0} selection={null} onSelect={onSelect} onPlace={onPlace} />);
  return { onPlace, onSelect, body: screen.getByTestId('sequence-asset-image-1') };
}
function pointer(type: string, x: number) {
  fireEvent(window, new MouseEvent(type, { clientX: x, clientY: 100, bubbles: true, button: 0 }));
}
function down(target: Element, x: number) { fireEvent(target, new MouseEvent('pointerdown', { clientX: x, clientY: 100, bubbles: true, button: 0 })); }
it('a click selects at the readable midpoint without a time edit', () => {
  const { body, onSelect, onPlace } = setup();
  down(body, GUTTER + 40); pointer('pointerup', GUTTER + 40);
  expect(onPlace).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenLastCalledWith({ kind: 'image', id: 1 }, 19);
});
it('body dragging commits one relative movement and preserves duration', () => {
  const { body, onPlace } = setup();
  down(body, GUTTER + 40); pointer('pointermove', GUTTER + 70); pointer('pointerup', GUTTER + 70);
  expect(onPlace).toHaveBeenCalledTimes(1);
  expect(onPlace).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 25, 45, 'move');
});
it.each(['Escape', 'pointercancel'])('%s discards a pending drag', cancel => {
  const { body, onPlace } = setup();
  down(body, GUTTER + 40); pointer('pointermove', GUTTER + 70);
  if (cancel === 'Escape') fireEvent.keyDown(window, { key: 'Escape' }); else pointer('pointercancel', GUTTER + 70);
  pointer('pointerup', GUTTER + 70);
  expect(onPlace).not.toHaveBeenCalled();
});
it('end handle changes only the end', () => {
  const { onPlace } = setup();
  down(screen.getByTestId('sequence-trim-end-image-1'), GUTTER + 60);
  pointer('pointermove', GUTTER + 80); pointer('pointerup', GUTTER + 80);
  expect(onPlace).toHaveBeenCalledWith(expect.anything(), 10, 40, 'trim-end');
});
