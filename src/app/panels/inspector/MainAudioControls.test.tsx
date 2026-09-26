/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MainAudioControls } from './MainAudioControls';
import { initialEditState } from '../../edit/editState';
import { createHistory, current, pushState, redo, undo } from '../../edit/history';

afterEach(cleanup);

function Harness() {
  const [history, setHistory] = useState(() => createHistory(initialEditState({ mainSpeed: 1, segmentSpeeds: {} })));
  return <>
    <MainAudioControls state={current(history)} fps={30} supported
      onEdit={next => setHistory(previous => pushState(previous, next))} />
    <button onClick={() => setHistory(undo)}>Undo</button>
    <button onClick={() => setHistory(redo)}>Redo</button>
  </>;
}

describe('main audio numeric editing history', () => {
  it.each(['Enter', 'blur'])('commits %s once so a single Undo restores the previous gain', method => {
    render(<Harness />);
    const input = screen.getByRole('spinbutton', { name: '音量' }) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '-6.5' } });
    if (method === 'Enter') fireEvent.keyDown(input, { key: 'Enter' });
    else fireEvent.blur(input);
    expect(input.value).toBe('-6.5');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(input.value).toBe('0.0');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(input.value).toBe('-6.5');
  });
});
