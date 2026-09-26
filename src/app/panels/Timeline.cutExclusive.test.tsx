/**
 * @vitest-environment jsdom
 *
 * 範囲選択カットの帯とクリップ選択の相互排他（サイクル 4 Codex 指摘 P1）。
 *
 * 帯を引いたあとにテロップを選んで Delete を押すと、テロップではなく以前の帯が
 * カットされていた（Delete の keydown は帯側の effect が先に効き、クリップ側は
 * `cutSelection !== null` の間 譲るため、帯が残る限り届かない）。
 * ここでは「キーボード選択（Tab→Enter）」と「クリック選択」の両方で、
 * 選んだテロップだけが消えて cutRegions が増えないことを見る。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject, EditorTelop } from '../../core/types';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';

vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

const FPS = 30;
const DURATION_FRAMES = 3000;

function makeProject(): EditorProject {
  const telops: EditorTelop[] = [
    { id: 1, originalStart: 100, originalEnd: 400, text: 'じまくA', template: 1 },
    { id: 10, originalStart: 1000, originalEnd: 1300, text: '飾りA', template: 5, manual: true },
  ];
  return {
    videoConfig: {
      format: 'short',
      fps: FPS,
      durationFrames: DURATION_FRAMES,
      videoFile: 'main.mp4',
      resolution: { width: 1080, height: 1920 },
      orientation: 'portrait',
      titleStyle: { top: 100, left: 60, fontSize: 60 },
    },
    projectConfig: null,
    transcript: { durationMs: (DURATION_FRAMES / FPS) * 1000, words: [], segments: [] },
    telops,
    cutRegions: [],
    se: [],
    images: [],
    telopDataSource: 'export const telopData = [];\n',
    cutDataSource: null,
    seDataSource: null,
    insertImageDataSource: null,
    titles: [],
    titleDataSource: null,
    mainSpeed: 1,
    segmentSpeeds: {},
  };
}

type Listener = (e: unknown) => void;

function makeFakePlayer(): PlayerRef {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type: string, fn: Listener) {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    seekTo() {},
    getCurrentFrame: () => 0,
    play() {},
    pause() {},
    isPlaying: () => false,
  } as unknown as PlayerRef;
}

function Harness({ project }: { project: EditorProject }) {
  const session = useEditSession('p1', project, null);
  const playerRef = useRef<PlayerRef | null>(makeFakePlayer());
  const [playbackRate, setPlaybackRate] = useState(1);
  if (session === null) return null;
  return (
    <div>
      <div data-testid="ids">{JSON.stringify(session.state.telops.map((t) => t.id))}</div>
      <div data-testid="cuts">{JSON.stringify(session.state.cutRegions)}</div>
      <Timeline
        session={session}
        baseProject={project}
        playerRef={playerRef}
        seLibrary={[]}
        imageLibrary={[]}
        videoLibrary={[]}
        bgmLibrary={[]}
        videoUrl=""
        projectId="p1"
        highlightRange={null}
        onHighlightRange={() => {}}
        speedSegments={null}
        cutsBypassed={false}
        onToggleCutsBypassed={() => {}}
        playbackRate={playbackRate}
        onPlaybackRateChange={setPlaybackRate}
      />
    </div>
  );
}

function idsOf(c: HTMLElement): number[] {
  return JSON.parse(c.querySelector('[data-testid="ids"]')?.textContent ?? '[]') as number[];
}
function cutsOf(c: HTMLElement): unknown[] {
  return JSON.parse(c.querySelector('[data-testid="cuts"]')?.textContent ?? '[]') as unknown[];
}

/** 動画トラック背景をドラッグして範囲選択の帯を引く。 */
function dragCutRange(container: HTMLElement): void {
  const cutTrack = container.querySelector('.tl-track-cut');
  expect(cutTrack).not.toBeNull();
  fireEvent.pointerDown(cutTrack as HTMLElement, { clientX: 10, clientY: 0, button: 0 });
  fireEvent.pointerMove(window, { clientX: 120, clientY: 0 });
  fireEvent.pointerUp(window, { clientX: 120, clientY: 0 });
  // 帯が実在することを先に確かめる（空の状態で「消えた」を見てしまわないため）。
  expect(container.querySelector('.tl-cut-selection')).not.toBeNull();
}

afterEach(cleanup);

describe('範囲選択カットの帯とクリップ選択の相互排他', () => {
  it('帯 → Enter でテロップ選択 → Delete は、テロップだけを消して帯のカットを起こさない', () => {
    const { container } = render(<Harness project={makeProject()} />);
    dragCutRange(container);

    const clip = container.querySelector('[data-testid="clip-telop-10"]') as HTMLElement;
    expect(clip).not.toBeNull();
    fireEvent.keyDown(clip, { key: 'Enter' });
    // キーボード選択の時点で帯は消えている（Delete の宛先が 1 つに定まる）。
    expect(container.querySelector('.tl-cut-selection')).toBeNull();

    fireEvent.keyDown(clip, { key: 'Delete' });
    expect(idsOf(container)).toEqual([1]);
    expect(cutsOf(container)).toEqual([]);
  });

  it('帯 → クリックでテロップ選択 → Delete も同じ（マウス経路も揃える）', () => {
    const { container } = render(<Harness project={makeProject()} />);
    dragCutRange(container);

    const clip = container.querySelector('[data-testid="clip-telop-10"]') as HTMLElement;
    fireEvent.pointerDown(clip, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0, button: 0 });
    expect(container.querySelector('.tl-cut-selection')).toBeNull();

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(idsOf(container)).toEqual([1]);
    expect(cutsOf(container)).toEqual([]);
  });
});
