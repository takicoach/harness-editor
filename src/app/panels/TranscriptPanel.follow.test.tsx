/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { TranscriptPanel } from './TranscriptPanel';
import { initialEditState, type EditState } from '../edit/editState';
import type { EditorTelop, Transcript } from '../../core/types';
import { TRANSCRIPT_FOLLOW_STORAGE_KEY } from '../../core/transcriptFollow';

function makeTelop(id: number, start: number, end: number): EditorTelop {
  return { id, originalStart: start, originalEnd: end, text: `telop-${id}` };
}

function makeState(telops: EditorTelop[]): EditState {
  return {
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops,
    nextTelopId: telops.length + 1,
    selection: null,
  };
}

const transcript: Transcript = { durationMs: 0, words: [], segments: [] };
const noop = () => {};

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

/** @remotion/player の PlayerRef 最小スタブ。frameupdate/play/pause を手動発火できる。 */
class FakePlayer {
  private listeners = new Map<string, Set<(e: unknown) => void>>();
  currentFrame = 0;
  addEventListener(type: string, cb: (e: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }
  removeEventListener(type: string, cb: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(cb);
  }
  getCurrentFrame(): number {
    return this.currentFrame;
  }
  emit(type: string, detail?: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ detail });
  }
  play(): void {
    this.emit('play');
  }
  frame(f: number): void {
    this.currentFrame = f;
    this.emit('frameupdate', { frame: f });
  }
}

describe('TranscriptPanel — 再生ヘッド追従スクロール（C-1）', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
    Element.prototype.scrollIntoView = vi.fn();
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
      clear: () => {
        for (const k of Object.keys(store)) delete store[k];
      },
    });
  });

  it('再生中は再生ヘッド位置のテロップ行へ scrollIntoView される', () => {
    const telops = [makeTelop(1, 0, 100), makeTelop(2, 100, 200), makeTelop(3, 200, 300)];
    const state = makeState(telops);
    const player = new FakePlayer();
    const playerRef = { current: player } as never;

    const { container } = render(
      <TranscriptPanel
        state={state}
        transcript={transcript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={noop}
        onEdit={noop}
        onSelect={noop}
        onSeek={noop}
        highlightRange={null}
        onHighlightRange={noop}
        playerRef={playerRef}
        model={null}
      />,
    );

    const rows = container.querySelectorAll('.tx-row');
    const spies = Array.from(rows).map((row) => {
      const spy = vi.fn();
      (row as HTMLElement).scrollIntoView = spy;
      return spy;
    });

    player.play();
    player.frame(150); // originalStart=100 の telop id=2 の区間内

    expect(spies[0]).not.toHaveBeenCalled();
    expect(spies[1]).toHaveBeenCalledWith({ block: 'nearest' });
    expect(spies[2]).not.toHaveBeenCalled();
  });

  it('再生中でない（停止中）は frameupdate が来ても追従しない', () => {
    const telops = [makeTelop(1, 0, 100), makeTelop(2, 100, 200)];
    const state = makeState(telops);
    const player = new FakePlayer();
    const playerRef = { current: player } as never;

    const { container } = render(
      <TranscriptPanel
        state={state}
        transcript={transcript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={noop}
        onEdit={noop}
        onSelect={noop}
        onSeek={noop}
        highlightRange={null}
        onHighlightRange={noop}
        playerRef={playerRef}
        model={null}
      />,
    );

    const rows = container.querySelectorAll('.tx-row');
    const spies = Array.from(rows).map((row) => {
      const spy = vi.fn();
      (row as HTMLElement).scrollIntoView = spy;
      return spy;
    });

    // play() を呼ばず、再生中でないまま frameupdate だけ来るケース。
    player.frame(150);

    expect(spies[0]).not.toHaveBeenCalled();
    expect(spies[1]).not.toHaveBeenCalled();
  });

  it('トグル OFF のときは追従しない', () => {
    const telops = [makeTelop(1, 0, 100), makeTelop(2, 100, 200)];
    const state = makeState(telops);
    const player = new FakePlayer();
    const playerRef = { current: player } as never;

    const { container } = render(
      <TranscriptPanel
        state={state}
        transcript={transcript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={noop}
        onEdit={noop}
        onSelect={noop}
        onSeek={noop}
        highlightRange={null}
        onHighlightRange={noop}
        playerRef={playerRef}
        model={null}
      />,
    );

    // トグルを OFF にする。
    fireEvent.click(container.querySelector('.tl-snap-toggle')!);

    const rows = container.querySelectorAll('.tx-row');
    const spies = Array.from(rows).map((row) => {
      const spy = vi.fn();
      (row as HTMLElement).scrollIntoView = spy;
      return spy;
    });

    player.play();
    player.frame(150);

    expect(spies[0]).not.toHaveBeenCalled();
    expect(spies[1]).not.toHaveBeenCalled();
  });

  it('トグル状態は localStorage へ永続される', () => {
    const telops = [makeTelop(1, 0, 100)];
    const state = makeState(telops);
    const player = new FakePlayer();
    const playerRef = { current: player } as never;

    const { container } = render(
      <TranscriptPanel
        state={state}
        transcript={transcript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={noop}
        onEdit={noop}
        onSelect={noop}
        onSeek={noop}
        highlightRange={null}
        onHighlightRange={noop}
        playerRef={playerRef}
        model={null}
      />,
    );

    fireEvent.click(container.querySelector('.tl-snap-toggle')!);
    expect(localStorage.getItem(TRANSCRIPT_FOLLOW_STORAGE_KEY)).toBe('false');
  });

  it('リロード時（初回マウント）に現ヘッド位置の行へ初期スクロールする', () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;

    const telops = [makeTelop(1, 0, 100), makeTelop(2, 100, 200), makeTelop(3, 200, 300)];
    const state = makeState(telops);
    const player = new FakePlayer();
    player.currentFrame = 250; // telop id=3 の区間内
    const playerRef = { current: player } as never;

    const { container } = render(
      <TranscriptPanel
        state={state}
        transcript={transcript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={noop}
        onEdit={noop}
        onSelect={noop}
        onSeek={noop}
        highlightRange={null}
        onHighlightRange={noop}
        playerRef={playerRef}
        model={null}
      />,
    );

    const rows = container.querySelectorAll('.tx-row');
    // マウント直後の初期化 effect で、現ヘッド（frame=250 → telop id=3・インデックス2）の行が
    // scrollIntoView({ block: 'nearest' }) で呼ばれている。
    expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
    expect(spy.mock.instances).toContain(rows[2]);
  });

  it('I-1: プレビュー再読み込み（C-4・previewReloadKey 変化）後も新しい player インスタンスへ再購読され追従が効く', () => {
    const telops = [makeTelop(1, 0, 100), makeTelop(2, 100, 200), makeTelop(3, 200, 300)];
    const state = makeState(telops);
    const playerA = new FakePlayer();
    const playerRef = { current: playerA as unknown as never };

    const { container, rerender } = render(
      <TranscriptPanel
        state={state}
        transcript={transcript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={noop}
        onEdit={noop}
        onSelect={noop}
        onSeek={noop}
        highlightRange={null}
        onHighlightRange={noop}
        playerRef={playerRef}
        model={null}
        previewReloadKey={0}
      />,
    );

    // C-4 のプレビュー再読み込み: playerRef.current が新しい Player インスタンスへ差し替わり、
    // previewReloadKey がインクリメントされて再レンダーされる（Preview.tsx の実際の挙動を模す）。
    const playerB = new FakePlayer();
    playerRef.current = playerB as unknown as never;
    rerender(
      <TranscriptPanel
        state={state}
        transcript={transcript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={noop}
        onEdit={noop}
        onSelect={noop}
        onSeek={noop}
        highlightRange={null}
        onHighlightRange={noop}
        playerRef={playerRef}
        model={null}
        previewReloadKey={1}
      />,
    );

    const rows = container.querySelectorAll('.tx-row');
    const spies = Array.from(rows).map((row) => {
      const spy = vi.fn();
      (row as HTMLElement).scrollIntoView = spy;
      return spy;
    });

    // 旧 player（playerA）はもう誰も購読していないはず。
    playerA.play();
    playerA.frame(150);
    expect(spies[1]).not.toHaveBeenCalled();

    // 新 player（playerB）側の frameupdate に追従できること。
    playerB.play();
    playerB.frame(150); // telop id=2 の区間内
    expect(spies[1]).toHaveBeenCalledWith({ block: 'nearest' });
  });
});
