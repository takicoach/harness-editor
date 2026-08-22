/**
 * @vitest-environment jsdom
 *
 * ＋追加メニュー「字幕」の UI レベル結線テスト。
 * 設計書: docs/specs/2026-08-20-edge-autoscroll-add-subtitle-design.md
 *
 * 区間クランプ・no-op・継承の純ロジックは cutOps.test.ts が担う。ここは
 * **メニュー項目 → addSubtitleAtFrame → 状態反映**の結線と、追加できなかったときに
 * ブラウザダイアログではなく既存の一時メッセージ（.tl-tool-hint）で知らせるかだけを見る。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorProject, EditorTelop } from '../../core/types';
import type { EditState } from '../edit/editState';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';

vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

const FPS = 30;
const DURATION_FRAMES = 3000;

function makeProject(telops: EditorTelop[]): EditorProject {
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
  const state: EditState = session.state;
  return (
    <div>
      <div data-testid="telops">
        {JSON.stringify(
          state.telops.map((t) => ({
            id: t.id,
            start: t.originalStart,
            end: t.originalEnd,
            text: t.text,
            manual: t.manual ?? null,
            template: t.template ?? null,
          })),
        )}
      </div>
      <div data-testid="selection">
        {state.selection?.kind === 'telop' ? String(state.selection.id) : (state.selection?.kind ?? 'none')}
      </div>
      <Timeline
        videoDurations={{}}
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

interface TelopRow {
  id: number;
  start: number;
  end: number;
  text: string;
  manual: boolean | null;
  template: number | null;
}

function telopsOf(c: HTMLElement): TelopRow[] {
  return JSON.parse(c.querySelector('[data-testid="telops"]')?.textContent ?? '[]') as TelopRow[];
}
function selectionOf(c: HTMLElement): string {
  return c.querySelector('[data-testid="selection"]')?.textContent ?? '';
}

function setup(telops: EditorTelop[]) {
  fakePlayer = makeFakePlayer();
  return render(<Harness project={makeProject(telops)} />);
}

/** 再生ヘッドを原本フレーム frame へ移す（cutRegions 空なので再生＝原本）。 */
function movePlayhead(frame: number): void {
  act(() => {
    fakePlayer.emitFrame(frame);
  });
}

function openAddMenu(container: HTMLElement): void {
  fireEvent.click(container.querySelector('.tl-add-menu-btn') as HTMLElement);
}

function clickSubtitleAdd(container: HTMLElement): void {
  fireEvent.click(container.querySelector('.tl-subtitle-add') as HTMLElement);
}

afterEach(() => {
  cleanup();
});

describe('＋追加メニューの「字幕」', () => {
  it('再生ヘッド位置に manual なしの字幕を追加して選択する', () => {
    const { container } = setup([
      { id: 1, originalStart: 100, originalEnd: 400, text: 'A', template: 7 },
      { id: 2, originalStart: 1500, originalEnd: 1800, text: 'B', template: 7 },
    ]);
    movePlayhead(600);
    openAddMenu(container);
    clickSubtitleAdd(container);

    const telops = telopsOf(container);
    expect(telops).toHaveLength(3);
    const added = telops.find((t) => t.text === '新しい字幕');
    expect(added).toMatchObject({ start: 600, end: 690, manual: null, template: 7 });
    expect(selectionOf(container)).toBe(String(added?.id));
    // 追加できたときはヒントを出さない。
    expect(container.querySelector('.tl-tool-hint')).toBeNull();
  });

  it('追加した字幕は「じまく」行に描かれる（飾りテロップ行ではない）', () => {
    const { container } = setup([{ id: 1, originalStart: 100, originalEnd: 400, text: 'A' }]);
    movePlayhead(600);
    openAddMenu(container);
    clickSubtitleAdd(container);

    const jimaku = container.querySelectorAll('.tl-track-jimaku .tl-telop');
    const manual = container.querySelectorAll('.tl-track-telop .tl-telop');
    expect(jimaku).toHaveLength(2);
    expect(manual).toHaveLength(0);
  });

  it('隙間が足りない位置ではダイアログを出さず一時メッセージで知らせる（no-op）', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const { container } = setup([
      { id: 1, originalStart: 100, originalEnd: 400, text: 'A' },
      { id: 2, originalStart: 405, originalEnd: 800, text: 'B' },
    ]);
    movePlayhead(200); // #1 の内側 → 空きは [400,405] の 5 フレームのみ。
    openAddMenu(container);
    clickSubtitleAdd(container);

    expect(telopsOf(container)).toHaveLength(2);
    expect(alertSpy).not.toHaveBeenCalled();
    const hint = container.querySelector('.tl-tool-hint');
    expect(hint?.textContent).toBe('ここには字幕を追加できません（既存の字幕と重なります）');
    alertSpy.mockRestore();
  });

  it('ヘッドが既存字幕の内側なら直後の空きへ寄せて追加し、ずらしたことを知らせる', () => {
    const { container } = setup([
      { id: 1, originalStart: 100, originalEnd: 400, text: 'A', template: 7 },
      { id: 2, originalStart: 1500, originalEnd: 1800, text: 'B', template: 7 },
    ]);
    movePlayhead(200); // #1 の内側。
    openAddMenu(container);
    clickSubtitleAdd(container);

    const added = telopsOf(container).find((t) => t.text === '新しい字幕');
    // #1 の直後から既定 3 秒ぶん（寄せたぶん尺が痩せない）。
    expect(added).toMatchObject({ start: 400, end: 490, manual: null });
    // 押した位置と違う場所に出るので、黙ってずらさず一時メッセージで知らせる。
    expect(container.querySelector('.tl-tool-hint')?.textContent).toBe('直前の字幕の直後に追加しました');
  });

  it('メニュー内で「字幕」は「テロップ」より上にある', () => {
    const { container } = setup([{ id: 1, originalStart: 100, originalEnd: 400, text: 'A' }]);
    openAddMenu(container);
    const labels = Array.from(container.querySelectorAll('.dd-menu .dd-item')).map(
      (el) => el.textContent ?? '',
    );
    expect(labels).toContain('字幕');
    expect(labels.indexOf('字幕')).toBeLessThan(labels.indexOf('テロップ'));
  });

  it('追加後はメニューが閉じる', () => {
    const { container } = setup([{ id: 1, originalStart: 100, originalEnd: 400, text: 'A' }]);
    movePlayhead(600);
    openAddMenu(container);
    clickSubtitleAdd(container);
    expect(container.querySelector('.dd-menu')).toBeNull();
  });
});
