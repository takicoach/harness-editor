// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CutSequenceTrack } from './CutSequenceTrack';

vi.mock('./useFilmstrip', async (load) => ({
  ...await load<typeof import('./useFilmstrip')>(),
  useFilmstripFrames: () => [],
}));
vi.mock('../audio/useWaveformSamples', () => ({ useWaveformSamples: () => ({ samples: null, failed: false }) }));

const baseProps = {
  segments: [
    { id: 1, originalStart: 100, originalEnd: 160, playbackStart: 0, playbackEnd: 60 },
    { id: 2, originalStart: 300, originalEnd: 360, playbackStart: 60, playbackEnd: 120 },
  ],
  overlaps: [],
  finalDurationFrames: 120,
  playerFrame: 20,
  pxPerFrame: 1,
  totalFrames: 500,
  fps: 30,
  videoUrl: '',
  selectedSegmentId: null,
};

describe('CutSequenceTrack interactions', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  it('moves a clip with both the visible button and Alt+Arrow keyboard fallback', () => {
    const onMove = vi.fn();
    render(<CutSequenceTrack {...baseProps} onSelect={() => {}} onSeekOriginal={() => {}} onSeekFinal={() => {}} onMove={onMove} />);
    fireEvent.click(screen.getByRole('button', { name: '完成順1を後ろへ' }));
    fireEvent.keyDown(screen.getByRole('button', { name: /完成順 1。/ }), { key: 'ArrowRight', altKey: true });
    expect(onMove).toHaveBeenNthCalledWith(1, 1, 1);
    expect(onMove).toHaveBeenNthCalledWith(2, 1, 1);
  });

  it('selects and seeks the source midpoint for keyboard activation', () => {
    const onSelect = vi.fn();
    const onSeekOriginal = vi.fn();
    render(<CutSequenceTrack {...baseProps} onSelect={onSelect} onSeekOriginal={onSeekOriginal} onSeekFinal={() => {}} onMove={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /完成順 2。/ }), { detail: 0 });
    expect(onSelect).toHaveBeenCalledWith(2);
    expect(onSeekOriginal).toHaveBeenCalledWith(329);
  });

  it('mouse selection preserves playhead position; the audio lane selects the same linked clip', () => {
    const onSelect = vi.fn(), onSeekOriginal = vi.fn();
    render(<CutSequenceTrack {...baseProps} onSelect={onSelect} onSeekOriginal={onSeekOriginal} onSeekFinal={() => {}} onMove={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /完成順 2。/ }), { detail: 1 });
    fireEvent.click(screen.getByRole('button', { name: '元音声 1を選択' }), { detail: 1 });
    expect(onSelect.mock.calls).toEqual([[2], [1]]);
    expect(onSeekOriginal).not.toHaveBeenCalled();
  });

  it.each(['video', 'audio'])('razor splits the clicked %s clip in source coordinates, independently of the playhead', (lane) => {
    const onSplit = vi.fn(), onSeekOriginal = vi.fn(), onSelect = vi.fn();
    render(<CutSequenceTrack {...baseProps} razor onSplit={onSplit} onSelect={onSelect} onSeekOriginal={onSeekOriginal} onSeekFinal={() => {}} onMove={() => {}} />);
    const target = screen.getByRole('button', { name: lane === 'video' ? /完成順 2。/ : '元音声 2を選択' });
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 400, width: 120 } as DOMRect);
    fireEvent.mouseMove(target, { clientX: 430 });
    expect(screen.getByTestId('timeline-razor-guide').getAttribute('data-source-frame')).toBe('315');
    fireEvent.click(target, { clientX: 430, detail: 1 });
    expect(onSplit).toHaveBeenCalledExactlyOnceWith(315);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onSeekOriginal).not.toHaveBeenCalled();
    expect(screen.queryByTestId('timeline-razor-guide')).toBeNull();
    expect(screen.getByTestId('cut-sequence-clip-2').getAttribute('draggable')).toBe('false');
  });

  it('keyboard activation in razor mode never cuts at an invented pointer position', () => {
    const onSplit = vi.fn(), onSelect = vi.fn();
    render(<CutSequenceTrack {...baseProps} razor onSplit={onSplit} onSelect={onSelect} onSeekOriginal={() => {}} onSeekFinal={() => {}} onMove={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /完成順 2。/ }), { detail: 0 });
    expect(onSplit).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(2);
  });
});
