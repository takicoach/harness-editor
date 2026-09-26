/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { EditorPlaybackRef as PlayerRef } from '../preview/editorPlayback';
import type { EditorTelop, Transcript } from '../../core/types';
import { initialEditState, type EditState } from '../edit/editState';
import { TranscriptPanel } from './TranscriptPanel';

class FakeEventSource {
  static readonly CLOSED = 2;
  readyState = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close(): void {}
}

beforeAll(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  Element.prototype.scrollIntoView = vi.fn();
});

const transcript: Transcript = { durationMs: 10_000, words: [], segments: [] };
const pause = vi.fn();
const seekTo = vi.fn();
const telop: EditorTelop = {
  id: 1,
  originalStart: 100,
  originalEnd: 200,
  text: '中央で読む字幕',
  template: 1,
};

function Harness({
  initiallySelected = false,
  inputTranscript = transcript,
}: {
  initiallySelected?: boolean;
  inputTranscript?: Transcript;
}) {
  const [state, setState] = useState<EditState>(() => ({
    ...initialEditState({ mainSpeed: 1, segmentSpeeds: {} }),
    telops: [telop],
    nextTelopId: 2,
    selection: initiallySelected ? { kind: 'telop', id: telop.id } : null,
  }));
  const playerRef = useRef<PlayerRef | null>({
    pause,
    seekTo,
    addEventListener() {},
    removeEventListener() {},
    getCurrentFrame: () => 0,
  } as unknown as PlayerRef);
  return (
    <>
      <TranscriptPanel
        state={state}
        transcript={inputTranscript}
        fps={30}
        transcriptAligned={true}
        cutsBypassed={false}
        projectId="p1"
        onReloadRequested={() => {}}
        onEdit={setState}
        onSelect={setState}
        onSeek={seekTo}
        highlightRange={null}
        onHighlightRange={() => {}}
        playerRef={playerRef}
        model={null}
      />
    </>
  );
}

afterEach(() => {
  cleanup();
  pause.mockReset();
  seekTo.mockReset();
});

describe('TranscriptPanel — テロップ編集フォーカス', () => {
  it('行の通常クリックで再生を止め、字幕の中央へ移動する', () => {
    const { container } = render(<Harness />);
    fireEvent.click(container.querySelector('.tx-row') as HTMLElement);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(seekTo).toHaveBeenCalledWith(150);
  });

  it('選択後の文字入力クリックでは再びシークしない', () => {
    const { container } = render(<Harness initiallySelected />);
    fireEvent.click(container.querySelector('.tx-text-edit') as HTMLTextAreaElement);

    expect(pause).not.toHaveBeenCalled();
    expect(seekTo).not.toHaveBeenCalled();
  });

  it('単語チップのクリックはカット操作だけを行い、再びシークしない', () => {
    const withWord: Transcript = {
      durationMs: 10_000,
      words: [{ text: '中央', start: 3_500, end: 4_000 }],
      segments: [],
    };
    const { container } = render(<Harness initiallySelected inputTranscript={withWord} />);
    fireEvent.click(container.querySelector('.tx-chip') as HTMLElement);

    expect(pause).not.toHaveBeenCalled();
    expect(seekTo).not.toHaveBeenCalled();
  });
});
