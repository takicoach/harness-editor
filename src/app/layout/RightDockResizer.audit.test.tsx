// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RightDockResizer } from './RightDockResizer';

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

describe('RightDockResizer persistence boundary', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('persists the final pointer position even when move and release occur before a React render', () => {
    render(<div className="stage"><RightDockResizer /></div>);
    const separator = screen.getByRole('separator', { name: '右パネルの幅' });
    fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 500 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientX: 450 });
    fireEvent.pointerUp(separator, { pointerId: 7, clientX: 450 });
    expect(localStorage.getItem('sme-right-panel-width')).toBe('390');
  });
});
