/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useUnsavedGuard } from './useUnsavedGuard';

afterEach(() => {
  cleanup();
});

function Probe({ dirty }: { dirty: boolean }) {
  useUnsavedGuard(dirty);
  return null;
}

function dispatchBeforeUnload(): BeforeUnloadEvent {
  const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
  window.dispatchEvent(event);
  return event;
}

describe('useUnsavedGuard', () => {
  it('dirty のとき beforeunload で preventDefault し returnValue をセットする', () => {
    render(<Probe dirty={true} />);
    const event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(true);
  });

  it('dirty でない（保存済み）とき beforeunload を止めない', () => {
    render(<Probe dirty={false} />);
    const event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
  });

  it('dirty → false へ変化したら以後は警告を出さない（リスナー更新）', () => {
    const { rerender } = render(<Probe dirty={true} />);
    rerender(<Probe dirty={false} />);
    const event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
  });

  it('unmount 後はリスナーが残らない', () => {
    const { unmount } = render(<Probe dirty={true} />);
    unmount();
    const event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(false);
  });
});
