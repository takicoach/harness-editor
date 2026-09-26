/**
 * @vitest-environment jsdom
 *
 * タイムラインのキー操作の回帰テスト（監査 interaction-2 / -6 / -11 / -12）。
 *
 * - interaction-2: つまみ選択中の ←/→ に修飾キー・IME・プルダウンのガードが無く、
 *   Cmd+←（ブラウザの「戻る」）が 1 フレーム編集として履歴に積まれていた。
 * - interaction-6: Delete によるテロップ削除が「2 件以上選択中」でしか効かなかった。
 * - interaction-11: 入力欄での Esc がカット選択帯まで消していた。
 * - interaction-12: 再生/一時停止が K だけで Space に割り当てが無かった。
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

interface FakePlayer {
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  setPlaying: (v: boolean) => void;
  emit: (type: string) => void;
}

function makeFakePlayer(): PlayerRef & FakePlayer {
  const listeners = new Map<string, Set<Listener>>();
  let playing = false;
  const player = {
    addEventListener(type: string, fn: Listener) {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: Listener) {
      listeners.get(type)?.delete(fn);
    },
    seekTo: vi.fn(),
    getCurrentFrame: () => 0,
    play: vi.fn(() => {
      playing = true;
    }),
    pause: vi.fn(() => {
      playing = false;
    }),
    isPlaying: () => playing,
    emit(type: string) { for (const listener of listeners.get(type) ?? []) listener({detail:undefined}); },
    setPlaying: (v: boolean) => {
      playing = v;
    },
  };
  return player as unknown as PlayerRef & FakePlayer;
}

let fakePlayer: ReturnType<typeof makeFakePlayer>;

function Harness({ project, onNotice }: { project: EditorProject; onNotice?: (m: string) => void }) {
  const session = useEditSession('p1', project, null);
  const playerRef = useRef<PlayerRef | null>(fakePlayer);
  const [playbackRate, setPlaybackRate] = useState(1);
  if (session === null) return null;
  return (
    <div>
      <div data-testid="ids">{JSON.stringify(session.state.telops.map((t) => t.id))}</div>
      <div data-testid="se-ids">{JSON.stringify(session.state.se.map((s) => s.id))}</div>
      <div data-testid="starts">
        {JSON.stringify(session.state.telops.map((t) => t.originalStart))}
      </div>
      <div data-testid="can-undo">{String(session.canUndo)}</div>
      <div data-testid="can-redo">{String(session.canRedo)}</div>
      <button type="button" data-testid="undo" onClick={session.undo}>
        undo
      </button>
      <textarea data-testid="text-input" defaultValue="" />
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
        onNotice={onNotice}
      />
    </div>
  );
}

function setup(onNotice?: (m: string) => void) {
  fakePlayer = makeFakePlayer();
  return render(<Harness project={makeProject()} onNotice={onNotice} />);
}

function jsonOf(c: HTMLElement, id: string): number[] {
  return JSON.parse(c.querySelector(`[data-testid="${id}"]`)?.textContent ?? '[]');
}
function manualBlocks(c: HTMLElement): HTMLElement[] {
  return Array.from(c.querySelectorAll('.tl-track-telop .tl-telop'));
}
function jimakuBlocks(c: HTMLElement): HTMLElement[] {
  return Array.from(c.querySelectorAll('.tl-track-jimaku .tl-telop'));
}
function clickBlock(block: HTMLElement, mods: { metaKey?: boolean } = {}): void {
  fireEvent.pointerDown(block, { clientX: 0, clientY: 0, button: 0, ...mods });
  fireEvent.pointerUp(window, { clientX: 0, clientY: 0, button: 0, ...mods });
}
/** カット行をドラッグして範囲選択帯を作る。 */
function dragCutSelection(c: HTMLElement): void {
  const track = c.querySelector('.tl-track-cut');
  fireEvent.pointerDown(track as HTMLElement, { clientX: 10, clientY: 0, button: 0 });
  fireEvent.pointerMove(window, { clientX: 200, clientY: 0 });
  fireEvent.pointerUp(window, { clientX: 200, clientY: 0 });
}

afterEach(() => cleanup());

describe('つまみの ←/→ 微調整に修飾キー・IME・入力欄のガードを効かせる（interaction-2）', () => {
  /** 飾りテロップの開始つまみを選択した状態を作る。 */
  function selectStartHandle(c: HTMLElement): void {
    const handle = manualBlocks(c)[0]?.querySelector('.tl-handle.start');
    expect(handle).not.toBeNull();
    fireEvent.pointerDown(handle as HTMLElement, { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 0, button: 0 });
  }

  it('Cmd+← は編集にならない（ブラウザの「戻る」を編集として積まない）', () => {
    const { container } = setup();
    selectStartHandle(container);
    const before = jsonOf(container, 'starts');
    fireEvent.keyDown(window, { key: 'ArrowLeft', metaKey: true });
    expect(jsonOf(container, 'starts')).toEqual(before);
    expect(container.querySelector('[data-testid="can-undo"]')?.textContent).toBe('false');
  });

  it('IME 変換中の ← も編集にならない', () => {
    const { container } = setup();
    selectStartHandle(container);
    const before = jsonOf(container, 'starts');
    fireEvent.keyDown(window, { key: 'ArrowLeft', isComposing: true });
    expect(jsonOf(container, 'starts')).toEqual(before);
  });

  it('修飾キー無しの ← は従来どおり 1 フレーム動く', () => {
    const { container } = setup();
    selectStartHandle(container);
    const before = jsonOf(container, 'starts');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(jsonOf(container, 'starts')).not.toEqual(before);
  });
});

describe('Delete は選択 1 件にも効く（interaction-6）', () => {
  it('飾りテロップを 1 個選んで Delete で消える', () => {
    const { container } = setup();
    clickBlock(manualBlocks(container)[0] as HTMLElement);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(jsonOf(container, 'ids')).toEqual([1, 11]);
  });

  it('効果音を 1 個選んで Delete で消える', () => {
    const { container } = setup();
    const seClip = container.querySelector('.tl-se-clip');
    expect(seClip).not.toBeNull();
    clickBlock(seClip as HTMLElement);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(jsonOf(container, 'se-ids')).toEqual([]);
  });

  it('字幕は Delete で消えない（削除＝区間カットという既存契約を変えない）', () => {
    const { container } = setup();
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(jsonOf(container, 'ids')).toEqual([1, 10, 11]);
    // 何も消えない Delete は編集ではない ＝ 履歴を 1 手も動かさない。
    expect(container.querySelector('[data-testid="can-undo"]')?.textContent).toBe('false');
  });

  it('字幕の Delete は Redo 分岐を捨てない（空の 1 手を積まない）', () => {
    const { container } = setup();
    // 1 手編集して Undo し、Redo できる状態を作る。
    clickBlock(manualBlocks(container)[0] as HTMLElement);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(jsonOf(container, 'ids')).toEqual([1, 11]);
    fireEvent.click(container.querySelector('[data-testid="undo"]') as HTMLElement);
    expect(container.querySelector('[data-testid="can-redo"]')?.textContent).toBe('true');
    // 字幕を選んで Delete しても Redo は残る。
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(container.querySelector('[data-testid="can-redo"]')?.textContent).toBe('true');
    expect(jsonOf(container, 'ids')).toEqual([1, 10, 11]);
  });

  it('押しっぱなしの自動リピート（repeat）で届いた Delete は扱わない', () => {
    // 実ブラウザでは 1 打目は repeat=false、押しっぱなしの 2 回目以降だけ repeat=true。
    // 2 回目以降は「消し終わった対象」へ届いて空の 1 手を積む側なので、まとめて無視する。
    const { container } = setup();
    clickBlock(manualBlocks(container)[0] as HTMLElement);
    for (let i = 0; i < 5; i += 1) {
      fireEvent.keyDown(window, { key: 'Delete', repeat: true });
    }
    expect(jsonOf(container, 'ids')).toEqual([1, 10, 11]);
    expect(container.querySelector('[data-testid="can-undo"]')?.textContent).toBe('false');
  });

  it('複数選択があればそちらが優先（従来どおり一括削除）', () => {
    const { container } = setup();
    clickBlock(manualBlocks(container)[0] as HTMLElement);
    clickBlock(manualBlocks(container)[1] as HTMLElement, { metaKey: true });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(jsonOf(container, 'ids')).toEqual([1]);
  });

  it('カット範囲選択中はカット確定が優先で、選択中のテロップは消えない', () => {
    const { container } = setup();
    clickBlock(manualBlocks(container)[0] as HTMLElement);
    dragCutSelection(container);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(jsonOf(container, 'ids')).toEqual([1, 10, 11]);
  });
});

describe('Escape の扱いを揃える（interaction-11）', () => {
  it('入力欄にフォーカスがある Esc はカット選択帯を消さない', () => {
    const { container } = setup();
    dragCutSelection(container);
    expect(container.querySelector('.tl-cut-selection')).not.toBeNull();

    const input = container.querySelector('[data-testid="text-input"]') as HTMLTextAreaElement;
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(container.querySelector('.tl-cut-selection')).not.toBeNull();
  });

  it('入力欄の外の Esc はカット選択帯を消す', () => {
    const { container } = setup();
    dragCutSelection(container);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.tl-cut-selection')).toBeNull();
  });
});

describe('Space で再生/停止（interaction-12）', () => {
  it('keeps a requested JKL rate when native preparation synchronously emits pause',()=>{
    const {container}=setup();fakePlayer.setPlaying(true);
    fakePlayer.setPlaybackRate=vi.fn(()=>{fakePlayer.setPlaying(false);fakePlayer.emit('pause');});
    fireEvent.keyDown(window,{key:'l'});
    expect(container.querySelector('.tl-rate-badge')?.textContent).toContain('2');
    expect(fakePlayer.setPlaybackRate).toHaveBeenLastCalledWith(2);
  });
  it('accumulates JKL steps while native audio is preparing',()=>{
    const {container}=setup();let pending=false;
    Object.assign(fakePlayer,{isPlaybackPending:()=>pending});
    fakePlayer.play.mockImplementation(()=>{pending=true;});
    fakePlayer.setPlaybackRate=vi.fn();
    fireEvent.keyDown(window,{key:'l'});fireEvent.keyDown(window,{key:'l'});fireEvent.keyDown(window,{key:'l'});
    expect(container.querySelector('.tl-rate-badge')?.textContent).toContain('4');
    expect(fakePlayer.setPlaybackRate).toHaveBeenLastCalledWith(4);
  });
  it('cancels pending audio preparation with Space',()=>{
    setup();Object.assign(fakePlayer,{isPlaybackPending:()=>true});
    fireEvent.keyDown(window,{key:' '});
    expect(fakePlayer.pause).toHaveBeenCalledTimes(1);expect(fakePlayer.play).not.toHaveBeenCalled();
  });
  it('pauses even when setting the native rate synchronously publishes a pause',()=>{
    setup();fakePlayer.setPlaying(true);
    fakePlayer.setPlaybackRate=vi.fn(()=>fakePlayer.setPlaying(false));
    fireEvent.keyDown(window,{key:' '});
    expect(fakePlayer.setPlaybackRate).toHaveBeenCalledWith(1);
    expect(fakePlayer.pause).toHaveBeenCalledTimes(1);
    expect(fakePlayer.play).not.toHaveBeenCalled();
  });
  it('停止中の Space で再生、再生中の Space で停止', () => {
    setup();
    fireEvent.keyDown(window, { key: ' ' });
    expect(fakePlayer.play).toHaveBeenCalledTimes(1);

    fakePlayer.setPlaying(true);
    fireEvent.keyDown(window, { key: ' ' });
    expect(fakePlayer.pause).toHaveBeenCalledTimes(1);
  });

  it('ボタンにフォーカスがある Space は既定動作に譲る（二重発火しない）', () => {
    const { container } = setup();
    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    fireEvent.keyDown(button as HTMLElement, { key: ' ' });
    expect(fakePlayer.play).not.toHaveBeenCalled();
  });

  it('タイムラインのヒントに Space が載っている', () => {
    const { container } = setup();
    expect(container.querySelector('.tl-transport-hint')?.textContent).toContain('Space');
  });
});


/**
 * Delete が効かない種類での説明（サイクル 1 レビューの残件）。
 * 消えないうえに理由も出ないと「壊れている」ように見える。
 */
describe('Delete が効かないときに理由を知らせる', () => {
  it('字幕を選んで Delete すると、代わりの操作先を 1 行で知らせる', () => {
    const onNotice = vi.fn();
    const { container } = setup(onNotice);
    clickBlock(jimakuBlocks(container)[0] as HTMLElement);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0]![0]).toContain('文字起こし');
    // 知らせるだけで、字幕は消さない（既存契約は変えない）。
    expect(jsonOf(container, 'ids')).toEqual([1, 10, 11]);
  });

  it('飾りテロップの Delete では知らせを出さない（普通に消えるので邪魔しない）', () => {
    const onNotice = vi.fn();
    const { container } = setup(onNotice);
    clickBlock(manualBlocks(container)[0] as HTMLElement);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(onNotice).not.toHaveBeenCalled();
    expect(jsonOf(container, 'ids')).toEqual([1, 11]);
  });
});
