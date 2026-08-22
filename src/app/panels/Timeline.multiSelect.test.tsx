/**
 * @vitest-environment jsdom
 *
 * テロップ・字幕の複数選択と一括調整の UI レベル回帰テスト。
 * 設計書: docs/specs/2026-08-18-telop-multiselect-design.md
 *
 * 純ロジック（ops / normalizeMultiSelection）の検証は telopSettingsOps.test.ts と
 * editState.test.ts が担う。ここは **実 React の pointerdown → pointermove → pointerup →
 * keydown の順序を通した結線**（修飾キー判定・純クリック判定・Inspector 出し分け・
 * 範囲選択カットとの相互排他）だけを見る。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorProject, EditorTelop } from '../../core/types';
import type { EditState } from '../edit/editState';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';
import { Inspector } from './Inspector';

// スタイル選択グリッドは @remotion/player の Thumbnail を実描画するため jsdom では重い。
// 本テストの対象（選択の結線）とは無関係なので描画だけ差し替える。
vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

const FPS = 30;
const DURATION_FRAMES = 3000;

/** 字幕 2 件（#1 #2）＋ 飾りテロップ 2 件（#10 #11）＋ SE 1 件。 */
function makeProject(): EditorProject {
  const telops: EditorTelop[] = [
    { id: 1, originalStart: 100, originalEnd: 400, text: 'じまくA', template: 1 },
    { id: 2, originalStart: 500, originalEnd: 800, text: 'じまくB', template: 1 },
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
    se: [{ id: 1, originalStart: 2000, originalEnd: 2090, file: 'pop.mp3' }],
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

/** frameupdate を任意に発火できる最小プレイヤー。 */
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
      <div data-testid="selection">
        {state.selection?.kind === 'telop' ? String(state.selection.id) : (state.selection?.kind ?? 'none')}
      </div>
      <div data-testid="multi">{JSON.stringify(state.multiTelopIds)}</div>
      <div data-testid="telops">
        {JSON.stringify(
          state.telops.map((t) => ({ id: t.id, pos: t.position ?? null, scale: t.scale ?? null })),
        )}
      </div>
      <div data-testid="ids">{JSON.stringify(state.telops.map((t) => t.id))}</div>
      <div data-testid="can-undo">{String(session.canUndo)}</div>
      <button data-testid="undo" onClick={session.undo}>undo</button>
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
      <Inspector
        videoDurations={{}}
        state={state}
        fps={FPS}
        seLibrary={[]}
        imageLibrary={[]}
        videoLibrary={[]}
        projectId="p1"
        telopPackInstalled={false}
        videoInsertInstalled={false}
        installing={null}
        installErrors={{}}
        dirty={session.dirty}
        telopComponent={null}
        previewWidth={1080}
        previewHeight={1920}
        onInstall={() => {}}
        onLive={session.setTransient}
        onEdit={session.apply}
        playerRef={playerRef}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 操作ヘルパ（すべて実 DOM イベント）
// ---------------------------------------------------------------------------

interface Mods {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

function jimakuBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.tl-track-jimaku .tl-telop'));
}
function manualBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.tl-track-telop .tl-telop'));
}

/** ブロック本体を「動かさずに」クリックする（純クリック）。 */
function clickBlock(block: HTMLElement, mods: Mods = {}): void {
  fireEvent.pointerDown(block, { clientX: 0, clientY: 0, button: 0, ...mods });
  fireEvent.pointerUp(window, { clientX: 0, clientY: 0, button: 0, ...mods });
}

/** ブロック本体を掴んで dx px 動かしてから離す（ドラッグ確定）。 */
function dragBlock(block: HTMLElement, dx: number, mods: Mods = {}): void {
  fireEvent.pointerDown(block, { clientX: 0, clientY: 0, button: 0, ...mods });
  fireEvent.pointerMove(window, { clientX: dx, clientY: 0, ...mods });
  fireEvent.pointerUp(window, { clientX: dx, clientY: 0, ...mods });
}

function selectionOf(c: HTMLElement): string {
  return c.querySelector('[data-testid="selection"]')?.textContent ?? '';
}
function multiOf(c: HTMLElement): number[] {
  return JSON.parse(c.querySelector('[data-testid="multi"]')?.textContent ?? '[]') as number[];
}
function idsOf(c: HTMLElement): number[] {
  return JSON.parse(c.querySelector('[data-testid="ids"]')?.textContent ?? '[]') as number[];
}
function telopsOf(c: HTMLElement): { id: number; pos: { x: number; y: number } | null; scale: number | null }[] {
  return JSON.parse(c.querySelector('[data-testid="telops"]')?.textContent ?? '[]');
}

function setup() {
  fakePlayer = makeFakePlayer();
  return render(<Harness project={makeProject()} />);
}

/** #1 と #2（じまく 2 件）を複数選択した状態にする。 */
function selectTwoSubtitles(container: HTMLElement): void {
  const blocks = jimakuBlocks(container);
  clickBlock(blocks[0] as HTMLElement);
  clickBlock(blocks[1] as HTMLElement, { metaKey: true });
}

afterEach(() => {
  cleanup();
});

describe('修飾キー＋クリックでの複数選択トグル', () => {
  it('Cmd＋クリックで 2 個選択になり、最後にクリックした方がプライマリ', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    expect(multiOf(container)).toEqual([1, 2]);
    expect(selectionOf(container)).toBe('2');
  });

  it('Ctrl＋クリックでもトグルできる（Windows）', () => {
    const { container } = setup();
    const blocks = jimakuBlocks(container);
    clickBlock(blocks[0] as HTMLElement);
    clickBlock(blocks[1] as HTMLElement, { ctrlKey: true });
    expect(multiOf(container)).toEqual([1, 2]);
  });

  it('Shift＋クリックでもトグルできる', () => {
    const { container } = setup();
    const blocks = jimakuBlocks(container);
    clickBlock(blocks[0] as HTMLElement);
    clickBlock(blocks[1] as HTMLElement, { shiftKey: true });
    expect(multiOf(container)).toEqual([1, 2]);
  });

  it('じまく行と飾りテロップ行をまたいで選べる（混在可）', () => {
    const { container } = setup();
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    clickBlock(manualBlocks(container)[0] as HTMLElement, { metaKey: true });
    expect(multiOf(container)).toEqual([1, 10]);
  });

  it('同じテロップをもう一度 Cmd＋クリックすると集合から外れる', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    clickBlock(jimakuBlocks(container)[1] as HTMLElement, { metaKey: true });
    // 残り 1 個＝単一選択へ戻る（サイズ 1 の複数選択は作らない）。
    expect(multiOf(container)).toEqual([]);
    expect(selectionOf(container)).toBe('1');
  });

  it('修飾キー＋ドラッグではトグルしない（ドラッグは区間移動として確定する）', () => {
    const { container } = setup();
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    dragBlock(jimakuBlocks(container)[1] as HTMLElement, 40, { metaKey: true });
    expect(multiOf(container)).toEqual([]);
  });

  it('通常クリックは単一選択へ戻す（集合クリア）', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    expect(multiOf(container)).toEqual([1, 2]);
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    expect(multiOf(container)).toEqual([]);
    expect(selectionOf(container)).toBe('1');
  });

  it('他種（効果音）のクリックで集合はクリアされる', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    const seClip = container.querySelector('.tl-se-clip');
    expect(seClip).not.toBeNull();
    clickBlock(seClip as HTMLElement);
    expect(selectionOf(container)).toBe('se');
    expect(multiOf(container)).toEqual([]);
  });

  it('選択のトグルは編集ではないので Undo 履歴を積まない', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    clickBlock(jimakuBlocks(container)[1] as HTMLElement, { metaKey: true });
    expect(container.querySelector('[data-testid="can-undo"]')?.textContent).toBe('false');
  });

  it('複数選択されたブロックはすべて選択枠でハイライトされる', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    expect(container.querySelectorAll('.tl-track-jimaku .tl-telop.selected')).toHaveLength(2);
  });
});

describe('範囲選択カットとの相互排他', () => {
  it('範囲選択を開始すると複数選択は解除される', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    const cutTrackBg = container.querySelector('.tl-track-cut');
    expect(cutTrackBg).not.toBeNull();
    fireEvent.pointerDown(cutTrackBg as HTMLElement, { clientX: 10, clientY: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 120, clientY: 0 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 0 });
    expect(multiOf(container)).toEqual([]);
  });
});

describe('Inspector の出し分け', () => {
  it('単一選択ではテロップ設定、複数選択では一括パネルが出る', () => {
    const { container } = setup();
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    expect(container.querySelector('#ins-multi-pos-x')).toBeNull();
    expect(container.querySelector('#ins-pos-x')).not.toBeNull();

    clickBlock(jimakuBlocks(container)[1] as HTMLElement, { metaKey: true });
    expect(container.querySelector('#ins-multi-pos-x')).not.toBeNull();
    expect(container.querySelector('#ins-pos-x')).toBeNull();
    expect(container.textContent).toContain('テロップ 2 個を選択中');
    expect(container.textContent).toContain('値を変えると選択中の全テロップに適用されます');
  });

  it('字幕が混ざっていると「対象外」の注記が出る', () => {
    const { container } = setup();
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    clickBlock(manualBlocks(container)[0] as HTMLElement, { metaKey: true });
    expect(container.textContent).toContain('字幕 1 件は対象外');
    expect(container.textContent).toContain('選択中の飾りテロップ 1 個を削除');
  });
});

describe('一括適用', () => {
  it('大きさの確定（Enter）が選択中の全員へ適用され、選択外へは波及しない', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    const scaleInput = container.querySelector('#ins-multi-scale') as HTMLInputElement;
    fireEvent.change(scaleInput, { target: { value: '1.8' } });
    fireEvent.keyDown(scaleInput, { key: 'Enter' });

    const telops = telopsOf(container);
    expect(telops.find((t) => t.id === 1)?.scale).toBe(1.8);
    expect(telops.find((t) => t.id === 2)?.scale).toBe(1.8);
    // 選択外は無変更。
    expect(telops.find((t) => t.id === 10)?.scale).toBeNull();
    expect(telops.find((t) => t.id === 11)?.scale).toBeNull();
  });

  it('入力中（未確定）の打鍵では適用されない', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    const scaleInput = container.querySelector('#ins-multi-scale') as HTMLInputElement;
    fireEvent.change(scaleInput, { target: { value: '1.8' } });
    expect(telopsOf(container).find((t) => t.id === 1)?.scale).toBeNull();
  });

  it('位置プリセットのクリックは即時に全員へ適用される', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    const preset = container.querySelectorAll('.pos-pad button')[0] as HTMLElement;
    fireEvent.click(preset);
    const telops = telopsOf(container);
    expect(telops.find((t) => t.id === 1)?.pos).toEqual(telops.find((t) => t.id === 2)?.pos);
    expect(telops.find((t) => t.id === 1)?.pos).not.toBeNull();
    expect(telops.find((t) => t.id === 10)?.pos).toBeNull();
  });
});

describe('Delete キーでの一括削除', () => {
  it('飾りテロップ 2 個を選んで Delete するとまとめて消える', () => {
    const { container } = setup();
    const manual = manualBlocks(container);
    clickBlock(manual[0] as HTMLElement);
    clickBlock(manual[1] as HTMLElement, { metaKey: true });
    expect(multiOf(container)).toEqual([10, 11]);

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(idsOf(container)).toEqual([1, 2]);
    expect(multiOf(container)).toEqual([]);
    expect(selectionOf(container)).toBe('none');
  });

  it('字幕が混ざっていても字幕は消えない（削除＝区間カットの契約を維持）', () => {
    const { container } = setup();
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    clickBlock(manualBlocks(container)[0] as HTMLElement, { metaKey: true });

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(idsOf(container)).toEqual([1, 2, 11]);
  });

  it('削除 → Undo で復活したとき選択と集合が矛盾しない', () => {
    const { container } = setup();
    const manual = manualBlocks(container);
    clickBlock(manual[0] as HTMLElement);
    clickBlock(manual[1] as HTMLElement, { metaKey: true });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(idsOf(container)).toEqual([1, 2]);

    act(() => {
      (container.querySelector('[data-testid="undo"]') as HTMLElement).click();
    });
    // スナップショット履歴なのでテロップと選択は必ず整合する（集合の ID は全部実在する）。
    expect(idsOf(container)).toEqual([1, 2, 10, 11]);
    const multi = multiOf(container);
    expect(multi).toEqual([10, 11]);
    expect(multi.every((id) => idsOf(container).includes(id))).toBe(true);
    expect(selectionOf(container)).toBe('11');
  });

  it('Escape で複数選択を解除できる', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(multiOf(container)).toEqual([]);
  });
});

describe('テロップ配列が変わる操作の後の整合', () => {
  it('分割（B キー）すると複数選択は解除される', () => {
    const { container } = setup();
    selectTwoSubtitles(container);
    act(() => {
      fakePlayer.emitFrame(200); // #1 の内側
    });
    fireEvent.keyDown(window, { key: 'b' });
    expect(idsOf(container)).toHaveLength(5);
    expect(multiOf(container)).toEqual([]);
  });
});
