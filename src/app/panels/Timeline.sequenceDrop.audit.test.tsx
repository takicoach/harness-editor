// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRef, useRef, useState, type Ref } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject } from '../../core/types';
import { buildPlaybackModel } from '../../preview/playbackModel';
import { useEditSession } from '../useEditSession';
import { Timeline, type TimelineDropApi } from './Timeline';

vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));
vi.mock('../timeline/Waveform', () => ({ Waveform: () => null }));

function project(): EditorProject {
  return {
    videoConfig: {
      format: 'short', fps: 30, durationFrames: 180, videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 }, orientation: 'portrait',
      titleStyle: { top: 100, left: 60, fontSize: 60 },
    },
    projectConfig: null,
    transcript: { durationMs: 6000, words: [], segments: [] },
    telops: [{ id: 1, originalStart: 10, originalEnd: 50, text: '字幕', template: 1 }],
    cutRegions: [{ start: 60, end: 120 }], se: [], images: [],
    telopDataSource: 'export const telopData = [];\n', cutDataSource: null,
    seDataSource: null, insertImageDataSource: null, titles: [], titleDataSource: null,
    cutOrder: [{ originalStart: 120, originalEnd: 180 }, { originalStart: 0, originalEnd: 60 }],
    mainSpeed: 1, segmentSpeeds: {},
  };
}

function fakePlayer(): PlayerRef {
  return {
    addEventListener() {}, removeEventListener() {}, seekTo() {}, getCurrentFrame: () => 0,
    play() {}, pause() {}, isPlaying: () => false,
  } as unknown as PlayerRef;
}

const BASE = project();

function Harness({ dropRef, initialView = 'cut' }: { dropRef: Ref<TimelineDropApi>; initialView?: 'cut' | 'detail' }) {
  const session = useEditSession('audit', BASE, null);
  const playerRef = useRef<PlayerRef | null>(fakePlayer());
  const [rate, setRate] = useState(1);
  const [view, setView] = useState<'cut' | 'detail'>(initialView);
  if (!session) return null;
  const model = buildPlaybackModel({ ...BASE, images: session.state.images });
  return <>
    <output data-testid="image-start">{session.state.images[0]?.originalStart ?? 'none'}</output>
    <output data-testid="telop-start">{session.state.telops[0]?.originalStart ?? 'none'}</output>
    <button data-testid="switch-to-cut" onClick={() => setView('cut')}>edit</button>
    <Timeline view={view} session={session} baseProject={BASE} playerRef={playerRef}
      finalDurationFrames={model.durationInFrames} finalPlaybackModel={model} dropApiRef={dropRef}
      seLibrary={[]} imageLibrary={[]} videoLibrary={[]} bgmLibrary={[]} videoUrl="" projectId="audit"
      highlightRange={null} onHighlightRange={() => {}} speedSegments={null}
      cutsBypassed={false} onToggleCutsBypassed={() => {}} playbackRate={rate} onPlaybackRateChange={setRate} />
  </>;
}

afterEach(cleanup);

describe('completed-sequence material drop independent audit', () => {
  it('places a dropped asset into the source clip shown at that final coordinate after reordering', () => {
    const dropRef = createRef<TimelineDropApi>();
    const { container, getByTestId } = render(<Harness dropRef={dropRef} />);
    const body = container.querySelector<HTMLElement>('.tl-body')!;
    const scroll = container.querySelector<HTMLElement>('.tl-scroll')!;
    vi.spyOn(body, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, top: 0, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON() {} });
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 1000, top: 0, bottom: 500, width: 1000, height: 500, x: 0, y: 0, toJSON() {} });

    act(() => { expect(dropRef.current?.dropMaterial('image', 'still.png', 98, 20)).toBe(true); });
    expect(getByTestId('image-start').textContent).toBe('130');
  });

  it('clears a hidden detail handle when switching to the completed editing sequence', () => {
    const dropRef = createRef<TimelineDropApi>();
    const { container, getByTestId } = render(<Harness dropRef={dropRef} initialView="detail" />);
    const handle = container.querySelector<HTMLElement>('.tl-track-jimaku .tl-handle.start')!;
    fireEvent.pointerDown(handle, { clientX: 100, button: 0 });
    fireEvent.pointerUp(window, { clientX: 100, button: 0 });
    fireEvent.click(getByTestId('switch-to-cut'));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(getByTestId('telop-start').textContent).toBe('10');
  });
});
