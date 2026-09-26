/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useBannerSlotHeight } from './useBannerSlotHeight';

let observerCount = 0;
let offsetReads = 0;

class FakeResizeObserver {
  constructor(_cb: ResizeObserverCallback) {
    observerCount += 1;
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  observerCount = 0;
  offsetReads = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      offsetReads += 1;
      return 40;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
});

function Probe({ tick }: { tick: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useBannerSlotHeight(ref);
  return <div ref={ref} data-tick={tick} />;
}

describe('useBannerSlotHeight（サイクル 3 Important）', () => {
  it('初回に 1 回だけ測って CSS 変数へ流す', () => {
    render(<Probe tick={0} />);
    expect(document.documentElement.style.getPropertyValue('--banner-slot-h')).toBe('40px');
    expect(observerCount).toBe(1);
    expect(offsetReads).toBe(1);
  });

  it('再レンダーしても強制レイアウトもオブザーバ再生成も起きない', () => {
    const { rerender } = render(<Probe tick={0} />);
    for (let i = 1; i <= 5; i += 1) rerender(<Probe tick={i} />);
    // ドラッグ中は毎 pointermove で App が再描画される。ここが増えると追従が重くなる。
    expect(offsetReads).toBe(1);
    expect(observerCount).toBe(1);
  });
});
