// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TelopStyleGrid } from './TelopStyleGrid';
import { loadNativeTelopComponent, type TelopComponent } from '../../preview/loadTelopComponent';
import { useCurrentFrame, useVideoConfig } from '../../captureRuntime';
import { TELOP_PACK } from '../../server/telopPack/manifest';

vi.mock('../../preview/loadTelopComponent', () => ({ loadNativeTelopComponent: vi.fn() }));
const observed = new Set<() => void>();
const resized = new Set<() => void>();
beforeEach(() => {
  props.componentRevision = { token: Symbol() };
  vi.stubGlobal('IntersectionObserver', class {
    notify: () => void;
    constructor(callback: IntersectionObserverCallback) { this.notify = () => callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    observe() { observed.add(this.notify); }
    disconnect() { observed.delete(this.notify); }
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(readonly notify: () => void) {}
    observe() { resized.add(this.notify); }
    disconnect() { resized.delete(this.notify); }
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 640, height: 360 } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); observed.clear(); resized.clear(); vi.mocked(loadNativeTelopComponent).mockReset(); });

const Native: TelopComponent = ({ segment }) => {
  const frame = useCurrentFrame(), config = useVideoConfig();
  const value = segment as { text: string; template: number };
  return <span data-testid="frame-probe">{value.text}:{value.template}:{frame}:{config.fps}:{config.durationInFrames}:{config.width}x{config.height}</span>;
};
const props = { projectId: 'A', componentRevision: { token: Symbol() }, previewWidth: 320, previewHeight: 180, fps: 24, sampleText: '見本', currentTemplate: 2, onSelect: vi.fn() };
function pending() {
  let resolve!: (component: TelopComponent) => void;
  const promise = new Promise<TelopComponent>(done => { resolve = done; });
  return { promise, resolve };
}
const visible = () => act(() => { for (const notify of [...observed]) notify(); });

it('renders every installed style lazily through the native context and keeps selection, frame and resize', async () => {
  vi.mocked(loadNativeTelopComponent).mockResolvedValue(Native);
  const onSelect = vi.fn();
  const { container } = render(<TelopStyleGrid {...props} onSelect={onSelect} />);
  await act(async () => {});
  expect(screen.queryAllByTestId('frame-probe')).toHaveLength(0);
  expect(screen.getAllByRole('button')).toHaveLength(TELOP_PACK.length);
  visible();
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
  expect(screen.getAllByTestId('frame-probe')[1]?.textContent).toContain('見本:2:30:24:60:320x180');
  expect(container.querySelector<HTMLElement>('[data-native-swatch="2"]')?.style.transform).toBe('scale(2)');
  fireEvent.click(screen.getByTitle(TELOP_PACK[2]!.name)); expect(onSelect).toHaveBeenCalledWith(TELOP_PACK[2]!.id);
  expect(screen.getByTitle(TELOP_PACK[1]!.name).classList.contains('active')).toBe(true);
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 320, height: 180 } as DOMRect);
  act(() => { for (const notify of resized) notify(); });
  expect(container.querySelector<HTMLElement>('[data-native-swatch="2"]')?.style.transform).toBe('scale(1)');
});

it('rejects late A and same-project old-revision responses while preserving the latest component', async () => {
  const a = pending(), b = pending(), fresh = pending();
  vi.mocked(loadNativeTelopComponent).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(fresh.promise);
  const { rerender } = render(<TelopStyleGrid {...props} />); visible();
  const signalA = vi.mocked(loadNativeTelopComponent).mock.calls[0]![1]!;
  rerender(<TelopStyleGrid {...props} projectId="B" />);
  await act(async () => {});
  expect(signalA.aborted).toBe(true);
  const Reloaded = { token: Symbol() };
  rerender(<TelopStyleGrid {...props} projectId="B" componentRevision={Reloaded} />);
  await act(async () => { fresh.resolve(Native); });
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
  const Stale: TelopComponent = () => <b>古い案件</b>;
  await act(async () => { a.resolve(Stale); b.resolve(Stale); });
  expect(screen.queryByText('古い案件')).toBeNull();
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
});

it('keeps names selectable on load failure and recovers on project component reload', async () => {
  vi.mocked(loadNativeTelopComponent).mockRejectedValueOnce(new Error('fixture load failure')).mockResolvedValueOnce(Native);
  const onSelect = vi.fn(), { rerender } = render(<TelopStyleGrid {...props} onSelect={onSelect} />); visible();
  await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('名前から選択できます');
  fireEvent.click(screen.getByTitle(TELOP_PACK[0]!.name)); expect(onSelect).toHaveBeenCalledWith(1);
  const Reloaded = { token: Symbol() };
  rerender(<TelopStyleGrid {...props} componentRevision={Reloaded} />);
  await act(async () => {});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
});

it('debounces sample changes by 250 ms without delaying selection', async () => {
  vi.useFakeTimers(); vi.mocked(loadNativeTelopComponent).mockResolvedValue(Native);
  const { rerender } = render(<TelopStyleGrid {...props} />); await act(async () => {}); visible();
  rerender(<TelopStyleGrid {...props} sampleText="変更" currentTemplate={3} />);
  expect(screen.getByTitle(TELOP_PACK[2]!.name).classList.contains('active')).toBe(true);
  act(() => vi.advanceTimersByTime(249)); expect(screen.getAllByTestId('frame-probe')[0]?.textContent).toContain('見本:');
  act(() => vi.advanceTimersByTime(1)); expect(screen.getAllByTestId('frame-probe')[0]?.textContent).toContain('変更:');
});

it('reuses the loaded revision immediately across unmounts instead of compiling another module', async () => {
  vi.mocked(loadNativeTelopComponent).mockResolvedValue(Native);
  const first = render(<TelopStyleGrid {...props} />); await act(async () => {}); visible();
  first.unmount();
  render(<TelopStyleGrid {...props} />); visible();
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
  await act(async () => {});
  expect(loadNativeTelopComponent).toHaveBeenCalledTimes(1);
});

it('does not show a completed old snapshot while the same project loads its new revision', async () => {
  const fresh = pending();
  vi.mocked(loadNativeTelopComponent).mockResolvedValueOnce(Native).mockReturnValueOnce(fresh.promise);
  const { rerender } = render(<TelopStyleGrid {...props} />); await act(async () => {}); visible();
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
  rerender(<TelopStyleGrid {...props} componentRevision={{ token: Symbol() }} />);
  expect(screen.queryAllByTestId('frame-probe')).toHaveLength(0);
  const Updated: TelopComponent = ({ segment }) => <span data-testid="updated-style">{(segment as { template: number }).template}</span>;
  await act(async () => { fresh.resolve(Updated); });
  expect(screen.getAllByTestId('updated-style')).toHaveLength(TELOP_PACK.length);
  expect(loadNativeTelopComponent).toHaveBeenCalledTimes(2);
});

it('evicts a failed load so reopening the same revision can recover', async () => {
  vi.mocked(loadNativeTelopComponent).mockRejectedValueOnce(new Error('broken TSX')).mockResolvedValueOnce(Native);
  const first = render(<TelopStyleGrid {...props} />); await act(async () => {});
  expect(screen.getByRole('alert').textContent).toContain('broken TSX');
  first.unmount();
  render(<TelopStyleGrid {...props} />); visible(); await act(async () => {});
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
  expect(loadNativeTelopComponent).toHaveBeenCalledTimes(2);
});

it('shares a StrictMode request and only cancels pending work after its last consumer leaves', async () => {
  const work = pending(); vi.mocked(loadNativeTelopComponent).mockReturnValue(work.promise);
  const first = render(<StrictMode><TelopStyleGrid {...props} /></StrictMode>);
  const second = render(<TelopStyleGrid {...props} />);
  await act(async () => {});
  expect(loadNativeTelopComponent).toHaveBeenCalledTimes(1);
  const signal = vi.mocked(loadNativeTelopComponent).mock.calls[0]![1]!;
  first.unmount(); await act(async () => {}); expect(signal.aborted).toBe(false);
  second.unmount(); await act(async () => {}); expect(signal.aborted).toBe(true);
  await act(async () => { work.resolve(Native); });
  expect(screen.queryAllByTestId('frame-probe')).toHaveLength(0);
});

it('resets a failed cell when switching directly to an already cached component', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const cachedSource = { token: Symbol() }, brokenSource = { token: Symbol() };
  const Broken: TelopComponent = () => { throw new Error('broken project style'); };
  vi.mocked(loadNativeTelopComponent).mockResolvedValueOnce(Native).mockResolvedValueOnce(Broken);
  const first = render(<TelopStyleGrid {...props} componentRevision={cachedSource} />); await act(async () => {}); visible(); first.unmount();
  const current = render(<TelopStyleGrid {...props} componentRevision={brokenSource} />); await act(async () => {}); visible();
  expect(screen.queryAllByTestId('frame-probe')).toHaveLength(0);
  current.rerender(<TelopStyleGrid {...props} componentRevision={cachedSource} />);
  expect(screen.getAllByTestId('frame-probe')).toHaveLength(TELOP_PACK.length);
  expect(loadNativeTelopComponent).toHaveBeenCalledTimes(2);
});
