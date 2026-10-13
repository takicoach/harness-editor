// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSlidesPreviews } from './useSlidesPreviews';
import type { SlidesSessionHook } from './useSlidesSession';

const session = { state: { sessionId: 's', pageHashes: { a: 'h1' } }, previewTick: 0, exportTick: 0 } as unknown as SlidesSessionHook;
afterEach(() => vi.unstubAllGlobals());

describe('useSlidesPreviews', () => {
  it('失敗を記録して表示し、撮り直しは retry を付けて頼み、撮れたら失敗を消す', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>; bodies.push(body);
      const page = body.retry ? { pageId: 'a', contentHash: 'h1', ready: true } : { pageId: 'a', contentHash: 'h1', ready: false, failed: true, error: '混雑' };
      return new Response(JSON.stringify({ pages: [page] }), { status: 200 });
    }));
    const { result } = renderHook(() => useSlidesPreviews('講義', session));
    await waitFor(() => expect(result.current.failure('a')).toBe('混雑'), { timeout: 3000 });
    expect(result.current.url('a')).toBeNull();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.url('a')).not.toBeNull(), { timeout: 3000 });
    expect(result.current.failure('a')).toBeNull();
    expect(bodies.map(body => body.retry)).toEqual([undefined, true]);
  });
});
