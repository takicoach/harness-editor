/**
 * @vitest-environment jsdom
 *
 * ドラッグ取り消し（Escape）で **選択が巻き添えで戻らない** ことの回帰テスト
 * （サイクル 4 レビュー Important）。
 *
 * 旧実装は `session.setTransient(preDragStateRef.current)` で EditState 全体を
 * pointerdown 直前へ戻していた。pre-drag スナップショットは `.tl-scroll` の
 * onPointerDownCapture（＝つまみの bubble ハンドラより先）で掴むので、
 * 「B を選択する前」＝ A が選択された状態が入っている。結果、Esc の後は
 * 画面上 A が選択枠なのに、矢印キーの対象（selectedHandle・useState）は B のまま
 * ＝ ←/→ が「選択していないテロップ」を動かしていた。
 *
 * ここは実 DOM のイベント順（pointerdown → pointermove → keydown(Escape) → keydown(ArrowRight)）
 * を通し、(a) 選択枠が B にあること (b) 矢印キーが動かす対象と選択が一致することを見る。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorProject, EditorTelop } from '../../core/types';
import type { EditState } from '../edit/editState';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';

vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

const FPS = 30;
const DURATION_FRAMES = 3000;

/** じまく 2 件（A=#1 / B=#2）。両方じまく行に並ぶ。 */
function makeProject(): EditorProject {
  const telops: EditorTelop[] = [
    { id: 1, originalStart: 100, originalEnd: 400, text: 'じまくA', template: 1 },
    { id: 2, originalStart: 500, originalEnd: 800, text: 'じまくB', template: 1 },
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

function makeFakePlayer(): PlayerRef {
  return {
    addEventListener() {},
    removeEventListener() {},
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
  const state: EditState = session.state;
  return (
    <div>
      <div data-testid="selection">
        {state.selection?.kind === 'telop' ? String(state.selection.id) : (state.selection?.kind ?? 'none')}
      </div>
      <div data-testid="timing">
        {JSON.stringify(state.telops.map((t) => [t.id, t.originalStart, t.originalEnd]))}
      </div>
      <Timeline
        session={session}
        baseProject={project}
        playerRef={playerRef}
        seLibrary={[]}
        imageLibrary={[]}
        videoLibrary={[]}
        videoDurations={{}}
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

function blocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.tl-track-jimaku .tl-telop'));
}
/** .tl-telop は data-id を持たないため、表示テキストから ID を引く（じまくA=1 / じまくB=2）。 */
const ID_BY_TEXT: Record<string, number> = { じまくA: 1, じまくB: 2 };
function selectedIds(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll('.tl-telop.selected')).map(
    (el) => ID_BY_TEXT[el.querySelector('.tl-telop-text')?.textContent ?? ''] ?? NaN,
  );
}
function timingOf(container: HTMLElement): [number, number, number][] {
  return JSON.parse(container.querySelector('[data-testid="timing"]')?.textContent ?? '[]');
}

afterEach(() => {
  cleanup();
});

describe('ドラッグ中の Escape（取り消し）と選択', () => {
  it('Esc の後も選択は掴んだテロップ B のまま（A へ戻らない）', () => {
    const { container } = render(<Harness project={makeProject()} />);
    const [a, b] = blocks(container) as [HTMLElement, HTMLElement];

    // ① A を純クリックで選択。
    fireEvent.pointerDown(a, { clientX: 400, clientY: 0, button: 0 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 0, button: 0 });
    expect(selectedIds(container)).toEqual([1]);

    // ② B を掴んでドラッグ開始（capture 相で pre-drag スナップショットが撮られる）。
    //    座標はトラック原点（ラベル溝）より右で動かす。原点より左だと 0 フレームに丸められ、
    //    動かしても「動いていない」のと区別できない。
    fireEvent.pointerDown(b, { clientX: 400, clientY: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 440, clientY: 0 });
    expect(selectedIds(container), 'ドラッグ開始で B が選択される').toEqual([2]);

    // ③ ドラッグ中に Escape。
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(selectedIds(container), 'Esc で選択が A へ巻き戻ってはいけない').toEqual([2]);
    expect(container.querySelector('[data-testid="selection"]')?.textContent).toBe('2');
  });

  it('Esc は掴んだ B の区間をドラッグ前へ戻し、その後の ←/→ は選択中の B を動かす', () => {
    const { container } = render(<Harness project={makeProject()} />);
    const [a, b] = blocks(container) as [HTMLElement, HTMLElement];
    const before = timingOf(container);

    fireEvent.pointerDown(a, { clientX: 400, clientY: 0, button: 0 });
    fireEvent.pointerUp(window, { clientX: 400, clientY: 0, button: 0 });

    const bLeftBefore = b.style.left;
    fireEvent.pointerDown(b, { clientX: 400, clientY: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 440, clientY: 0 });
    // 存在検査: ドラッグが生きている（ライブ表示で B の位置が動いている）。これが無いと
    // 「戻った」のか「そもそも動いていない」のか区別できない。
    expect(blocks(container)[1]!.style.left, 'ドラッグ中は B がライブで動く').not.toBe(bLeftBefore);
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(timingOf(container), 'Esc で B の区間はドラッグ前へ戻る').toEqual(before);
    // 取り消しの証明はここ: Esc の後に pointerup が来ても移動先を確定しない
    // （取り消しが無ければ pointerup で 40px ぶん動いた位置が確定し、B の区間が変わる）。
    fireEvent.pointerUp(window, { clientX: 440, clientY: 0, button: 0 });
    expect(timingOf(container), 'Esc の後の pointerup で確定してはいけない').toEqual(before);

    // ④ 続けて → を押す。動くのは「選択中の対象」＝ B（＝選択と矢印キーの対象が一致）。
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    const after = timingOf(container);
    expect(selectedIds(container)).toEqual([2]);
    expect(after.find((t) => t[0] === 2), 'B が 1 フレーム動く').toEqual([2, 501, 801]);
    expect(after.find((t) => t[0] === 1), '選択していない A は動かない').toEqual([1, 100, 400]);
  });
});
