/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { TranscriptPanel } from './TranscriptPanel';
import { initialEditState, type EditState } from '../edit/editState';
import type { EditorTelop, Transcript } from '../../core/types';

function makeTelop(id: number, start: number, end: number): EditorTelop {
  return { id, originalStart: start, originalEnd: end, text: `telop-${id}` };
}

function makeState(telops: EditorTelop[], selectedId: number | null): EditState {
  return {
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops,
    nextTelopId: telops.length + 1,
    selection: selectedId != null ? { kind: 'telop', id: selectedId } : null,
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

/** @remotion/player の PlayerRef 最小スタブ。追従スクロール機能の購読を無害化する。 */
function makeFakePlayerRef() {
  return { current: { addEventListener: () => {}, removeEventListener: () => {}, getCurrentFrame: () => 0 } } as never;
}

describe('TranscriptPanel — 選択連動スクロール（A-3）', () => {
  it('selectedTelopId が変わると、選択行が scrollIntoView({ block: "nearest" }) される', () => {
    // useDenoise / useNormalize が内部で張る EventSource 購読を jsdom スタブで無害化する。
    vi.stubGlobal('EventSource', FakeEventSource);
    // jsdom は scrollIntoView を実装しないため、初回マウント時の呼び出しでも
    // 落ちないようダミー実装を用意しておく（挙動の検証はテスト内で spy を張り替えて行う）。
    Element.prototype.scrollIntoView = vi.fn();
    const telops = [makeTelop(1, 0, 10), makeTelop(2, 10, 20), makeTelop(3, 20, 30)];
    const state = makeState(telops, 1);

    const { rerender, container } = render(
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
        playerRef={makeFakePlayerRef()}
        model={null}
      />,
    );

    const rows = container.querySelectorAll('.tx-row');
    const scrollSpies = Array.from(rows).map((row) => {
      const spy = vi.fn();
      (row as HTMLElement).scrollIntoView = spy;
      return spy;
    });

    const nextState = makeState(telops, 2);
    rerender(
      <TranscriptPanel
        state={nextState}
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
        playerRef={makeFakePlayerRef()}
        model={null}
      />,
    );

    // id=2 の行（rows のインデックス1）だけが scrollIntoView({ block: 'nearest' }) される。
    expect(scrollSpies[0]).not.toHaveBeenCalled();
    expect(scrollSpies[1]).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollSpies[2]).not.toHaveBeenCalled();
  });
});
