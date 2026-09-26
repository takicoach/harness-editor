/**
 * @vitest-environment jsdom
 *
 * 監査 interaction-1（Critical）の回帰テスト。
 *
 * タイムラインの window keydown は画面の一番後ろで待ち構えているため、書き出し
 * ダイアログ・ヘルプ・チュートリアル・差分レビューを開いたまま押した Delete / B が
 * **見えないタイムライン**に届き、破壊的な編集が入っていた。
 * ここでは「モーダル相当の要素が DOM にある間、Delete と B が EditState を変えない」
 * ことだけを固定する（モーダルを閉じれば従来どおり効くことも併せて確認する）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
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
    { id: 11, originalStart: 1400, originalEnd: 1700, text: '飾りB', template: 5, manual: true },
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

function makeFakePlayer(): PlayerRef & { emitFrame: (frame: number) => void } {
  const listeners = new Map<string, Set<Listener>>();
  const player = {
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
    emitFrame(frame: number) {
      for (const fn of listeners.get('frameupdate') ?? []) fn({ detail: { frame } });
    },
  };
  return player as unknown as PlayerRef & { emitFrame: (frame: number) => void };
}

let fakePlayer: ReturnType<typeof makeFakePlayer>;

function Harness({ project }: { project: EditorProject }) {
  const session = useEditSession('p1', project, null);
  const playerRef = useRef<PlayerRef | null>(fakePlayer);
  const [playbackRate, setPlaybackRate] = useState(1);
  if (session === null) return null;
  return (
    <div>
      <div data-testid="cuts">{JSON.stringify(session.state.cutRegions)}</div>
      <div data-testid="ids">{JSON.stringify(session.state.telops.map((t) => t.id))}</div>
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

/** モーダル相当（書き出しダイアログ）を DOM へ置く。戻り値で片付ける。 */
function openModal(className = 'export-overlay'): () => void {
  const overlay = document.createElement('div');
  overlay.className = className;
  document.body.appendChild(overlay);
  return () => overlay.remove();
}

function cutsOf(c: HTMLElement): { start: number; end: number }[] {
  return JSON.parse(c.querySelector('[data-testid="cuts"]')?.textContent ?? '[]');
}
function idsOf(c: HTMLElement): number[] {
  return JSON.parse(c.querySelector('[data-testid="ids"]')?.textContent ?? '[]');
}

/** カット行をドラッグして範囲選択帯を作る。 */
function dragCutSelection(container: HTMLElement): void {
  const track = container.querySelector('.tl-track-cut');
  expect(track).not.toBeNull();
  fireEvent.pointerDown(track as HTMLElement, { clientX: 10, clientY: 0, button: 0 });
  fireEvent.pointerMove(window, { clientX: 200, clientY: 0 });
  fireEvent.pointerUp(window, { clientX: 200, clientY: 0 });
}

function manualBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.tl-track-telop .tl-telop'));
}

function clickBlock(block: HTMLElement, mods: { metaKey?: boolean } = {}): void {
  fireEvent.pointerDown(block, { clientX: 0, clientY: 0, button: 0, ...mods });
  fireEvent.pointerUp(window, { clientX: 0, clientY: 0, button: 0, ...mods });
}

function setup() {
  fakePlayer = makeFakePlayer();
  return render(<Harness project={makeProject()} />);
}

afterEach(() => {
  cleanup();
  for (const el of Array.from(document.querySelectorAll('.export-overlay, .preference-overlay'))) el.remove();
});

describe.each(['export-overlay', 'preference-overlay'])('%s 表示中はタイムラインの破壊的キーが効かない', (modalClass) => {
  it('範囲選択したまま書き出しダイアログを開いて Delete を押してもカットされない', () => {
    const { container } = setup();
    dragCutSelection(container);
    expect(cutsOf(container)).toEqual([]);

    const close = openModal(modalClass);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(cutsOf(container)).toEqual([]);

    // モーダルを閉じれば従来どおりカットが確定する（ガードが常時無効化ではないことの証拠）。
    close();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(cutsOf(container).length).toBe(1);
  });

  it('テロップを複数選択したまま Delete を押しても消えない', () => {
    const { container } = setup();
    const blocks = manualBlocks(container);
    clickBlock(blocks[0] as HTMLElement);
    clickBlock(blocks[1] as HTMLElement, { metaKey: true });
    expect(idsOf(container)).toEqual([1, 10, 11]);

    const close = openModal(modalClass);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(idsOf(container)).toEqual([1, 10, 11]);

    close();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(idsOf(container)).toEqual([1]);
  });

  it('B（テロップ分割）もモーダル表示中は効かない', () => {
    const { container } = setup();
    // 再生ヘッドをテロップ #1 の内側（原本フレーム 200）へ置く。
    act(() => fakePlayer.emitFrame(200));
    const before = idsOf(container);

    const close = openModal(modalClass);
    fireEvent.keyDown(window, { key: 'b' });
    expect(idsOf(container)).toEqual(before);

    // 閉じれば分割が効く＝ガードが「常に無効」ではないことの証拠。
    close();
    fireEvent.keyDown(window, { key: 'b' });
    expect(idsOf(container).length).toBe(before.length + 1);
  });
});
