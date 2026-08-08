/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useLiveNow } from './useLiveNow';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Probe({ onRender, intervalMs }: { onRender: (now: number) => void; intervalMs?: number }) {
  const now = useLiveNow(intervalMs);
  onRender(now);
  return null;
}

describe('useLiveNow', () => {
  it('マウント時に現在時刻を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T12:00:00Z'));
    const renders: number[] = [];
    render(<Probe onRender={(n) => renders.push(n)} />);
    expect(renders[0]).toBe(Date.parse('2026-07-09T12:00:00Z'));
  });

  it('interval ごとに再レンダーして最新時刻を返す', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T12:00:00Z'));
    const renders: number[] = [];
    render(<Probe intervalMs={30_000} onRender={(n) => renders.push(n)} />);
    expect(renders).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(renders).toHaveLength(2);
    expect(renders[1]).toBe(Date.parse('2026-07-09T12:00:30Z'));
  });

  it('unmount 時に interval をクリアする（unmount 後は再レンダーされない）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-09T12:00:00Z'));
    const renders: number[] = [];
    const { unmount } = render(<Probe intervalMs={30_000} onRender={(n) => renders.push(n)} />);
    expect(renders).toHaveLength(1);
    unmount();
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(renders).toHaveLength(1);
  });
});
