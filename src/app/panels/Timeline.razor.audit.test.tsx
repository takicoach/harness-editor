// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject } from '../../core/types';
import { buildPlaybackModel } from '../../preview/playbackModel';
import { toEditorProject } from '../edit/editState';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';

vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));
vi.mock('../timeline/Waveform', () => ({ Waveform: () => null }));

const PROJECT: EditorProject = {
  videoConfig: { format: 'short', fps: 30, durationFrames: 180, videoFile: 'main.mp4', resolution: { width: 1080, height: 1920 }, orientation: 'portrait', titleStyle: { top: 100, left: 60, fontSize: 60 } },
  projectConfig: null,
  transcript: { durationMs: 6000, words: [], segments: [] },
  telops: [], cutRegions: [], se: [], images: [], titles: [],
  telopDataSource: 'export const telopData = [];\n', cutDataSource: null, seDataSource: null, insertImageDataSource: null, titleDataSource: null,
  mainSpeed: 1, segmentSpeeds: {},
};

type Listener = (event: unknown) => void;
function player() {
  let frame = 0;
  const listeners = new Set<Listener>();
  return {
    ref: {
      addEventListener(type: string, listener: Listener) { if (type === 'frameupdate') listeners.add(listener); },
      removeEventListener(type: string, listener: Listener) { if (type === 'frameupdate') listeners.delete(listener); },
      seekTo(next: number) { frame = next; }, getCurrentFrame: () => frame,
      play() {}, pause() {}, isPlaying: () => false,
    } as unknown as PlayerRef,
    emit(next: number) { frame = next; for (const listener of listeners) listener({ detail: { frame: next } }); },
  };
}

function Harness({ editable = true }: { editable?: boolean }) {
  const session = useEditSession('audit', PROJECT, null);
  const playback = useRef(player());
  const [rate, setRate] = useState(1);
  if (!session) return null;
  const model = buildPlaybackModel(toEditorProject(session.state, PROJECT));
  return <>
    <div data-testid="anchor-count">{session.state.cutOrder?.length ?? 0}</div>
    <div data-testid="can-undo">{String(session.canUndo)}</div>
    <div data-testid="cut-ranges">{JSON.stringify(session.state.cutRegions)}</div>
    <button type="button" onClick={session.undo}>audit undo</button>
    <button type="button" onClick={() => act(() => playback.current.emit(60))}>head 60</button>
    <textarea aria-label="audit input" />
    <Timeline allowRangeCut={editable} view="cut" finalDurationFrames={model.durationInFrames} finalPlaybackModel={model}
      session={session} baseProject={PROJECT} playerRef={{ current: playback.current.ref }} seLibrary={[]} imageLibrary={[]}
      videoLibrary={[]} bgmLibrary={[]} videoUrl="" projectId="audit" highlightRange={null} onHighlightRange={() => {}}
      speedSegments={model.speedSegments} cutsBypassed={false} onToggleCutsBypassed={() => {}}
      playbackRate={rate} onPlaybackRateChange={setRate} />
  </>;
}

afterEach(() => { cleanup(); document.querySelector('.export-overlay')?.remove(); });

describe('razor/add-edit independent audit', () => {
  it('shows the nearby cut action only after sweeping and commits one undoable cut', () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId('timeline-sweep-tool'));
    const surface = screen.getByTestId('timeline-sweep-surface');
    surface.setPointerCapture = vi.fn();
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      fireEvent(surface, event);
    };
    pointer('pointerdown', 120);
    pointer('pointermove', 150);
    expect(screen.queryByTestId('timeline-sweep-cut')).toBeNull();
    pointer('pointerup', 150);
    const button = screen.getByTestId('timeline-sweep-cut');
    expect(button.closest('[data-testid="timeline-cut-sequence"]')).not.toBeNull();
    expect(screen.getByTestId('can-undo').textContent).toBe('false');
    fireEvent.click(button);
    expect(screen.queryByTestId('timeline-sweep-cut')).toBeNull();
    expect(screen.getByTestId('cut-ranges').textContent).not.toBe('[]');
    expect(screen.getByTestId('can-undo').textContent).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'audit undo' }));
    expect(screen.getByTestId('cut-ranges').textContent).toBe('[]');
    expect(screen.getByTestId('can-undo').textContent).toBe('false');
    pointer('pointerdown', 150);
    pointer('pointerup', 120);
    expect(screen.getByTestId('timeline-sweep-cut')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('timeline-sweep-cut')).toBeNull();
    expect(screen.getByTestId('can-undo').textContent).toBe('false');
  });

  it.each([
    ['Meta+K', { metaKey: true }],
    ['Ctrl+K', { ctrlKey: true }],
  ])('keeps a boundary %s out of history and a valid add-edit as exactly one undo step', (_label, modifier) => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByTestId('timeline-razor-tool').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'v' });
    expect(screen.getByTestId('timeline-razor-tool').getAttribute('aria-pressed')).toBe('false');

    fireEvent.keyDown(window, { key: 'k', ...modifier });
    expect(screen.getByTestId('anchor-count').textContent).toBe('0');
    expect(screen.getByTestId('can-undo').textContent).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'head 60' }));
    fireEvent.keyDown(window, { key: 'k', ...modifier });
    expect(screen.getByTestId('anchor-count').textContent).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'audit undo' }));
    expect(screen.getByTestId('anchor-count').textContent).toBe('0');
    expect(screen.getByTestId('can-undo').textContent).toBe('false');
  });

  it('ignores repeat, text input, modal, and a non-editable timeline', () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'head 60' }));
    fireEvent.keyDown(window, { key: 'k', metaKey: true, repeat: true });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'audit input' }), { key: 'k', metaKey: true });
    const modal = document.createElement('div'); modal.className = 'export-overlay'; document.body.appendChild(modal);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('anchor-count').textContent).toBe('0');
    modal.remove();

    rerender(<Harness editable={false} />);
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.queryByTestId('timeline-razor-tool')).toBeNull();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(screen.getByTestId('anchor-count').textContent).toBe('0');
  });
});
