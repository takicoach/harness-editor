import { describe, expect, it, vi } from 'vitest';
import { SharedPreparations } from './sharedPreparation';

describe('shared media preparation cancellation', () => {
  it('cancels one caller without killing work needed by a second caller', async () => {
    const registry = new SharedPreparations<number>(), cancelled = new AbortController();
    let release!: (result: number) => void, workSignal!: AbortSignal;
    const start = vi.fn((signal: AbortSignal) => { workSignal = signal; return new Promise<number>(resolve => { release = resolve; }); });
    const a = registry.get('asset', start, cancelled.signal), b = registry.get('asset', start);
    const rejected = expect(a).rejects.toThrow('caller stopped');
    await Promise.resolve(); cancelled.abort(new Error('caller stopped'));
    await rejected; expect(workSignal.aborted).toBe(false); expect(start).toHaveBeenCalledTimes(1);
    release(42); expect(await b).toBe(42);
  });
  it('kills work once every caller cancels and a new caller starts fresh', async () => {
    const registry = new SharedPreparations<number>(), a = new AbortController(), b = new AbortController();
    let workSignal!: AbortSignal;
    const start = (signal: AbortSignal) => { workSignal = signal; return new Promise<number>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('work cancelled')), { once: true });
    }); };
    const first = registry.get('asset', start, a.signal), second = registry.get('asset', start, b.signal);
    const handled = Promise.allSettled([first, second]);
    await Promise.resolve(); a.abort(); expect(workSignal.aborted).toBe(false);
    b.abort(); expect(workSignal.aborted).toBe(true);
    const replacement = registry.get('asset', async () => 7);
    await handled; expect(await replacement).toBe(7);
  });
  it('does not start an already-cancelled request and clears a failed preparation', async () => {
    const registry = new SharedPreparations<number>(), signal = AbortSignal.abort(new Error('already cancelled')), start = vi.fn(async () => 1);
    expect(() => registry.get('asset', start, signal)).toThrow('already cancelled'); expect(start).not.toHaveBeenCalled();
    await expect(registry.get('asset', async () => { throw new Error('decoder failed'); })).rejects.toThrow('decoder failed');
    expect(await registry.get('asset', start)).toBe(1);
  });
});
