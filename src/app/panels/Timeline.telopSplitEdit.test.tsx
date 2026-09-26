/**
 * @vitest-environment jsdom
 *
 * 実機バグの UI イベントレベル再現テスト（2026-08-17・projects/04_golf-short-0811）。
 *
 * ユーザー操作列:
 *   手動テロップ #30 をタイムバー位置で「ヘッドで分割」（吸着オフ）
 *   → 左 #30 / 右 #32 ができる
 *   → 右 #32 をタイムラインでクリックして選択
 *   → インスペクタの「文字」へ打ち替える
 * 実機の症状: 右ではなく左 #30 の文字が変わる。右には「.」だけが残る。
 *
 * ディスク上の実データ（projects/04_golf-short-0811/src/テロップテンプレート/telopData.ts）:
 *   id:30 startFrame:875  endFrame:1452 text:"当たり前ですよね"
 *   id:32 startFrame:1452 endFrame:1655 text:"."
 * ＝ 元テキスト "当たり前ですよね." が「末尾1文字だけ右」へ割れている。
 * 本フィクスチャはこの数値をそのまま再現する（分割位置 1452・元テキスト9文字）。
 *
 * ここでは「純ロジックの単体テスト」ではなく、実 React の
 * pointerdown → pointerup → change のフラッシュ順序を通す。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject, EditorTelop } from '../../core/types';
import type { EditState } from '../edit/editState';
import { useEditSession } from '../useEditSession';
import { Timeline } from './Timeline';
import { SettingsTab } from './inspector/SettingsTab';

// スタイル選択グリッドは @remotion/player の Thumbnail で実描画するため jsdom では重い。
// 本テストの対象（選択とテキスト編集の結線）とは無関係なので描画だけ差し替える。
vi.mock('./TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const FPS = 30;
const DURATION_FRAMES = 3000;
/** 分割対象の手動テロップ（実データ #30 の分割前の姿）。 */
const MANUAL_ID = 30;
const MANUAL_START = 875;
const MANUAL_END = 1655;
const MANUAL_TEXT = '当たり前ですよね.';
/** ユーザーがヘッドを置いた位置（実データの #32 の startFrame）。 */
const SPLIT_FRAME = 1452;

/** frame → ms（transcript の時刻）。 */
function f2ms(frame: number): number {
  return Math.round((frame / FPS) * 1000);
}

function makeProject(): EditorProject {
  const telops: EditorTelop[] = [
    // 字幕（自動）1 件。手動テロップと別トラックに出るので、DOM 上の取り違えを防ぐ意味もある。
    { id: 1, originalStart: 100, originalEnd: 400, text: 'じまく', template: 1 },
    {
      id: MANUAL_ID,
      originalStart: MANUAL_START,
      originalEnd: MANUAL_END,
      text: MANUAL_TEXT,
      template: 5,
      manual: true,
    },
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
    transcript: {
      durationMs: (DURATION_FRAMES / FPS) * 1000,
      // 手動テロップ区間に重なる単語を置く。これが splitChipsFor の材料になる。
      words: [
        { text: 'ゴルフ', start: f2ms(875), end: f2ms(1000) },
        { text: 'スイングの', start: f2ms(1000), end: f2ms(1200) },
        { text: '基本は', start: f2ms(1200), end: f2ms(1452) },
        { text: 'とても', start: f2ms(1452), end: f2ms(1600) },
        { text: '大事', start: f2ms(1600), end: f2ms(1655) },
      ],
      segments: [],
    },
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

// ---------------------------------------------------------------------------
// テスト用ハーネス（App.tsx の結線を最小構成で再現する）
// ---------------------------------------------------------------------------

type Listener = (e: unknown) => void;

/** frameupdate を任意に発火できる最小プレイヤー。Timeline は購読と seekTo しか使わない。 */
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
  const selectedTelopId = state.selection?.kind === 'telop' ? state.selection.id : null;
  const selectedTelop = state.telops.find((t) => t.id === selectedTelopId);
  return (
    <div>
      <div data-testid="selection">{selectedTelopId === null ? 'none' : String(selectedTelopId)}</div>
      <div data-testid="telops">
        {JSON.stringify(
          state.telops.map((t) => ({ id: t.id, s: t.originalStart, e: t.originalEnd, text: t.text })),
        )}
      </div>
      <div data-testid="can-undo">{String(session.canUndo)}</div>
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
      {selectedTelop !== undefined && (
        <SettingsTab
          projectId="test"
          telop={selectedTelop}
          state={state}
          fps={FPS}
          telopPackInstalled={false}
          bgmInstalled={false}
          installing={null}
          installErrors={{}}
          dirty={session.dirty}
          componentRevision={null}
          previewWidth={1080}
          previewHeight={1920}
          onInstall={() => {}}
          onEdit={session.apply}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 操作ヘルパ（すべて実 DOM イベント）
// ---------------------------------------------------------------------------

interface TelopSnapshot {
  id: number;
  s: number;
  e: number;
  text: string;
}

function telopsOf(container: HTMLElement): TelopSnapshot[] {
  const el = container.querySelector('[data-testid="telops"]');
  return JSON.parse(el?.textContent ?? '[]') as TelopSnapshot[];
}

function selectionOf(container: HTMLElement): string {
  return container.querySelector('[data-testid="selection"]')?.textContent ?? '';
}

/** 手動テロップ行のブロック（配列順＝state.telops 内の手動テロップ順）。 */
function manualBlocks(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.tl-track-telop .tl-telop')) as HTMLElement[];
}

/** ブロック本体を「動かさずに」クリックする（pointerdown → 同座標で pointerup）。 */
function clickBlock(block: HTMLElement): void {
  fireEvent.pointerDown(block, { clientX: 0, clientY: 0, button: 0 });
  fireEvent.pointerUp(window, { clientX: 0, clientY: 0, button: 0 });
}

/** ヘッドを原本フレームへ動かす（プレイヤーの frameupdate 経由＝実経路）。 */
function seek(frame: number): void {
  act(() => {
    fakePlayer.emitFrame(frame);
  });
}

afterEach(() => {
  cleanup();
});

describe('手動テロップの分割 → 右断片を選んで打ち替え（実機バグ再現）', () => {
  it('分割は本文を「末尾1文字だけ右」へ割らない（手動テロップは transcript と無関係）', () => {
    fakePlayer = makeFakePlayer();
    const { container } = render(<Harness project={makeProject()} />);

    seek(SPLIT_FRAME);
    fireEvent.keyDown(window, { key: 'b' });

    const manual = telopsOf(container).filter((t) => t.id === MANUAL_ID || t.s === SPLIT_FRAME);
    expect(manual).toHaveLength(2);
    const [left, right] = manual as [TelopSnapshot, TelopSnapshot];
    expect(left.s).toBe(MANUAL_START);
    expect(left.e).toBe(SPLIT_FRAME);
    expect(right.s).toBe(SPLIT_FRAME);
    expect(right.e).toBe(MANUAL_END);
    // 手動テロップは transcript の単語と無関係なので、本文は両断片へ丸ごと複製する。
    expect(left.text).toBe(MANUAL_TEXT);
    expect(right.text).toBe(MANUAL_TEXT);
  });

  it('分割直後は右断片が選択される（次に編集するのは右という UX）', () => {
    fakePlayer = makeFakePlayer();
    const { container } = render(<Harness project={makeProject()} />);

    seek(SPLIT_FRAME);
    fireEvent.keyDown(window, { key: 'b' });

    const right = telopsOf(container).find((t) => t.s === SPLIT_FRAME);
    expect(right).toBeDefined();
    expect(selectionOf(container)).toBe(String(right?.id));
  });

  it('ブロックの純クリック（移動なし）は選択だけで、履歴も位置も変えない', () => {
    fakePlayer = makeFakePlayer();
    const { container } = render(<Harness project={makeProject()} />);

    const before = telopsOf(container);
    expect(container.querySelector('[data-testid="can-undo"]')?.textContent).toBe('false');

    const blocks = manualBlocks(container);
    expect(blocks).toHaveLength(1);
    clickBlock(blocks[0] as HTMLElement);

    expect(selectionOf(container)).toBe(String(MANUAL_ID));
    // 純クリックは編集ではない: Undo 履歴を積まない・区間も動かさない。
    expect(container.querySelector('[data-testid="can-undo"]')?.textContent).toBe('false');
    expect(telopsOf(container)).toEqual(before);
  });

  it('分割前に左を選んでいても、分割後の打ち替えは右へ入る（実機の取り違えの本体）', () => {
    fakePlayer = makeFakePlayer();
    const { container } = render(<Harness project={makeProject()} />);

    // 分割前: ユーザーは対象テロップ（後の左断片）を選んで本文を編集している。
    clickBlock(manualBlocks(container)[0] as HTMLElement);
    expect(selectionOf(container)).toBe(String(MANUAL_ID));

    // 分割。以前はここで選択が左（#30）のまま据え置かれ、
    // 続けて打った文字がすべて左へ入っていた。
    seek(SPLIT_FRAME);
    fireEvent.keyDown(window, { key: 'b' });

    const rightId = telopsOf(container).find((t) => t.s === SPLIT_FRAME)?.id;
    expect(selectionOf(container)).toBe(String(rightId));

    const textarea = container.querySelector('textarea.tx-text-edit');
    fireEvent.change(textarea as HTMLTextAreaElement, { target: { value: 'ここだけ書き換え' } });

    const after = telopsOf(container);
    expect(after.find((t) => t.id === rightId)?.text).toBe('ここだけ書き換え');
    expect(after.find((t) => t.id === MANUAL_ID)?.text).toBe(MANUAL_TEXT);
  });

  it('分割 → 右断片クリック → 打ち替え で、右だけが変わり左は不変', () => {
    fakePlayer = makeFakePlayer();
    const { container } = render(<Harness project={makeProject()} />);

    // 1) ヘッドを 1452 に置いて「ヘッドで分割」
    seek(SPLIT_FRAME);
    fireEvent.keyDown(window, { key: 'b' });

    const afterSplit = telopsOf(container);
    const leftId = afterSplit.find((t) => t.e === SPLIT_FRAME)?.id;
    const rightId = afterSplit.find((t) => t.s === SPLIT_FRAME)?.id;
    expect(leftId).toBe(MANUAL_ID);
    expect(rightId).toBeDefined();

    // 2) 右断片をタイムラインでクリックして選択する
    const blocks = manualBlocks(container);
    expect(blocks).toHaveLength(2);
    clickBlock(blocks[1] as HTMLElement);
    expect(selectionOf(container)).toBe(String(rightId));

    // 3) インスペクタの「文字」を打ち替える（実 change イベント）
    const textarea = container.querySelector('textarea.tx-text-edit');
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea as HTMLTextAreaElement, { target: { value: '当たり前ですよね？' } });

    const after = telopsOf(container);
    expect(after.find((t) => t.id === rightId)?.text).toBe('当たり前ですよね？');
    // 実機バグ: ここで左（#30）の本文が書き換わっていた。
    expect(after.find((t) => t.id === leftId)?.text).toBe(MANUAL_TEXT);
  });
});
