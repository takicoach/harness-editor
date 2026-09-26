/**
 * @vitest-environment jsdom
 *
 * 端ドラッグ自動スクロール（edge-autoscroll）の UI レベル結線テスト。
 *
 * 速度そのもの（ゾーン・比例・クランプ）は純関数 `edgeScrollVelocity` のユニット
 * （timelineScroll.test.ts）が担う。ここは **偽 rAF で回した結果 `.tl-body` の
 * scrollLeft が実際に動き、同時にドラッグ値も追従するか**（＝画面だけ滑って値が
 * 止まる状態を作っていないか）と、pointerup での後始末だけを見る。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorProject, EditorTelop } from '../../core/types';
import type { EditState } from '../edit/editState';
import { useEditSession } from '../useEditSession';
import { Timeline } from '../panels/Timeline';

vi.mock('../panels/TelopStyleGrid', () => ({ TelopStyleGrid: () => null }));

const FPS = 30;
const DURATION_FRAMES = 6000;

/** 可視域（`.tl-body`）の見た目。左端 0・右端 1000・コンテンツ 5000（最大スクロール 4000）。 */
const VIEW_LEFT = 0;
const VIEW_RIGHT = 1000;
const CLIENT_WIDTH = 1000;
const SCROLL_WIDTH = 5000;
const MAX_SCROLL = SCROLL_WIDTH - CLIENT_WIDTH;

/** 右端ゾーンの内側（端から 10px）。深さ 30 → 速度 15px/フレーム。 */
const RIGHT_EDGE_X = 990;
/** 左端ゾーンの内側（端から 10px）。深さ 30 → 速度 -15px/フレーム。 */
const LEFT_EDGE_X = 10;
const SPEED_PER_FRAME = 15;

function makeProject(): EditorProject {
  const telops: EditorTelop[] = [
    { id: 1, originalStart: 500, originalEnd: 800, text: 'じまくA', template: 1 },
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

function makeFakePlayer(): PlayerRef & { emit: (type: string, detail?: unknown) => void } {
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
    emit(type: string, detail?: unknown) {
      for (const fn of listeners.get(type) ?? []) fn({ detail });
    },
  };
  return player as unknown as PlayerRef & { emit: (type: string, detail?: unknown) => void };
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
        {JSON.stringify(state.telops.map((t) => ({ id: t.id, start: t.originalStart, end: t.originalEnd })))}
      </div>
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

interface TelopRow { id: number; start: number; end: number }

function telopsOf(c: HTMLElement): TelopRow[] {
  return JSON.parse(c.querySelector('[data-testid="telops"]')?.textContent ?? '[]') as TelopRow[];
}

/** 吸着を切る（端スクロール量そのものを見たいテストで、吸着に値を丸められないため）。 */
function disableSnap(container: HTMLElement): void {
  fireEvent.click(container.querySelector('.tl-snap-toggle') as HTMLElement);
}

function renderTimeline(project: EditorProject = makeProject()) {
  fakePlayer = makeFakePlayer();
  return render(<Harness project={project} />);
}

// ---------------------------------------------------------------------------
// 偽 rAF（手動でフレームを進める）
// ---------------------------------------------------------------------------

let pending: Map<number, FrameRequestCallback>;
let nextRafId: number;
let rafClock: number;

function installFakeRaf(): void {
  pending = new Map();
  nextRafId = 0;
  rafClock = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    nextRafId += 1;
    pending.set(nextRafId, cb);
    return nextRafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    pending.delete(id);
  });
}

/** 実ブラウザの 60Hz 相当のフレーム間隔（ms）。dt 正規化の倍率がちょうど 1 になる。 */
const FRAME_MS = 1000 / 60;

/** キューに溜まった rAF コールバックを n フレームぶん実行する（timestamp は 60Hz 相当）。 */
function runFrames(n: number): void {
  for (let i = 0; i < n; i++) {
    const batch = [...pending.values()];
    pending.clear();
    const ts = (rafClock += FRAME_MS);
    act(() => {
      for (const cb of batch) cb(ts);
    });
  }
}

// ---------------------------------------------------------------------------
// DOM 計測のスタブ（jsdom はレイアウトを持たない）
// ---------------------------------------------------------------------------

/**
 * `.tl-body` を「幅 1000・コンテンツ 5000」の可視域に見せ、`.tl-scroll` の左端を
 * スクロール量に応じて左へずらす（＝実ブラウザと同じく、スクロールすると
 * 同じ画面 X がより後ろのフレームを指す）。これが無いと「画面だけ滑って
 * ドラッグ値が止まる」実装でもテストが緑になってしまう。
 */
function stubLayout(container: HTMLElement): HTMLElement {
  const body = container.querySelector('.tl-body') as HTMLElement;
  const scroll = container.querySelector('.tl-scroll') as HTMLElement;
  Object.defineProperty(body, 'clientWidth', { configurable: true, value: CLIENT_WIDTH });
  Object.defineProperty(body, 'scrollWidth', { configurable: true, value: SCROLL_WIDTH });
  body.getBoundingClientRect = () =>
    ({ left: VIEW_LEFT, right: VIEW_RIGHT, top: 0, bottom: 300, width: CLIENT_WIDTH, height: 300, x: VIEW_LEFT, y: 0, toJSON: () => ({}) }) as DOMRect;
  scroll.getBoundingClientRect = () =>
    ({ left: -body.scrollLeft, right: SCROLL_WIDTH - body.scrollLeft, top: 0, bottom: 300, width: SCROLL_WIDTH, height: 300, x: -body.scrollLeft, y: 0, toJSON: () => ({}) }) as DOMRect;
  return body;
}

function jimakuBlock(container: HTMLElement): HTMLElement {
  return container.querySelector('.tl-track-jimaku .tl-telop') as HTMLElement;
}

/** ドラッグ中のブロック左端（px）。ドラッグ値が進んだかの観測点。 */
function blockLeft(container: HTMLElement): number {
  return parseFloat(jimakuBlock(container).style.left);
}

beforeEach(() => {
  installFakeRaf();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('端ドラッグ自動スクロール（edge-autoscroll）', () => {
  it('右端でブロックをドラッグすると scrollLeft が増え、ドラッグ値も追従する', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const block = jimakuBlock(container);

    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    const leftBefore = blockLeft(container);

    runFrames(3);

    // 深さ 30px → 15px/フレーム。3 フレームで +45。
    expect(body.scrollLeft).toBeCloseTo(SPEED_PER_FRAME * 3, 6);
    // スクロールぶんだけドラッグ値（＝ブロック位置）も前進している。
    expect(blockLeft(container)).toBeGreaterThan(leftBefore);
  });

  it('左端では scrollLeft が減る（負の速度）', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    body.scrollLeft = 500;
    const block = jimakuBlock(container);

    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: LEFT_EDGE_X, clientY: 10 });
    runFrames(3);

    expect(body.scrollLeft).toBeCloseTo(500 - SPEED_PER_FRAME * 3, 6);
  });

  it('ゾーン外（画面中央）では動かない', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const block = jimakuBlock(container);

    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(2);
    const scrolled = body.scrollLeft;
    expect(scrolled).toBeGreaterThan(0);

    // 中央へ戻したら止まる。
    fireEvent.pointerMove(window, { clientX: 500, clientY: 10 });
    runFrames(5);
    expect(body.scrollLeft).toBe(scrolled);
  });

  it('末尾ではクランプして止まる（scrollWidth - clientWidth を超えない）', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    body.scrollLeft = MAX_SCROLL - 10;
    const block = jimakuBlock(container);

    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(5);

    expect(body.scrollLeft).toBe(MAX_SCROLL);
  });

  it('pointerup で rAF ループが止まり、以後スクロールしない', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const block = jimakuBlock(container);

    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(2);
    const scrolled = body.scrollLeft;

    fireEvent.pointerUp(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(5);

    expect(body.scrollLeft).toBe(scrolled);
    // 後始末: 予約済み rAF が残っていない。
    expect(pending.size).toBe(0);
  });

  it('スクラブ（ルーラードラッグ）では発動しない', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const ruler = container.querySelector('.tl-ruler') as HTMLElement;

    fireEvent.pointerDown(ruler, { clientX: 600, clientY: 5, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 5 });
    runFrames(5);

    expect(body.scrollLeft).toBe(0);
  });
});

describe('確定の取りこぼし防止（クリック/ドラッグ判定はコンテンツ空間の px）', () => {
  it('端ゾーンで掴み 6px 超動かせば、端スクロールが始まりコンテンツぶんも確定に乗る', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    disableSnap(container);
    const block = jimakuBlock(container);
    const before = telopsOf(container)[0]?.start;
    expect(before).toBe(500);

    // 右端に半分見えているブロックを掴んで送る操作。しきい値（5px）を超えて
    // 動かした時点でドラッグ確定になり、そこから端スクロールが始まる。
    fireEvent.pointerDown(block, { clientX: 970, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: 978, clientY: 10 });
    runFrames(5);
    expect(body.scrollLeft).toBeGreaterThan(0);
    fireEvent.pointerUp(window, { clientX: 978, clientY: 10 });

    // 実移動 8px ぶん＋端スクロールで進んだぶんが確定する。
    expect(telopsOf(container)[0]?.start).toBeGreaterThan(508);
  });

  it('端ゾーンでの純クリック（実移動 2px）は区間を動かさず、端スクロールも始まらない', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    disableSnap(container);
    const block = jimakuBlock(container);

    // 端ゾーン内でブロックをクリックしただけ。ここで端スクロールが走ると、
    // 「選択しただけなのにブロックが動いて確定する」（2026-08-17 に潰した副作用の復活）。
    fireEvent.pointerDown(block, { clientX: 970, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: 972, clientY: 10 });
    runFrames(10);
    fireEvent.pointerUp(window, { clientX: 972, clientY: 10 });

    expect(body.scrollLeft).toBe(0);
    expect(telopsOf(container)[0]?.start).toBe(500);
  });

  it('スクロールが起きない普通の微振動は従来どおり純クリック扱い（恒等性の回帰）', () => {
    const { container } = renderTimeline();
    stubLayout(container);
    disableSnap(container);
    const block = jimakuBlock(container);

    // 画面中央（端ゾーン外）＝スクロールしない。実移動 2px は従来どおりクリック。
    fireEvent.pointerDown(block, { clientX: 500, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: 502, clientY: 10 });
    runFrames(3);
    fireEvent.pointerUp(window, { clientX: 502, clientY: 10 });

    expect(telopsOf(container)[0]?.start).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// ホバー版（待機中）とドラッグ版（確定後）の共存
// ---------------------------------------------------------------------------

/**
 * ホバー版の 1 フレームぶんの期待スクロール量（px）。実装を呼ばず仕様値から再計算する。
 * 可視域 1000・ガター 88 → inner 912 → 発動域 z = clamp(912 * 4%, 28, 64) = 36.48。
 * X=990 は右端から 10px → 食い込み比 (36.48 - 10) / 36.48 を 2 乗して maxSpeed 1600px/秒。
 */
const HOVER_ZONE = Math.max(28, Math.min(64, (CLIENT_WIDTH - 88) * 0.04));
const HOVER_RATIO = (HOVER_ZONE - (VIEW_RIGHT - RIGHT_EDGE_X)) / HOVER_ZONE;
const HOVER_PX_PER_FRAME = (1600 * HOVER_RATIO * HOVER_RATIO) / 60;

describe('端ホバー自動スクロール（待機中）とドラッグ版の共存ガード', () => {
  it('非ドラッグでポインタを右端へ置くと scrollLeft が増える（ホバー版が担当）', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    // どこも掴んでいない。カーソルを右端へ寄せただけ。
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);

    // 初回フレームは dt=0（前回時刻が無い）ので、進むのは 2 フレームぶん。
    expect(body.scrollLeft).toBeCloseTo(HOVER_PX_PER_FRAME * 2, 6);
  });

  it('ドラッグ確定前（pointerdown 直後の純クリック相当）はホバー版も休止する', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const block = jimakuBlock(container);

    // 端ゾーンでブロックを掴んだだけ（実移動 2px＝まだクリックかもしれない）。
    // ここでホバー版が scrollLeft を動かすと「選択しただけで区間が動く」が復活する。
    fireEvent.pointerDown(block, { clientX: 970, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: 972, clientY: 10 });
    runFrames(5);

    expect(body.scrollLeft).toBe(0);
  });

  it('ドラッグ中はホバー版が上乗せせず、ドラッグ版の速度のままになる', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const block = jimakuBlock(container);

    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);

    // ドラッグ版だけ＝15px/フレーム × 3。両方走ると 1 フレーム 29px 前後まで膨らむ。
    expect(body.scrollLeft).toBeCloseTo(SPEED_PER_FRAME * 3, 6);
  });

  it('pointerup 後は再びホバー版が効く（休止は永続しない）', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const block = jimakuBlock(container);

    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);
    fireEvent.pointerUp(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    const afterDrag = body.scrollLeft;

    // 離した後にカーソルを動かせば、待機中の担当＝ホバー版が引き継ぐ。
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);

    expect(body.scrollLeft).toBeCloseTo(afterDrag + HOVER_PX_PER_FRAME * 2, 6);
  });

  it('ボタンを押した瞬間にホバー版は止まる（ドラッグ状態が伝わる前のフレームを塞ぐ）', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);
    const scrolled = body.scrollLeft;
    expect(scrolled).toBeGreaterThan(0);

    // ドラッグ状態が React の再レンダで ref に届くまでの 1 フレームでも、
    // 掴んだ後にコンテンツが動くとクリック/ドラッグ判定の実移動がずれる（H-120）。
    fireEvent.pointerDown(body, { clientX: RIGHT_EDGE_X, clientY: 10, button: 0 });
    runFrames(3);

    expect(body.scrollLeft).toBe(scrolled);
  });

  it('stopPropagation する本物のターゲット（字幕ブロック）への pointerdown でも止まる', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);
    const scrolled = body.scrollLeft;
    expect(scrolled).toBeGreaterThan(0);

    // React 18 はルート要素へ委譲するので、beginDrag の stopPropagation は
    // **window の bubble リスナまで殺す**。body 相手のテストだけでは穴が見えない。
    fireEvent.pointerDown(jimakuBlock(container), { clientX: RIGHT_EDGE_X, clientY: 10, button: 0 });
    runFrames(3);

    expect(body.scrollLeft).toBe(scrolled);
  });

  it('カット FAB（stopPropagation するがドラッグを始めない）を押してもホバー版が止まる', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    // 範囲選択を作って FAB を出す（ドラッグして離す）。
    const track = container.querySelector('.tl-track-cut') as HTMLElement;
    fireEvent.pointerDown(track, { clientX: 300, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 500, clientY: 10 });
    const fab = container.querySelector('.tl-cut-fab-btn') as HTMLElement;
    expect(fab).not.toBeNull();

    body.scrollLeft = 0;
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);
    const scrolled = body.scrollLeft;
    expect(scrolled).toBeGreaterThan(0);

    // FAB は stopPropagation するがドラッグを始めない＝ドラッグ状態 ref も立たない。
    // ここでホバー版が走り続けると FAB がカーソルの下から逃げ、カットが黙って落ちる。
    fireEvent.pointerDown(fab, { clientX: RIGHT_EDGE_X, clientY: 10, button: 0 });
    runFrames(5);

    expect(body.scrollLeft).toBe(scrolled);
  });

  it('ポインタがウィンドウの外へ出たら止まる（pointerout・relatedTarget null）', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    // 外へ出ると pointermove は届かなくなるので、最後の速度のまま走り続けてしまう。
    // `pointerleave` は非バブルで window では実質発火しない（d0a4f89 の穴）。
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);
    const scrolled = body.scrollLeft;
    expect(scrolled).toBeGreaterThan(0);

    fireEvent.pointerOut(window, { clientX: RIGHT_EDGE_X, clientY: 10, relatedTarget: null });
    runFrames(5);

    expect(body.scrollLeft).toBe(scrolled);
  });

  it('要素間の移動（relatedTarget あり）では止まらない', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(3);
    const scrolled = body.scrollLeft;

    // 端でスクロールしていれば、カーソル下の要素は次々に入れ替わって pointerout が飛ぶ。
    // これで止めてしまうと 1 要素ぶんで打ち切られる。
    fireEvent.pointerOut(window, { clientX: RIGHT_EDGE_X, clientY: 10, relatedTarget: body });
    runFrames(3);

    expect(body.scrollLeft).toBeGreaterThan(scrolled);
  });

  it('カーソルを止めたままでもホバー版は走り続ける（鮮度で打ち切らない）', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    // ホバー版は「端にカーソルを置いて待つ」操作。可視域内でカーソルが静止している間、
    // ブラウザは pointermove を出さない（実測: Chromium で 200ms の鮮度ガードを入れると
    // 244px で打ち切られ、外すと 300px 超まで伸びた）。move 途絶で止めてはいけない。
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(60);

    expect(body.scrollLeft).toBeCloseTo(HOVER_PX_PER_FRAME * 59, 6);
  });

  it('ボタンを押したままの pointermove ではホバー版は走らない', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);

    // タイムライン外で始まったドラッグ（素材のドラッグ等）が端を通過しただけ。
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10, buttons: 1 });
    runFrames(3);

    expect(body.scrollLeft).toBe(0);
  });

  it('スクラブ（ルーラードラッグ）中もホバー版は休止する', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    const ruler = container.querySelector('.tl-ruler') as HTMLElement;

    // スクラブは端スクロールの対象外（再生ヘッド追従と競合する）。ホバー版が
    // 代わりに走ると、その「対象外」が窓口を変えて破られる。
    fireEvent.pointerDown(ruler, { clientX: 600, clientY: 5, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 5 });
    runFrames(5);

    expect(body.scrollLeft).toBe(0);
  });
});

describe('再生中は端スクロールを見送る（scrollLeft の競合排除）', () => {
  it('再生中はポインタが端ゾーンにあってもスクロールしない', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    act(() => {
      fakePlayer.emit('play');
    });

    const block = jimakuBlock(container);
    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(5);

    // 再生追従（followScrollLeft）が同じ scrollLeft を毎フレーム書くため、
    // 端スクロールが同時に走ると両者が奪い合って画面が痙攣する。
    expect(body.scrollLeft).toBe(0);
  });

  it('一時停止すれば端スクロールは再開する', () => {
    const { container } = renderTimeline();
    const body = stubLayout(container);
    act(() => {
      fakePlayer.emit('play');
    });
    const block = jimakuBlock(container);
    fireEvent.pointerDown(block, { clientX: 600, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { clientX: RIGHT_EDGE_X, clientY: 10 });
    runFrames(2);
    expect(body.scrollLeft).toBe(0);

    act(() => {
      fakePlayer.emit('pause');
    });
    runFrames(3);
    expect(body.scrollLeft).toBeCloseTo(SPEED_PER_FRAME * 3, 6);
  });
});
