/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { EditorPlaybackRef as PlayerRef } from './editorPlayback';
import { PlayheadInput } from './PlayheadInput';

afterEach(cleanup);
function setup(durationInFrames = 2700) {
  let listener: ((event: { detail: { frame: number } }) => void) | undefined;
  const player = { getCurrentFrame: () => 899, pause: vi.fn(), seekTo: vi.fn(),
    addEventListener: vi.fn((_name, fn) => { listener = fn; }), removeEventListener: vi.fn() };
  const ui = render(<PlayheadInput playerRef={{current: player as unknown as PlayerRef}} fps={30} durationInFrames={durationInFrames} sourceMode={false} />);
  const input = ui.getByRole('textbox') as HTMLInputElement;
  return { ...ui, player, input, update: (frame: number) => act(() => listener?.({detail:{frame}})) };
}
describe('PlayheadInput', () => {
  it('stops playback and seeks exactly once on Enter without rounding the target', () => {
    const { input, player } = setup();
    act(() => input.focus());
    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('00:00:29:29');
    fireEvent.change(input, {target:{value:'30'}});
    expect(player.seekTo).not.toHaveBeenCalled();
    fireEvent.keyDown(input, {key:'Enter'});
    expect(player.seekTo).toHaveBeenCalledExactlyOnceWith(900);
    expect(input.value).toBe('00:00:30:00');
  });
  it('preserves input while frames update and Escape restores the current frame', () => {
    const { input, player, update } = setup();
    act(() => input.focus());fireEvent.change(input, {target:{value:'60'}});update(901);
    expect(input.value).toBe('60');
    fireEvent.keyDown(input, {key:'Escape'});
    expect(player.seekTo).not.toHaveBeenCalled();expect(input.value).toBe('00:00:30:01');
  });
  it('rejects out-of-range and invalid input; valid blur seeks the last frame', () => {
    const { input, player, getByRole } = setup();
    act(() => input.focus());fireEvent.change(input, {target:{value:'90'}});act(() => input.blur());
    expect(player.seekTo).not.toHaveBeenCalled();expect(getByRole('alert').textContent).toContain('00:01:29:29');
    act(() => input.focus());fireEvent.change(input, {target:{value:'x'}});act(() => input.blur());
    expect(player.seekTo).not.toHaveBeenCalled();
    act(() => input.focus());fireEvent.change(input, {target:{value:'2699f'}});act(() => input.blur());
    expect(player.seekTo).toHaveBeenCalledExactlyOnceWith(2699);
  });
  it('shows the actual duration and removes its player listener on unmount', () => {
    const { getByLabelText, player, unmount } = setup(1798);
    expect(getByLabelText('完成尺（時:分:秒:コマ）').textContent).toContain('00:00:59:28');
    unmount();expect(player.removeEventListener).toHaveBeenCalledWith('frameupdate',expect.any(Function));
  });
});
